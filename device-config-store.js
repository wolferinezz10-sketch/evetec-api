const fs = require("node:fs");

function configError(message, status = 503) {
  return Object.assign(new Error(message), { status });
}

function writeJsonAtomic(file, value) {
  const temporary = `${file}.tmp`;
  try {
    fs.writeFileSync(temporary, JSON.stringify(value, null, 2), { mode: 0o600 });
    fs.renameSync(temporary, file);
  } catch (error) {
    try { fs.unlinkSync(temporary); } catch (_) {}
    throw error;
  }
}

class DeviceConfigStore {
  constructor({ pool, persistentRequired = false, saveLocal }) {
    this.pool = pool;
    this.persistentRequired = persistentRequired;
    this.saveLocal = saveLocal;
    this.queues = new Map();
  }

  async initialize() {
    await this.pool.query(`CREATE TABLE IF NOT EXISTS evetec_device_config (
      device_id TEXT PRIMARY KEY,
      revision BIGINT NOT NULL DEFAULT 0,
      payload JSONB NOT NULL,
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )`);
  }

  async load() {
    const result = await this.pool.query("SELECT device_id, revision, payload FROM evetec_device_config");
    return result.rows;
  }

  async save(deviceId, payload, revision) {
    if (!this.pool) {
      if (this.persistentRequired) throw configError("La base de datos no está disponible. No se guardaron los cambios.");
      await this.saveLocal(payload, revision + 1);
      return revision + 1;
    }
    // El control de revisión protege también frente a dos instancias durante un despliegue.
    const result = await this.pool.query(
      `INSERT INTO evetec_device_config (device_id, revision, payload, updated_at)
       VALUES ($1, 1, $2::jsonb, NOW())
       ON CONFLICT (device_id) DO UPDATE SET
         revision = evetec_device_config.revision + 1,
         payload = EXCLUDED.payload, updated_at = NOW()
       WHERE evetec_device_config.revision = $3
       RETURNING revision`,
      [deviceId, JSON.stringify(payload), revision]
    );
    if (!result.rows.length) throw configError("La configuración cambió desde otra sesión. Volvé a cargarla antes de guardar.", 409);
    return Number(result.rows[0].revision);
  }

  enqueue(deviceId, operation) {
    const previous = this.queues.get(deviceId) || Promise.resolve();
    const current = previous.catch(() => {}).then(operation);
    this.queues.set(deviceId, current);
    current.finally(() => {
      if (this.queues.get(deviceId) === current) this.queues.delete(deviceId);
    }).catch(() => {});
    return current;
  }
}

module.exports = { DeviceConfigStore, writeJsonAtomic, configError };
