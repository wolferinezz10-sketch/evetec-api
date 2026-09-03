const express = require("express");
const cors = require("cors");
const QRCode = require("qrcode");
const fs = require("fs");
const crypto = require("crypto");
const { Pool } = require("pg");

const app = express();

app.use(cors());
app.use(express.json({ limit: "2mb" }));
app.use(express.urlencoded({ extended: true }));

const PORT = Number(process.env.PORT || 3000);
const PUBLIC_BASE_URL = process.env.PUBLIC_BASE_URL || "https://evetec-api.onrender.com";

const MP_CLIENT_ID = process.env.MP_CLIENT_ID || "";
const MP_CLIENT_SECRET = process.env.MP_CLIENT_SECRET || "";
const EVETEC_MP_TOKEN = process.env.MERCADO_PAGO_ACCESS_TOKEN || process.env.MP_ACCESS_TOKEN || "";
const COMISION_EVETEC_PORCENTAJE = Number(process.env.COMISION_EVETEC || 15);
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || "";
const CLIENT_SESSION_SECRET = process.env.CLIENT_SESSION_SECRET || ADMIN_PASSWORD;
const DEVICE_API_KEY = process.env.DEVICE_API_KEY || "";
const PROTOTYPE_DEVICE_ID = "ASPIRADORA_BASIC_001";
const PLUSH_DEVICE_ID = "PELUCHE_001";
const MAX_PARTICIPANTS = 8;
const PARTICIPANT_NUMBERS = Array.from({ length: MAX_PARTICIPANTS }, (_, index) => index + 1);

const DATA_FILE = process.env.DATA_FILE || "evetec-timers-data.json";
const DATABASE_URL = process.env.DATABASE_URL || "";
let databasePool = null;
let databaseReady = false;
let databaseSaveTimer = null;
const REDIRECT_URI = `${PUBLIC_BASE_URL}/oauth/callback`;
const oauthStates = new Map();

function invalidarOauthParticipante(deviceId, participantId) {
  const normalizedDeviceId = String(deviceId || "").trim().toUpperCase();
  const normalizedParticipantId = String(participantId || "").trim().toLowerCase();
  let invalidated = 0;
  for (const [stateToken, stateData] of oauthStates) {
    if (
      String(stateData?.deviceId || "").trim().toUpperCase() === normalizedDeviceId &&
      String(stateData?.participantId || "").trim().toLowerCase() === normalizedParticipantId
    ) {
      oauthStates.delete(stateToken);
      invalidated++;
    }
  }
  return invalidated;
}

function comparacionSegura(a, b) {
  const aa = Buffer.from(String(a || ""));
  const bb = Buffer.from(String(b || ""));
  return aa.length === bb.length && crypto.timingSafeEqual(aa, bb);
}

function requireAdmin(req, res, next) {
  if (!ADMIN_PASSWORD) {
    return res.status(503).send("Panel administrativo deshabilitado: falta ADMIN_PASSWORD.");
  }

  if (leerSesionAdmin(req)) return next();

  const auth = String(req.headers.authorization || "");
  if (auth.startsWith("Basic ")) {
    try {
      const decoded = Buffer.from(auth.slice(6), "base64").toString("utf8");
      const split = decoded.indexOf(":");
      const password = split >= 0 ? decoded.slice(split + 1) : "";
      if (comparacionSegura(password, ADMIN_PASSWORD)) return next();
    } catch (_) {}
  }

  res.set("WWW-Authenticate", 'Basic realm="EVETEC Admin", charset="UTF-8"');
  return res.status(401).send("Autenticacion requerida.");
}

function requireDevice(req, res, next) {
  if (!DEVICE_API_KEY) return next(); // Compatibilidad del prototipo; configurar en produccion.
  if (comparacionSegura(req.get("x-device-key"), DEVICE_API_KEY)) return next();
  return res.status(401).json({ ok: false, error: "device_unauthorized" });
}

app.use("/admin", requireAdmin);

function statsIniciales() {
  return {
    totalRecaudado: 0,
    pagosAprobados: 0,
    segundosVendidos: 0,
    tiempoMotor: 0,
    comisionesMp: 0,
    netoDespuesMp: 0,
    creditosVendidos: 0,
    motorMsVendidos: 0,
    ultimosPagos: []
  };
}

let configGlobal = {
  activo: true,
  mensajeGlobalActivo: true,
  mensajeGlobal: "Sistema listo para usar",
  moneda: "ARS",

  premium: {
    planes: [
      { id: "P1", nombre: "1m 30s", segundos: 90, monto: 100, montoBase: 100, descripcion: "Limpieza rápida" },
      { id: "P2", nombre: "3m", segundos: 180, monto: 250, montoBase: 250, descripcion: "Auto chico / retoque" },
      { id: "P3", nombre: "5m", segundos: 300, monto: 400, montoBase: 400, descripcion: "Limpieza completa" }
    ],
    preciosExtra: [
      { id: "E1", nombre: "+30s", segundos: 30, monto: 50, montoBase: 50, descripcion: "Tiempo extra corto" },
      { id: "E2", nombre: "+1m", segundos: 60, monto: 90, montoBase: 90, descripcion: "Tiempo extra" },
      { id: "E3", nombre: "+2m", segundos: 120, monto: 160, montoBase: 160, descripcion: "Tiempo extra extendido" }
    ],
    promoGlobal: {
      activa: false,
      id: "PROMO",
      nombre: "PROMO GLOBAL",
      segundos: 240,
      monto: 300,
      montoBase: 300,
      descripcion: "Promo especial"
    }
  },

  basic: {
    activo: true,
    nombre: "Inflado de neumaticos",
    segundos: 240,
    preinicioHabilitado: true,
    preinicioSegundos: 15,
    monto: 1,
    montoBase: 1,
    descripcion: "Inflador de autos por 4 minutos"
  },

  gachapon: {
    activo: true,
    nombre: "Gachapon",
    titulo: "GACHAPON",
    mensaje: "Tu sorpresa te espera",
    instruccion: "Toca una opcion",
    modo_activacion: "tiempo",
    segundos_por_jugada: 30,
    pulso_motor_ms: 10000,
    pausa_premios_ms: 650,
    planes: [
      { id: "G1", creditos: 1, nombre: "1 CREDITO", etiqueta: "Elegir y pagar", monto: 1000, montoBase: 1000, giro_ms: 10000, descripcion: "Un premio" },
      { id: "G2", creditos: 2, nombre: "2 CREDITOS", etiqueta: "Promo 5% OFF", monto: 1800, montoBase: 1800, giro_ms: 20000, descripcion: "Dos premios" },
      { id: "G3", creditos: 3, nombre: "3 CREDITOS", etiqueta: "Mejor valor", monto: 2500, montoBase: 2500, giro_ms: 30000, descripcion: "Tres premios" }
    ]
  },

  arcade: {
    activo: true,
    nombre: "Galaga QR",
    titulo: "GALAGA QR",
    mensaje: "Inserta creditos con Mercado Pago",
    creditosPorPartida: 1,
    planes: [
      { id: "A1", creditos: 1, nombre: "1 CREDITO", etiqueta: "1 partida", monto: 500, montoBase: 500, descripcion: "Una partida" },
      { id: "A3", creditos: 3, nombre: "3 CREDITOS", etiqueta: "Pack arcade", monto: 1200, montoBase: 1200, descripcion: "Tres partidas" },
      { id: "A5", creditos: 5, nombre: "5 CREDITOS", etiqueta: "Mejor valor", monto: 1800, montoBase: 1800, descripcion: "Cinco partidas" }
    ]
  }
};

function nuevoDevice(tipo = "premium") {
  return {
    tipo,
    activo: true,
    online: false,
    modoMantenimiento: false,
    mensajeMantenimiento: "Equipo fuera de servicio por mantenimiento",
    ultimaConexion: null,

    ownerLinked: false,
    ownerAccessToken: null,
    ownerRefreshToken: null,
    ownerUserId: null,
    ownerEmail: "",

    comisionEvetecPorcentaje: COMISION_EVETEC_PORCENTAJE,
    modoCobro: "owner_commission",
    registroVentasHabilitado: true,
    salesResetGeneration: 0,
    salesResetAtEpoch: 0,
    salesResetLocalFloor: 0,
    participantes: PARTICIPANT_NUMBERS.map(index => ({
      id: `p${index}`,
      nombre: index === 1 ? "EVETEC" : "",
      porcentaje: index === 1 ? 100 : 0
    })),
    cantidadParticipantes: 1,
    pagadorComisionMp: "proportional",
    configuracionServicio: null,
    configuracionGachapon: null,
    paisOperacion: "AR",

    stats: statsIniciales()
  };
}

async function fetchConTimeout(url, options = {}, timeoutMs = 15000) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, { ...options, signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}

const clientLoginAttempts = new Map();

function normalizarUsuarioCliente(value) {
  return String(value || "").trim().toLowerCase().replace(/[^a-z0-9._-]/g, "").slice(0, 48);
}

function hashPasswordCliente(password, salt = crypto.randomBytes(16).toString("hex")) {
  return { salt, hash: crypto.scryptSync(String(password), salt, 64).toString("hex") };
}

function verificarPasswordCliente(password, account) {
  if (!account?.passwordSalt || !account?.passwordHash) return false;
  const candidate = crypto.scryptSync(String(password), account.passwordSalt, 64).toString("hex");
  return comparacionSegura(candidate, account.passwordHash);
}

function cookiesDe(req) {
  return Object.fromEntries(String(req.headers.cookie || "").split(";").map(part => {
    const index = part.indexOf("=");
    if (index < 0) return ["", ""];
    try { return [part.slice(0, index).trim(), decodeURIComponent(part.slice(index + 1))]; }
    catch (_) { return ["", ""]; }
  }).filter(([key]) => key));
}

function firmarSesionAdmin(payload) {
  const body = Buffer.from(JSON.stringify(payload)).toString("base64url");
  const signature = crypto.createHmac("sha256", CLIENT_SESSION_SECRET).update(`admin.${body}`).digest("base64url");
  return `${body}.${signature}`;
}

function leerSesionAdmin(req) {
  if (!CLIENT_SESSION_SECRET || !ADMIN_PASSWORD) return null;
  const token = cookiesDe(req).evetec_admin_session || "";
  const split = token.lastIndexOf(".");
  if (split < 1) return null;
  const body = token.slice(0, split);
  const signature = token.slice(split + 1);
  const expected = crypto.createHmac("sha256", CLIENT_SESSION_SECRET).update(`admin.${body}`).digest("base64url");
  if (!comparacionSegura(signature, expected)) return null;
  try {
    const payload = JSON.parse(Buffer.from(body, "base64url").toString("utf8"));
    return payload.role === "admin" && Number(payload.exp || 0) >= Date.now() ? payload : null;
  } catch (_) {
    return null;
  }
}

function firmarSesionCliente(payload) {
  const body = Buffer.from(JSON.stringify(payload)).toString("base64url");
  const signature = crypto.createHmac("sha256", CLIENT_SESSION_SECRET).update(body).digest("base64url");
  return `${body}.${signature}`;
}

function leerSesionCliente(req) {
  if (!CLIENT_SESSION_SECRET) return null;
  const token = cookiesDe(req).evetec_client_session || "";
  const split = token.lastIndexOf(".");
  if (split < 1) return null;
  const body = token.slice(0, split);
  const signature = token.slice(split + 1);
  const expected = crypto.createHmac("sha256", CLIENT_SESSION_SECRET).update(body).digest("base64url");
  if (!comparacionSegura(signature, expected)) return null;
  try {
    const payload = JSON.parse(Buffer.from(body, "base64url").toString("utf8"));
    const account = clientAccounts[normalizarUsuarioCliente(payload.u)];
    if (!account?.active || Number(payload.exp || 0) < Date.now() || Number(payload.v || 0) !== Number(account.sessionVersion || 1)) return null;
    return { account, csrf: String(payload.csrf || "") };
  } catch (_) {
    return null;
  }
}

function requireClient(req, res, next) {
  const session = leerSesionCliente(req);
  if (!session) {
    if (req.path.includes("live-stats")) return res.status(401).json({ ok: false, error: "session_expired" });
    return res.redirect(`/cliente/login?next=${encodeURIComponent(req.originalUrl || "/cliente")}`);
  }
  req.clientAccount = session.account;
  req.clientCsrf = session.csrf;
  next();
}

function verificarCsrfCliente(req, res, next) {
  if (comparacionSegura(req.body.csrf, req.clientCsrf)) return next();
  return res.status(403).send("La sesión cambió. Volvé al panel e intentá nuevamente.");
}

function nuevoPrototypeDevice() {
  return {
    ...nuevoDevice("basic"),
    modoCobro: "evetec"
  };
}

let devices = {
  [PROTOTYPE_DEVICE_ID]: nuevoPrototypeDevice()
};

let pagosCreados = {};
let usageEvents = {};
let clientAccounts = {};

function escaparHtml(v) {
  return String(v ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/\"/g, "&quot;");
}

function formatoDinero(n) {
  return Number(n || 0).toLocaleString("es-AR");
}

function formatoTiempo(segundos) {
  segundos = Number(segundos || 0);
  const h = Math.floor(segundos / 3600);
  const m = Math.floor((segundos % 3600) / 60);
  const s = segundos % 60;

  if (h > 0) return `${h}h ${m}m`;
  if (m > 0) return `${m}m ${s}s`;
  return `${s}s`;
}

function claseTipoDevice(tipo) {
  if (tipo === "basic") return "basic";
  if (tipo === "gachapon") return "gachapon";
  if (tipo === "arcade") return "arcade";
  return "premium";
}

function etiquetaTipoDevice(tipo) {
  if (tipo === "basic") return "BASICO";
  if (tipo === "gachapon") return "GACHAPON";
  if (tipo === "arcade") return "ARCADE";
  return "PREMIUM";
}

function detectarTipoDevice(deviceId) {
  const id = String(deviceId || "").toUpperCase();

  if (id.includes("GALAGA") || id.includes("GAME") || id.includes("ARCADE")) {
    return "arcade";
  }

  if (id.includes("GACHAPON") || id.includes("GACHA") || id.includes("PELUCHE") ||
      id.includes("PLUSH") || id.includes("GARRA")) {
    return "gachapon";
  }

  if (id.includes("BASIC") || id.includes("SIMPLE") || id.includes("BASICO") ||
      id.includes("INFLADOR")) {
    return "basic";
  }

  return "premium";
}

function limpiarDevicesMigrados(obj) {
  const migrated = {};
  if (obj && typeof obj === "object") {
    for (const [rawId, value] of Object.entries(obj)) {
      const id = String(rawId || "").trim().toUpperCase();
      if (!id || !value || typeof value !== "object") continue;
      migrated[id] = value;
    }
  }
  if (!migrated[PROTOTYPE_DEVICE_ID]) migrated[PROTOTYPE_DEVICE_ID] = nuevoPrototypeDevice();
  return migrated;
}

function asegurarEstructuraConfig() {
  if (!configGlobal.premium) {
    configGlobal.premium = {
      planes: configGlobal.planes || [
        { id: "P1", nombre: "1m 30s", segundos: 90, monto: 100, montoBase: 100, descripcion: "Limpieza rápida" },
        { id: "P2", nombre: "3m", segundos: 180, monto: 250, montoBase: 250, descripcion: "Auto chico / retoque" },
        { id: "P3", nombre: "5m", segundos: 300, monto: 400, montoBase: 400, descripcion: "Limpieza completa" }
      ],
      preciosExtra: configGlobal.preciosExtra || [
        { id: "E1", nombre: "+30s", segundos: 30, monto: 50, montoBase: 50, descripcion: "Tiempo extra corto" },
        { id: "E2", nombre: "+1m", segundos: 60, monto: 90, montoBase: 90, descripcion: "Tiempo extra" },
        { id: "E3", nombre: "+2m", segundos: 120, monto: 160, montoBase: 160, descripcion: "Tiempo extra extendido" }
      ],
      promoGlobal: configGlobal.promoGlobal || {
        activa: false,
        id: "PROMO",
        nombre: "PROMO GLOBAL",
        segundos: 240,
        monto: 300,
        montoBase: 300,
        descripcion: "Promo especial"
      }
    };
  }

  if (!configGlobal.basic) {
    configGlobal.basic = {
      activo: true,
      nombre: "Inflado de neumaticos",
      segundos: 240,
      preinicioHabilitado: true,
      preinicioSegundos: 15,
      monto: 10,
      montoBase: 10,
      descripcion: "Inflador de autos por 4 minutos"
    };
  }
  if (!Number.isFinite(Number(configGlobal.basic.preinicioSegundos))) {
    configGlobal.basic.preinicioSegundos = 15;
  }
  if (typeof configGlobal.basic.preinicioHabilitado !== "boolean") {
    configGlobal.basic.preinicioHabilitado = true;
  }

  if (!configGlobal.gachapon) {
    configGlobal.gachapon = {
      activo: true,
      nombre: "Gachapon",
      titulo: "GACHAPON",
      mensaje: "Tu sorpresa te espera",
      instruccion: "Toca una opcion",
      pulso_motor_ms: 10000,
      pausa_premios_ms: 650,
      planes: [
        { id: "G1", creditos: 1, nombre: "1 CREDITO", etiqueta: "Elegir y pagar", monto: 1000, montoBase: 1000, giro_ms: 10000, descripcion: "Un premio" },
        { id: "G2", creditos: 2, nombre: "2 CREDITOS", etiqueta: "Promo 5% OFF", monto: 1800, montoBase: 1800, giro_ms: 20000, descripcion: "Dos premios" },
        { id: "G3", creditos: 3, nombre: "3 CREDITOS", etiqueta: "Mejor valor", monto: 2500, montoBase: 2500, giro_ms: 30000, descripcion: "Tres premios" }
      ]
    };
  }

  if (!configGlobal.arcade) {
    configGlobal.arcade = {
      activo: true,
      nombre: "Galaga QR",
      titulo: "GALAGA QR",
      mensaje: "Inserta creditos con Mercado Pago",
      creditosPorPartida: 1,
      planes: [
        { id: "A1", creditos: 1, nombre: "1 CREDITO", etiqueta: "1 partida", monto: 500, montoBase: 500, descripcion: "Una partida" },
        { id: "A3", creditos: 3, nombre: "3 CREDITOS", etiqueta: "Pack arcade", monto: 1200, montoBase: 1200, descripcion: "Tres partidas" },
        { id: "A5", creditos: 5, nombre: "5 CREDITOS", etiqueta: "Mejor valor", monto: 1800, montoBase: 1800, descripcion: "Cinco partidas" }
      ]
    };
  }

  if (!Array.isArray(configGlobal.gachapon.planes)) configGlobal.gachapon.planes = [];
  for (let i = 0; i < 3; i++) {
    if (!configGlobal.gachapon.planes[i]) {
      configGlobal.gachapon.planes[i] = { id: `G${i + 1}`, creditos: i + 1, nombre: `${i + 1} CREDITO`, etiqueta: "Elegir", monto: 1000 * (i + 1), montoBase: 1000 * (i + 1), giro_ms: 10000 * (i + 1), descripcion: "" };
    }
    const gp = configGlobal.gachapon.planes[i];
    if (!gp.id) gp.id = `G${i + 1}`;
    if (!gp.creditos) gp.creditos = i + 1;
    if (!gp.nombre) gp.nombre = `${gp.creditos} CREDITO${gp.creditos > 1 ? "S" : ""}`;
    if (!gp.etiqueta) gp.etiqueta = "Elegir y pagar";
    if (!gp.monto) gp.monto = 1000 * (i + 1);
    if (!gp.montoBase) gp.montoBase = gp.monto;
    if (!gp.giro_ms) gp.giro_ms = 10000 * (i + 1);
    if (typeof gp.descripcion === "undefined") gp.descripcion = "";
  }

  if (!Array.isArray(configGlobal.arcade.planes)) configGlobal.arcade.planes = [];
  for (let i = 0; i < 3; i++) {
    if (!configGlobal.arcade.planes[i]) {
      const creditos = i === 0 ? 1 : (i === 1 ? 3 : 5);
      configGlobal.arcade.planes[i] = { id: `A${creditos}`, creditos, nombre: `${creditos} CREDITO${creditos > 1 ? "S" : ""}`, etiqueta: "Jugar", monto: 500 * creditos, montoBase: 500 * creditos, descripcion: "" };
    }
    const ap = configGlobal.arcade.planes[i];
    if (!ap.id) ap.id = `A${i + 1}`;
    if (!ap.creditos) ap.creditos = i + 1;
    if (!ap.nombre) ap.nombre = `${ap.creditos} CREDITO${ap.creditos > 1 ? "S" : ""}`;
    if (!ap.etiqueta) ap.etiqueta = "Jugar";
    if (!ap.monto) ap.monto = 500 * Number(ap.creditos || 1);
    if (!ap.montoBase) ap.montoBase = ap.monto;
    if (typeof ap.descripcion === "undefined") ap.descripcion = "";
  }
  if (!configGlobal.arcade.creditosPorPartida) configGlobal.arcade.creditosPorPartida = 1;
  if (!configGlobal.arcade.nombre) configGlobal.arcade.nombre = "Galaga QR";
  if (!configGlobal.arcade.titulo) configGlobal.arcade.titulo = "GALAGA QR";
  if (!configGlobal.arcade.mensaje) configGlobal.arcade.mensaje = "Inserta creditos con Mercado Pago";

  delete configGlobal.planes;
  delete configGlobal.preciosExtra;
  delete configGlobal.promoGlobal;
}

function guardarDatos() {
  const snapshot = { devices, pagosCreados, usageEvents, configGlobal, clientAccounts };
  try {
    fs.writeFileSync(
      DATA_FILE,
      JSON.stringify(snapshot, null, 2)
    );
  } catch (err) {
    console.error("Error guardando datos:", err.message);
  }
  if (databaseReady && databasePool) {
    clearTimeout(databaseSaveTimer);
    databaseSaveTimer = setTimeout(async () => {
      try {
        await databasePool.query(
          `INSERT INTO evetec_state (id, payload, updated_at) VALUES ('main', $1::jsonb, NOW())
           ON CONFLICT (id) DO UPDATE SET payload = EXCLUDED.payload, updated_at = NOW()`,
          [JSON.stringify({ devices, pagosCreados, usageEvents, configGlobal, clientAccounts })]
        );
      } catch (err) {
        console.error("Error guardando PostgreSQL:", err.message);
      }
    }, 250);
  }
}

function aplicarSnapshot(data) {
  if (!data || typeof data !== "object") return;
  if (data.configGlobal) {
    configGlobal = { ...configGlobal, ...data.configGlobal };
    asegurarEstructuraConfig();
  }
  if (data.devices) devices = limpiarDevicesMigrados(data.devices);
  if (data.pagosCreados) pagosCreados = data.pagosCreados;
  if (data.usageEvents && typeof data.usageEvents === "object") usageEvents = data.usageEvents;
  if (data.clientAccounts && typeof data.clientAccounts === "object") {
    clientAccounts = Object.fromEntries(Object.entries(data.clientAccounts).map(([key, value]) => {
      const username = normalizarUsuarioCliente(value?.username || key);
      return [username, {
        ...value,
        username,
        displayName: String(value?.displayName || username).slice(0, 60),
        deviceIds: Array.isArray(value?.deviceIds) ? [...new Set(value.deviceIds.map(id => String(id || "").trim().toUpperCase()).filter(Boolean))] : [],
        active: value?.active !== false,
        sessionVersion: Math.max(1, Number(value?.sessionVersion || 1))
      }];
    }).filter(([username]) => username));
  }
}

function cargarDatos() {
  try {
    if (!fs.existsSync(DATA_FILE)) return;

    const data = JSON.parse(fs.readFileSync(DATA_FILE, "utf8"));

    aplicarSnapshot(data);

    if (!devices[PROTOTYPE_DEVICE_ID]) {
      devices[PROTOTYPE_DEVICE_ID] = nuevoPrototypeDevice();
    }

    console.log("Datos EVETEC cargados");
  } catch (err) {
    console.error("Error cargando datos:", err.message);
  }
}

asegurarEstructuraConfig();
cargarDatos();
asegurarEstructuraConfig();
if (deduplicarEventosUso()) guardarDatos();
asegurarDevice(PROTOTYPE_DEVICE_ID);
asegurarDevice(PLUSH_DEVICE_ID);

function asegurarDevice(deviceId) {
  const id = String(deviceId || "ASPIRADORA_001").trim().toUpperCase() || "ASPIRADORA_001";

  if (!devices[id]) {
    devices[id] = nuevoDevice(detectarTipoDevice(id));
    if (id.includes("PELUCHE")) devices[id].modoCobro = "evetec";
  }

  const d = devices[id];

  if (!d.tipo) d.tipo = detectarTipoDevice(id);
  if (typeof d.activo === "undefined") d.activo = true;
  if (typeof d.online === "undefined") d.online = false;
  if (typeof d.modoMantenimiento === "undefined") d.modoMantenimiento = false;
  if (typeof d.mensajeMantenimiento === "undefined") d.mensajeMantenimiento = "Equipo fuera de servicio por mantenimiento";

  if (typeof d.ownerLinked === "undefined") d.ownerLinked = false;
  if (typeof d.ownerAccessToken === "undefined") d.ownerAccessToken = null;
  if (typeof d.ownerRefreshToken === "undefined") d.ownerRefreshToken = null;
  if (typeof d.ownerUserId === "undefined") d.ownerUserId = null;
  if (typeof d.ownerEmail === "undefined") d.ownerEmail = "";

  if (typeof d.comisionEvetecPorcentaje === "undefined") {
    d.comisionEvetecPorcentaje = COMISION_EVETEC_PORCENTAJE;
  }

  if (!d.modoCobro) d.modoCobro = "owner_commission";
  if (typeof d.registroVentasHabilitado === "undefined") d.registroVentasHabilitado = true;
  if (!Number.isFinite(Number(d.salesResetGeneration))) d.salesResetGeneration = 0;
  if (!Number.isFinite(Number(d.salesResetAtEpoch))) d.salesResetAtEpoch = 0;
  if (!Number.isFinite(Number(d.salesResetLocalFloor))) d.salesResetLocalFloor = 0;
  if (!Array.isArray(d.participantes)) d.participantes = [];
  const participantesSinConfigurar = d.participantes.length === 0;
  d.participantes = PARTICIPANT_NUMBERS.map(number => {
    const index = number - 1;
    const source = d.participantes[index] || {};
    return {
      id: `p${index + 1}`,
      nombre: index === 0 ? "EVETEC" : String(typeof source.nombre === "undefined"
        ? (participantesSinConfigurar && index === 0 ? "EVETEC" : "")
        : source.nombre).slice(0, 40),
      porcentaje: Math.max(0, Math.min(100, Number(
        typeof source.porcentaje === "undefined"
          ? (participantesSinConfigurar && index === 0 ? 100 : 0)
          : source.porcentaje
      ))),
      linked: index === 0 ? true : Boolean(source.linked && source.accessToken),
      accessToken: index === 0 ? null : (source.accessToken || null),
      refreshToken: index === 0 ? null : (source.refreshToken || null),
      userId: index === 0 ? null : (source.userId || null),
      email: index === 0 ? "" : String(source.email || "").slice(0, 100)
    };
  });
  const participantesActivos = d.participantes.filter(p => p.nombre && Number(p.porcentaje) > 0).length;
  d.cantidadParticipantes = Math.max(1, Math.min(MAX_PARTICIPANTS, Number(d.cantidadParticipantes || participantesActivos || 1)));
  // Regla comercial global: la comisión de Mercado Pago siempre se reparte
  // en la misma proporción que la participación de cada integrante.
  d.pagadorComisionMp = "proportional";
  if (!Number.isFinite(Number(configGlobal.gachapon.cantidad_opciones))) {
    configGlobal.gachapon.cantidad_opciones = 3;
  }
  if (!Number.isFinite(Number(d.backupConfirmedCount))) d.backupConfirmedCount = 0;
  if (typeof d.backupConfirmedAt === "undefined") d.backupConfirmedAt = null;
  if (!d.participantLinkRequest || typeof d.participantLinkRequest !== "object") d.participantLinkRequest = null;
  if (!d.configuracionServicio || typeof d.configuracionServicio !== "object") {
    d.configuracionServicio = { ...configGlobal.basic };
  }
  d.configuracionServicio = {
    ...configGlobal.basic,
    ...d.configuracionServicio
  };
  if (d.tipo === "gachapon") {
    const defaults = JSON.parse(JSON.stringify(configGlobal.gachapon));
    if (!d.configuracionGachapon || typeof d.configuracionGachapon !== "object") {
      d.configuracionGachapon = defaults;
      if (id.includes("PELUCHE")) {
        d.configuracionGachapon.nombre = "Máquina de Peluches 1";
        d.configuracionGachapon.titulo = "ATRAPÁ TU PELUCHE";
        d.configuracionGachapon.mensaje = "Elegí tus jugadas y pagá con QR";
        d.configuracionGachapon.instruccion = "Elegí una opción";
        d.configuracionGachapon.modo_activacion = "tiempo";
        d.configuracionGachapon.segundos_por_jugada = 30;
        d.configuracionGachapon.pulso_motor_ms = 500;
        d.configuracionGachapon.pausa_premios_ms = 650;
      }
    }
    d.configuracionGachapon = {
      ...defaults,
      ...d.configuracionGachapon,
      planes: [0, 1, 2].map(index => ({
        ...defaults.planes[index],
        ...(d.configuracionGachapon.planes?.[index] || {}),
        id: `G${index + 1}`,
        creditos: index + 1
      }))
    };
    d.configuracionGachapon.cantidad_opciones = Math.max(1, Math.min(3,
      Number(d.configuracionGachapon.cantidad_opciones || 3)));
    if (!["tiempo", "pulsos"].includes(d.configuracionGachapon.modo_activacion)) {
      d.configuracionGachapon.modo_activacion = "tiempo";
    }
    d.configuracionGachapon.segundos_por_jugada = Math.max(1, Math.min(600,
      Number(d.configuracionGachapon.segundos_por_jugada || 30)));
  }
  if (!['AR', 'BR'].includes(d.paisOperacion)) d.paisOperacion = 'AR';
  if (!d.stats) d.stats = statsIniciales();
  if (!Array.isArray(d.stats.ultimosPagos)) d.stats.ultimosPagos = [];
  if (d.tipo === "arcade" && typeof d.arcadeCredits === "undefined") d.arcadeCredits = 0;

  return d;
}

async function iniciarPersistencia() {
  if (!DATABASE_URL) {
    console.warn("Persistencia: archivo local solamente. Configure DATABASE_URL para conservar datos entre despliegues.");
    return;
  }
  try {
    databasePool = new Pool({ connectionString: DATABASE_URL, ssl: { rejectUnauthorized: false } });
    await databasePool.query(`CREATE TABLE IF NOT EXISTS evetec_state (
      id TEXT PRIMARY KEY,
      payload JSONB NOT NULL,
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )`);
    const result = await databasePool.query("SELECT payload FROM evetec_state WHERE id = 'main'");
    if (result.rows[0]?.payload) {
      aplicarSnapshot(result.rows[0].payload);
      asegurarEstructuraConfig();
      asegurarDevice(PROTOTYPE_DEVICE_ID);
      asegurarDevice(PLUSH_DEVICE_ID);
      deduplicarEventosUso();
      console.log("Datos EVETEC restaurados desde PostgreSQL");
    }
    databaseReady = true;
    guardarDatos();
  } catch (err) {
    databaseReady = false;
    console.error("PostgreSQL no disponible; continúa el respaldo local:", err.message);
  }
}

function configuracionServicioDevice(deviceId) {
  return asegurarDevice(deviceId).configuracionServicio;
}

function configuracionGachaponDevice(deviceId) {
  const d = asegurarDevice(deviceId);
  return d.configuracionGachapon || configGlobal.gachapon;
}

function nombreVisibleDevice(deviceId) {
  const d = asegurarDevice(deviceId);
  return d.tipo === "gachapon"
    ? configuracionGachaponDevice(deviceId).nombre
    : d.configuracionServicio?.nombre;
}

function monedaDevice(deviceId) {
  return asegurarDevice(deviceId).paisOperacion === "BR" ? "BRL" : "ARS";
}

function calcularDistribucion(deviceId, monto, comisionMp) {
  const d = asegurarDevice(deviceId);
  const participantes = d.participantes.filter(p => p.nombre && Number(p.porcentaje) > 0);
  const grossCents = Math.max(0, Math.round(Number(monto || 0) * 100));
  const feeCents = Math.max(0, Math.round(Number(comisionMp || 0) * 100));
  if (!participantes.length) return [];

  const result = participantes.map(p => ({
    id: p.id,
    nombre: p.nombre,
    porcentaje: Number(p.porcentaje),
    monto_cents: Math.round(grossCents * Number(p.porcentaje) / 100)
  }));
  const grossDifference = grossCents - result.reduce((sum, p) => sum + p.monto_cents, 0);
  result[result.length - 1].monto_cents += grossDifference;

  let assignedFee = 0;
  result.forEach((p, index) => {
    const participantFee = index === result.length - 1
      ? feeCents - assignedFee
      : Math.round(feeCents * p.porcentaje / 100);
    p.comision_mp_cents = participantFee;
    p.neto_cents = p.monto_cents - participantFee;
    assignedFee += participantFee;
  });
  return result;
}

function eventosUsoDevice(deviceId) {
  const id = String(deviceId || "").trim().toUpperCase();
  return Object.values(usageEvents)
    .filter(e => e && e.device_id === id)
    .sort((a, b) => Number(a.approved_epoch || 0) - Number(b.approved_epoch || 0));
}

function deduplicarEventosUso() {
  let cambios = 0;
  const eventos = Object.entries(usageEvents).filter(([, event]) => event && event.device_id);
  for (const [externalKey, externalEvent] of eventos) {
    const devicePrefix = `${String(externalEvent.device_id).toUpperCase()}_`;
    if (!String(externalKey).toUpperCase().startsWith(devicePrefix)) continue;
    const duplicate = eventos.find(([candidateKey, candidate]) =>
      /^\d+$/.test(String(candidateKey)) &&
      candidate.device_id === externalEvent.device_id &&
      Number(candidate.approved_epoch || 0) === Number(externalEvent.approved_epoch || 0) &&
      Number(candidate.amount_cents || 0) === Number(externalEvent.amount_cents || 0) &&
      Number(candidate.sold_seconds || 0) === Number(externalEvent.sold_seconds || 0)
    );
    if (!duplicate) continue;
    const [paymentKey, paymentEvent] = duplicate;
    usageEvents[externalKey] = {
      ...paymentEvent,
      ...externalEvent,
      event_id: externalKey,
      payment_id: paymentKey,
      started_epoch: Math.max(Number(paymentEvent.started_epoch || 0), Number(externalEvent.started_epoch || 0)),
      finished_epoch: Math.max(Number(paymentEvent.finished_epoch || 0), Number(externalEvent.finished_epoch || 0)),
      actual_seconds: Math.max(Number(paymentEvent.actual_seconds || 0), Number(externalEvent.actual_seconds || 0)),
      completed: paymentEvent.completed !== false || externalEvent.completed !== false,
      mp_fee_cents: Math.max(Number(paymentEvent.mp_fee_cents || 0), Number(externalEvent.mp_fee_cents || 0)),
      net_received_cents: Math.max(Number(paymentEvent.net_received_cents || 0), Number(externalEvent.net_received_cents || 0)),
      participants: externalEvent.participants?.length ? externalEvent.participants : (paymentEvent.participants || [])
    };
    delete usageEvents[paymentKey];
    cambios++;
  }
  if (cambios) console.log(`LEDGER: ${cambios} registro(s) duplicado(s) consolidados`);
  return cambios;
}

function statsDesdeUso(deviceId) {
  const events = eventosUsoDevice(deviceId);
  const baseline = asegurarDevice(deviceId).ledgerBaseline || {};
  const total = events.reduce((acc, e) => {
    acc.totalRecaudado += Number(e.amount_cents || 0) / 100;
    acc.segundosVendidos += Number(e.sold_seconds || 0);
    acc.tiempoMotor += Number(e.actual_seconds || 0);
    acc.comisionesMp += Number(e.mp_fee_cents || 0) / 100;
    acc.netoDespuesMp += (Number(e.amount_cents || 0) - Number(e.mp_fee_cents || 0)) / 100;
    acc.gananciaEvetec += Number(e.evetec_cents || 0) / 100;
    acc.gananciaDuenio += Number(e.owner_cents || 0) / 100;
    for (const participant of (Array.isArray(e.participants) ? e.participants : [])) {
      const id = String(participant.id || "unknown");
      if (!acc.participantTotals[id]) acc.participantTotals[id] = 0;
      acc.participantTotals[id] += Number(participant.neto_cents || 0) / 100;
    }
    if (e.completed === false) acc.interrumpidos += 1;
    return acc;
  }, {
    totalRecaudado: Number(baseline.totalRecaudado || 0),
    pagosAprobados: Number(baseline.pagosAprobados || 0) + events.length,
    segundosVendidos: Number(baseline.segundosVendidos || 0),
    tiempoMotor: Number(baseline.tiempoMotor || 0),
    comisionesMp: 0,
    netoDespuesMp: 0,
    gananciaEvetec: 0,
    gananciaDuenio: 0,
    interrumpidos: 0,
    participantTotals: {},
    ultimosPagos: []
  });
  total.ultimosPagos = events.slice(-30).reverse().map(e => ({
    payment_id: e.payment_id || e.event_id,
    monto: Number(e.amount_cents || 0) / 100,
    segundos: Number(e.sold_seconds || 0),
    actual_seconds: Number(e.actual_seconds || 0),
    fecha: e.approved_epoch ? new Date(Number(e.approved_epoch) * 1000).toISOString() : null,
    completed: e.completed !== false
  }));
  return total;
}
function aplicarDescuento(monto, descuento) {
  return Math.max(1, Math.round(Number(monto) * (1 - Number(descuento) / 100)));
}

function generarQRMatrix(texto) {
  const qr = QRCode.create(texto, { errorCorrectionLevel: "M" });
  const size = qr.modules.size;
  const data = qr.modules.data;

  let matrix = "";

  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      matrix += data[y * size + x] ? "1" : "0";
    }
  }

  return {
    qr_size: size,
    qr_matrix: matrix
  };
}

function estadoOperativo(deviceId) {
  const d = asegurarDevice(deviceId);

  if (!configGlobal.activo) {
    return {
      ok: false,
      motivo: "sistema_desactivado",
      mensaje: "Sistema desactivado temporalmente"
    };
  }

  if (!d.activo || d.modoMantenimiento) {
    return {
      ok: false,
      motivo: "mantenimiento",
      mensaje: d.mensajeMantenimiento || "Equipo en mantenimiento"
    };
  }

  if (d.tipo === "basic" && !configGlobal.basic.activo) {
    return {
      ok: false,
      motivo: "basic_desactivado",
      mensaje: "Sistema básico desactivado temporalmente"
    };
  }

  if (d.tipo === "gachapon" && !configuracionGachaponDevice(deviceId).activo) {
    return {
      ok: false,
      motivo: "gachapon_desactivado",
      mensaje: "Gachapon desactivado temporalmente"
    };
  }

  if (d.tipo === "arcade" && !configGlobal.arcade.activo) {
    return {
      ok: false,
      motivo: "arcade_desactivado",
      mensaje: "Arcade desactivado temporalmente"
    };
  }

  return {
    ok: true,
    motivo: "ok",
    mensaje: "OK"
  };
}

function obtenerTokenParaCobrar(deviceId) {
  const d = asegurarDevice(deviceId);

  if (d.modoCobro === "evetec") {
    return {
      token: EVETEC_MP_TOKEN,
      refreshToken: null,
      usandoOwner: false,
      cuentaCobro: "evetec"
    };
  }

  const participantOwner = participantePrincipalParaCobro(d);
  if ((d.modoCobro === "owner_direct" || d.modoCobro === "owner_commission") && participantOwner) {
    return {
      token: participantOwner.accessToken,
      refreshToken: participantOwner.refreshToken || null,
      usandoOwner: true,
      cuentaCobro: participantOwner.id,
      participantId: participantOwner.id
    };
  }

  if ((d.modoCobro === "owner_direct" || d.modoCobro === "owner_commission") &&
      d.ownerLinked && d.ownerAccessToken) {
    return {
      token: d.ownerAccessToken,
      refreshToken: d.ownerRefreshToken || null,
      usandoOwner: true,
      cuentaCobro: "owner",
      participantId: null
    };
  }

  return {
    token: null,
    refreshToken: null,
    usandoOwner: false,
    cuentaCobro: "owner_required"
  };
}

const mpRefreshInFlight = new Map();

async function renovarCredencialMercadoPago(deviceId, credential) {
  if (!credential?.refreshToken || !MP_CLIENT_ID || !MP_CLIENT_SECRET) return null;
  const id = String(deviceId || "").trim().toUpperCase();
  const refreshKey = `${id}:${credential.cuentaCobro || "owner"}`;
  if (mpRefreshInFlight.has(refreshKey)) return mpRefreshInFlight.get(refreshKey);

  const refreshPromise = (async () => {
    const d = asegurarDevice(id);
    const target = credential.participantId
      ? d.participantes.find(participant => participant.id === credential.participantId)
      : d;
    const currentRefreshToken = credential.participantId ? target?.refreshToken : d.ownerRefreshToken;
    if (!target || !currentRefreshToken) return null;

    const response = await fetchConTimeout("https://api.mercadopago.com/oauth/token", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        client_id: MP_CLIENT_ID,
        client_secret: MP_CLIENT_SECRET,
        grant_type: "refresh_token",
        refresh_token: currentRefreshToken
      })
    });
    const data = await response.json().catch(() => ({}));
    if (!response.ok || !data.access_token) {
      console.error("No se pudo renovar OAuth Mercado Pago:", response.status, data.message || data.error || "respuesta inválida");
      return null;
    }

    if (credential.participantId) {
      target.accessToken = data.access_token;
      target.refreshToken = data.refresh_token || currentRefreshToken;
      target.accessTokenExpiresAt = data.expires_in ? Date.now() + Number(data.expires_in) * 1000 : null;
      target.linked = true;
    } else {
      d.ownerAccessToken = data.access_token;
      d.ownerRefreshToken = data.refresh_token || currentRefreshToken;
      d.ownerAccessTokenExpiresAt = data.expires_in ? Date.now() + Number(data.expires_in) * 1000 : null;
      d.ownerLinked = true;
    }
    guardarDatos();
    return data.access_token;
  })().finally(() => mpRefreshInFlight.delete(refreshKey));

  mpRefreshInFlight.set(refreshKey, refreshPromise);
  return refreshPromise;
}

async function fetchMercadoPagoAutorizado(deviceId, url, options, credential) {
  const currentCredential = credential || obtenerTokenParaCobrar(deviceId);
  const request = token => fetchConTimeout(url, {
    ...options,
    headers: {
      ...(options?.headers || {}),
      Authorization: `Bearer ${token}`
    }
  });

  let response = await request(currentCredential.token);
  if (response.status !== 401 || !currentCredential.refreshToken) return response;

  const renewedToken = await renovarCredencialMercadoPago(deviceId, currentCredential);
  if (!renewedToken) return response;
  response = await request(renewedToken);
  return response;
}

function participantePrincipalParaCobro(device) {
  if (!device || !Array.isArray(device.participantes)) return null;
  return device.participantes.find(participant =>
    participant.id !== "p1" &&
    participant.nombre &&
    Number(participant.porcentaje) > 0 &&
    participant.linked &&
    participant.accessToken
  ) || null;
}

function cuentaExternaLista(device) {
  return Boolean(participantePrincipalParaCobro(device) ||
    (device && device.ownerLinked && device.ownerAccessToken));
}

function calcularComision(deviceId, monto, usandoOwner) {
  const d = asegurarDevice(deviceId);

  if (!usandoOwner) return 0;
  if (d.modoCobro === "owner_direct") return 0;

  const porcentaje = Number(d.comisionEvetecPorcentaje || 0);

  return Math.max(0, Math.round(Number(monto) * porcentaje) / 100);
}

function listaPlanesPremium() {
  const lista = [...configGlobal.premium.planes];

  if (configGlobal.premium.promoGlobal && configGlobal.premium.promoGlobal.activa) {
    lista.push(configGlobal.premium.promoGlobal);
  }

  return lista;
}

function buscarPlanPremium(body) {
  const tipo = String(body.tipo || body.modo || "normal").toLowerCase();
  const planId = String(body.plan_id || body.id || "").toUpperCase();
  const segundos = Number(body.segundos || 0);

  let origen = "normal";
  let candidatos = listaPlanesPremium();

  if (tipo.includes("extra")) {
    origen = "extra";
    candidatos = configGlobal.premium.preciosExtra;
  }

  let plan = candidatos.find(p => String(p.id).toUpperCase() === planId);

  if (!plan && segundos > 0) {
    plan = candidatos.find(p => Number(p.segundos) === segundos);
  }

  if (!plan) {
    plan = candidatos[0];
  }

  return {
    ...plan,
    origen
  };
}

function buscarPlanGachapon(body, deviceId) {
  const cfg = configuracionGachaponDevice(deviceId || body.device_id || body.deviceId);
  const planes = (cfg.planes || []).slice(0, cfg.cantidad_opciones || 3);
  const planIndexRaw = body.plan_index ?? body.planIndex;
  const planIndex = Number(planIndexRaw);
  const planId = String(body.plan_id || body.id || "").toUpperCase();
  const creditos = Number(body.creditos || 0);

  let plan = null;

  if (Number.isFinite(planIndex) && planIndex >= 0 && planIndex < planes.length) {
    plan = planes[planIndex];
  }

  if (!plan && planId) {
    plan = planes.find(p => String(p.id || "").toUpperCase() === planId);
  }

  if (!plan && creditos > 0) {
    plan = planes.find(p => Number(p.creditos) === creditos);
  }

  if (!plan) plan = planes[0];

  return { ...plan };
}

function buscarPlanArcade(body) {
  const planes = configGlobal.arcade.planes || [];
  const planIndexRaw = body.plan_index ?? body.planIndex;
  const planIndex = Number(planIndexRaw);
  const planId = String(body.plan_id || body.id || "").toUpperCase();
  const creditos = Number(body.creditos || 0);

  let plan = null;

  if (Number.isFinite(planIndex) && planIndex >= 0 && planIndex < planes.length) {
    plan = planes[planIndex];
  }

  if (!plan && planId) {
    plan = planes.find(p => String(p.id || "").toUpperCase() === planId);
  }

  if (!plan && creditos > 0) {
    plan = planes.find(p => Number(p.creditos) === creditos);
  }

  if (!plan) plan = planes[0];

  return { ...plan };
}

function normalizarPedidoPago(body) {
  const device_id = String(body.device_id || body.deviceId || "ASPIRADORA_001").toUpperCase();
  const d = asegurarDevice(device_id);

  if (d.tipo === "arcade" || String(body.tipo || body.modo || "").toLowerCase().includes("arcade") || String(body.tipo || body.modo || "").toLowerCase().includes("galaga")) {
    const plan = buscarPlanArcade(body);

    return {
      device_id,
      modoSistema: "arcade",
      plan_id: plan.id || `A${plan.creditos || 1}`,
      plan_nombre: plan.nombre || `${plan.creditos || 1} CREDITO`,
      origen: "arcade",
      monto: Number(plan.monto || plan.precio || body.monto || 500),
      segundos: 1,
      motor_ms: 0,
      creditos: Number(plan.creditos || body.creditos || 1),
      etiqueta: plan.etiqueta || ""
    };
  }

  if (d.tipo === "gachapon" || String(body.tipo || body.modo || "").toLowerCase().includes("gachapon")) {
    const cfg = configuracionGachaponDevice(device_id);
    const plan = buscarPlanGachapon(body, device_id);
    const pulseMs = Math.max(100, Math.min(10000, Number(cfg.pulso_motor_ms || 500)));
    const creditos = Math.max(1, Math.min(3, Number(plan.creditos || body.creditos || 1)));
    const activationMode = cfg.modo_activacion === "pulsos" ? "pulsos" : "tiempo";
    const secondsPerPlay = Math.max(1, Math.min(600, Number(cfg.segundos_por_jugada || 30)));

    return {
      device_id,
      modoSistema: "gachapon",
      plan_id: plan.id || `G${plan.creditos || 1}`,
      plan_nombre: plan.nombre || `${plan.creditos || 1} CREDITO`,
      origen: "gachapon",
      monto: Number(plan.monto || plan.precio || body.monto || 1000),
      segundos: activationMode === "tiempo"
        ? creditos * secondsPerPlay
        : Math.max(1, Math.ceil((creditos * pulseMs + Math.max(0, creditos - 1) * Number(cfg.pausa_premios_ms || 650)) / 1000)),
      motor_ms: pulseMs,
      creditos,
      modo_activacion: activationMode,
      segundos_por_jugada: secondsPerPlay,
      etiqueta: plan.etiqueta || ""
    };
  }

  if (d.tipo === "basic") {
    const cfg = configuracionServicioDevice(device_id);
    return {
      device_id,
      modoSistema: "basic",
      plan_id: "BASIC",
      plan_nombre: cfg.nombre || "Uso básico",
      origen: "basic",
      monto: Number(cfg.monto),
      segundos: Number(cfg.segundos)
    };
  }

  const plan = buscarPlanPremium(body);

  return {
    device_id,
    modoSistema: "premium",
    plan_id: plan.id,
    plan_nombre: plan.nombre,
    origen: plan.origen,
    monto: Number(plan.monto),
    segundos: Number(plan.segundos)
  };
}

// =====================================================
// API ESP32 CONFIG
// =====================================================

app.get("/config/:deviceId", (req, res) => {
  const deviceId = String(req.params.deviceId || "ASPIRADORA_001").toUpperCase();
  const d = asegurarDevice(deviceId);

  d.online = true;
  d.ultimaConexion = new Date().toISOString();

  guardarDatos();

  const operativo = estadoOperativo(deviceId);

  if (d.tipo === "gachapon") {
    const g = configuracionGachaponDevice(deviceId);
    const cantidadOpciones = Math.max(1, Math.min(3, Number(g.cantidad_opciones || 3)));
    return res.json({
      ok: true,
      tipo: "gachapon",
      activo: operativo.ok,
      motivo: operativo.motivo,
      mantenimiento: Boolean(d.modoMantenimiento),
      mensaje: operativo.ok ? (g.mensaje || configGlobal.mensajeGlobal) : operativo.mensaje,
      nombre: g.nombre || "Gachapon",
      titulo: g.titulo || "GACHAPON",
      instruccion: g.instruccion || "Toca una opcion",
      cantidad_opciones: cantidadOpciones,
      modo_activacion: g.modo_activacion === "pulsos" ? "pulsos" : "tiempo",
      segundos_por_jugada: Math.max(1, Math.min(600, Number(g.segundos_por_jugada || 30))),
      pulso_motor_ms: Number(g.pulso_motor_ms || 500),
      pausa_premios_ms: Number(g.pausa_premios_ms || 650),
      giro1_ms: Number(g.planes?.[0]?.giro_ms || 10000),
      giro2_ms: Number(g.planes?.[1]?.giro_ms || 20000),
      giro3_ms: Number(g.planes?.[2]?.giro_ms || 30000),
      motor_plan1_ms: Number(g.planes?.[0]?.giro_ms || 10000),
      motor_plan2_ms: Number(g.planes?.[1]?.giro_ms || 20000),
      motor_plan3_ms: Number(g.planes?.[2]?.giro_ms || 30000),
      precio1: Number(g.planes?.[0]?.monto || 1000),
      precio2: Number(g.planes?.[1]?.monto || 1800),
      precio3: Number(g.planes?.[2]?.monto || 2500),
      planes: (g.planes || []).slice(0, cantidadOpciones).map(p => ({
        id: p.id,
        creditos: Number(p.creditos || 1),
        nombre: p.nombre,
        etiqueta: p.etiqueta,
        monto: Number(p.monto || 0),
        precio: Number(p.monto || 0),
        giro_ms: Number(g.pulso_motor_ms || 500),
        tiempo_giro_ms: Number(g.pulso_motor_ms || 500),
        motor_ms: Number(g.pulso_motor_ms || 500),
        descripcion: p.descripcion || ""
      })),
      ownerLinked: cuentaExternaLista(d),
      evetecAccountReady: Boolean(EVETEC_MP_TOKEN),
      modoCobro: d.modoCobro,
      registro_ventas_habilitado: d.registroVentasHabilitado !== false,
      sales_reset_generation: Number(d.salesResetGeneration || 0),
      participant_link_pending: d.participantLinkRequest ? {
        participant_id: d.participantLinkRequest.participantId,
        alias: d.participantLinkRequest.alias,
        request_id: d.participantLinkRequest.requestedAt || ""
      } : null,
      comisionEvetecPorcentaje: d.comisionEvetecPorcentaje,
      serverTime: new Date().toISOString()
    });
  }

  if (d.tipo === "basic") {
    const cfg = configuracionServicioDevice(deviceId);
    return res.json({
      ok: true,
      tipo: "basic",
      activo: operativo.ok,
      motivo: operativo.motivo,
      mensaje: operativo.ok ? configGlobal.mensajeGlobal : operativo.mensaje,
      precio: Number(cfg.monto),
      monto: Number(cfg.monto),
      segundos: Number(cfg.segundos),
      preinicio_habilitado: cfg.preinicioHabilitado !== false,
      preinicio_segundos: Number(cfg.preinicioSegundos || 15),
      nombre: cfg.nombre,
      descripcion: cfg.descripcion,
      ownerLinked: cuentaExternaLista(d),
      evetecAccountReady: Boolean(EVETEC_MP_TOKEN),
      modoCobro: d.modoCobro,
      registro_ventas_habilitado: d.registroVentasHabilitado !== false,
      sales_reset_generation: Number(d.salesResetGeneration || 0),
      participantes: d.participantes.map(p => ({
        id: p.id,
        nombre: p.nombre,
        porcentaje: p.porcentaje,
        linked: p.id === "p1" ? Boolean(EVETEC_MP_TOKEN) : Boolean(p.linked && p.accessToken),
        userId: p.userId || null
      })),
      pagador_comision_mp: d.pagadorComisionMp,
      cantidad_participantes: d.cantidadParticipantes,
      participant_link_pending: d.participantLinkRequest ? {
        participant_id: d.participantLinkRequest.participantId,
        alias: d.participantLinkRequest.alias,
        request_id: d.participantLinkRequest.requestedAt || ""
      } : null,
      mantenimiento: d.modoMantenimiento,
      serverTime: new Date().toISOString()
    });
  }

  if (d.tipo === "arcade") {
    const a = configGlobal.arcade;
    return res.json({
      ok: true,
      tipo: "arcade",
      activo: operativo.ok,
      motivo: operativo.motivo,
      mantenimiento: Boolean(d.modoMantenimiento),
      mensaje: operativo.ok ? (a.mensaje || "Inserta creditos con Mercado Pago") : operativo.mensaje,
      nombre: a.nombre || "Galaga QR",
      titulo: a.titulo || "GALAGA QR",
      instruccion: "Toca un pack y paga con QR",
      creditosPorPartida: Number(a.creditosPorPartida || 1),
      creditosDisponibles: Number(d.arcadeCredits || 0),
      planes: (a.planes || []).slice(0, 3).map(p => ({
        id: p.id,
        creditos: Number(p.creditos || 1),
        nombre: p.nombre,
        etiqueta: p.etiqueta,
        monto: Number(p.monto || 0),
        precio: Number(p.monto || 0),
        descripcion: p.descripcion || ""
      })),
      ownerLinked: cuentaExternaLista(d),
      modoCobro: d.modoCobro,
      comisionEvetecPorcentaje: d.comisionEvetecPorcentaje,
      serverTime: new Date().toISOString()
    });
  }

  res.json({
    ok: true,
    tipo: "premium",
    activo: operativo.ok,
    motivo: operativo.motivo,
    mensaje: operativo.ok ? configGlobal.mensajeGlobal : operativo.mensaje,
    mensajeGlobal: {
      activo: configGlobal.mensajeGlobalActivo,
      texto: configGlobal.mensajeGlobal
    },
    planes: configGlobal.premium.planes,
    preciosExtra: configGlobal.premium.preciosExtra,
    promoGlobal: configGlobal.premium.promoGlobal.activa ? configGlobal.premium.promoGlobal : null,
    promoGlobalEspecial: configGlobal.premium.promoGlobal.activa ? configGlobal.premium.promoGlobal : null,
    ownerLinked: cuentaExternaLista(d),
    modoCobro: d.modoCobro,
    comisionEvetecPorcentaje: d.comisionEvetecPorcentaje,
    mantenimiento: Boolean(d.modoMantenimiento),
    serverTime: new Date().toISOString()
  });
});

app.post("/heartbeat", (req, res) => {
  const deviceId = String(req.body.device_id || req.body.deviceId || "ASPIRADORA_001").toUpperCase();
  const d = asegurarDevice(deviceId);

  d.online = true;
  d.ultimaConexion = new Date().toISOString();
  d.telemetria = {
    firmware: String(req.body.firmware || d.telemetria?.firmware || ""),
    ssid: String(req.body.ssid || d.telemetria?.ssid || "").slice(0, 64),
    rssi: Number(req.body.rssi ?? d.telemetria?.rssi ?? 0),
    ip: String(req.body.ip || d.telemetria?.ip || "").slice(0, 48),
    uptimeSeconds: Number(req.body.uptime_seconds ?? d.telemetria?.uptimeSeconds ?? 0),
    freeHeap: Number(req.body.free_heap ?? d.telemetria?.freeHeap ?? 0),
    localSales: Number(req.body.local_sales ?? d.telemetria?.localSales ?? 0),
    receivedAt: new Date().toISOString()
  };
  if (Number(d.salesResetGeneration || 0) && d.telemetria.localSales < Number(d.salesResetLocalFloor || 0)) {
    d.salesResetLocalFloor = Math.max(0, d.telemetria.localSales);
  }

  guardarDatos();

  const operativo = estadoOperativo(deviceId);

  res.json({
    ok: true,
    activo: operativo.ok,
    motivo: operativo.motivo,
    mensaje: operativo.mensaje,
    tipo: d.tipo
  });
});

// =====================================================
// LOG DE PAGOS DESDE ESP32
// =====================================================

app.post("/device/payment-log", requireDevice, (req, res) => {
  try {
    const device_id = String(req.body.device_id || req.body.deviceId || "ASPIRADORA_001").toUpperCase();
    const monto = Number(req.body.monto || 0);
    const segundos = Number(req.body.segundos || 0);
    const creditos = Number(req.body.creditos || 0);
    const motorMs = Number(req.body.motor_ms || req.body.motorMs || 0);
    const fecha = req.body.fecha || new Date().toISOString();

    const d = asegurarDevice(device_id);

    d.stats.totalRecaudado += monto;
    d.stats.pagosAprobados += 1;
    d.stats.segundosVendidos += segundos;
    d.stats.tiempoMotor += segundos;
    d.stats.creditosVendidos = Number(d.stats.creditosVendidos || 0) + creditos;
    d.stats.motorMsVendidos = Number(d.stats.motorMsVendidos || 0) + motorMs;

    d.stats.ultimosPagos.unshift({
      monto,
      segundos,
      creditos,
      motor_ms: motorMs,
      fecha,
      tipo: d.tipo
    });

    d.stats.ultimosPagos = d.stats.ultimosPagos.slice(0, 30);

    guardarDatos();

    console.log("PAGO LOG:", device_id, "$" + monto, segundos + "s");

    res.json({
      ok: true,
      stats: d.stats
    });

  } catch (err) {
    console.error("Error payment-log:", err.message);
    res.json({
      ok: false,
      error: err.message
    });
  }
});
// =====================================================
// MERCADO PAGO - CREAR PAGO
// =====================================================

async function crearPagoMercadoPago(pedido) {
  const d = asegurarDevice(pedido.device_id);
  const operativo = estadoOperativo(pedido.device_id);

  if (!operativo.ok) {
    throw new Error(operativo.mensaje);
  }

  const credential = obtenerTokenParaCobrar(pedido.device_id);
  const { token, usandoOwner } = credential;

  if (!token) {
    throw new Error("Falta token Mercado Pago");
  }

  if (!pedido.monto || pedido.monto <= 0) {
    throw new Error("Monto inválido");
  }

  if (pedido.modoSistema !== "gachapon" && (!pedido.segundos || pedido.segundos <= 0)) {
    throw new Error("Tiempo inválido");
  }

  const external_reference = `${pedido.device_id}_${pedido.modoSistema}_${Date.now()}`;
  const comision = calcularComision(pedido.device_id, pedido.monto, usandoOwner);
  const netoDuenioEstimado = Math.max(0, Number(pedido.monto) - comision);
  const moneda = monedaDevice(pedido.device_id);

  const body = {
    items: [
      {
        title: `${pedido.plan_nombre} - ${pedido.device_id}`,
        quantity: 1,
        currency_id: moneda,
        unit_price: Number(pedido.monto)
      }
    ],
    external_reference,
    metadata: {
      device_id: pedido.device_id,
      tipo: pedido.modoSistema,
      plan_id: pedido.plan_id,
      plan_nombre: pedido.plan_nombre,
      origen: pedido.origen,
      segundos: pedido.segundos,
      motor_ms: pedido.motor_ms || 0,
      creditos: pedido.creditos || 0,
      modo_activacion: pedido.modo_activacion || "",
      segundos_por_jugada: pedido.segundos_por_jugada || 0,
      monto_total: pedido.monto,
      comision_evetec: comision,
      neto_duenio_estimado: netoDuenioEstimado,
      modo_cobro: d.modoCobro,
      owner_linked: Boolean(d.ownerLinked)
    },
    expires: true,
    expiration_date_from: new Date().toISOString(),
    expiration_date_to: new Date(Date.now() + 10 * 60 * 1000).toISOString()
  };

  if (comision > 0) {
    body.marketplace_fee = comision;
  }

  const r = await fetchMercadoPagoAutorizado(pedido.device_id, "https://api.mercadopago.com/checkout/preferences", {
    method: "POST",
    headers: {
      "Content-Type": "application/json"
    },
    body: JSON.stringify(body)
  }, credential);

  const data = await r.json();

  if (!r.ok) {
    console.error("Mercado Pago error:", data);
    throw new Error(data.message || "Error creando pago Mercado Pago");
  }

  const link = data.init_point || data.sandbox_init_point;

  if (!link) {
    throw new Error("Mercado Pago no devolvió link de pago");
  }

  pagosCreados[external_reference] = {
    preference_id: data.id,
    external_reference,
    device_id: pedido.device_id,
    tipo: pedido.modoSistema,
    origen: pedido.origen,
    plan_id: pedido.plan_id,
    plan_nombre: pedido.plan_nombre,
    monto: pedido.monto,
    segundos: pedido.segundos,
    motor_ms: pedido.motor_ms || 0,
    creditos: pedido.creditos || 0,
    modo_activacion: pedido.modo_activacion || "",
    segundos_por_jugada: pedido.segundos_por_jugada || 0,
    comisionEvetec: comision,
    netoDuenioEstimado,
    modoCobro: d.modoCobro,
    moneda,
    usandoOwner,
    estado: "pending",
    link,
    creado: new Date().toISOString()
  };

  if (data.id) {
    pagosCreados[data.id] = pagosCreados[external_reference];
  }

  guardarDatos();

  return {
    id: external_reference,
    preference_id: data.id,
    external_reference,
    link,
    monto: pedido.monto,
    segundos: pedido.segundos,
    motor_ms: pedido.motor_ms || 0,
    creditos: pedido.creditos || 0,
    modo_activacion: pedido.modo_activacion || "",
    segundos_por_jugada: pedido.segundos_por_jugada || 0
  };
}

app.post("/crear-pago", async (req, res) => {
  try {
    const pedido = normalizarPedidoPago(req.body);
    const pago = await crearPagoMercadoPago(pedido);

    // Respuesta liviana: el ESP32 genera el QR local desde el link.
    res.json({
      ok: true,
      payment_id: pago.id,
      id: pago.id,
      preference_id: pago.preference_id,
      external_reference: pago.external_reference,
      link: pago.link,
      monto: pago.monto,
      segundos: pago.segundos,
      motor_ms: pago.motor_ms || 0,
      creditos: pago.creditos || 0,
      modo_activacion: pago.modo_activacion || "",
      segundos_por_jugada: pago.segundos_por_jugada || 0,
      tipo: pedido.modoSistema
    });

  } catch (err) {
    console.error("Error /crear-pago:", err.message);

    res.json({
      ok: false,
      error: err.message
    });
  }
});

// Alias por compatibilidad para equipos básicos
app.post("/basic/crear-pago", async (req, res) => {
  req.body.device_id = req.body.device_id || req.body.deviceId || "ASPIRADORA_BASIC_001";

  try {
    const pedido = normalizarPedidoPago(req.body);
    const pago = await crearPagoMercadoPago(pedido);

    res.json({
      ok: true,
      payment_id: pago.id,
      id: pago.id,
      preference_id: pago.preference_id,
      external_reference: pago.external_reference,
      link: pago.link,
      monto: pago.monto,
      segundos: pago.segundos,
      motor_ms: pago.motor_ms || 0,
      creditos: pago.creditos || 0,
      tipo: pedido.modoSistema
    });

  } catch (err) {
    console.error("Error /basic/crear-pago:", err.message);

    res.json({
      ok: false,
      error: err.message
    });
  }
});

app.get("/qr-data", async (req, res) => {
  try {
    const text = String(req.query.text || "");
    if (!text) {
      return res.json({ ok: false, error: "Falta texto para QR" });
    }

    const dataUrl = await QRCode.toDataURL(text, {
      errorCorrectionLevel: "M",
      margin: 1,
      scale: 8
    });

    res.json({ ok: true, dataUrl });
  } catch (err) {
    res.json({ ok: false, error: err.message });
  }
});

app.post("/arcade/claim-payment", async (req, res) => {
  try {
    const id = req.body.id || req.body.payment_id || req.body.paymentId;
    if (!id) {
      return res.json({ ok: false, estado: "pending", error: "sin_id", creditos: 0 });
    }

    const estado = await buscarEstadoMercadoPago(id);
    const pagoLocal = pagosCreados[id] || pagosCreados[estado.payment_id];

    if (estado.estado !== "approved") {
      return res.json({
        ok: false,
        estado: estado.estado,
        status: estado.status,
        detalle: estado.detalle,
        creditos: 0
      });
    }

    if (!pagoLocal) {
      return res.json({ ok: false, estado: "approved", error: "pago_no_encontrado", creditos: 0 });
    }

    if (pagoLocal.arcadeClaimed) {
      return res.json({ ok: true, estado: "approved", alreadyClaimed: true, creditos: 0 });
    }

    pagoLocal.arcadeClaimed = true;
    pagoLocal.estado = "approved";
    pagoLocal.actualizado = new Date().toISOString();

    const creditos = Number(pagoLocal.creditos || estado.creditos || 0);
    const monto = Number(pagoLocal.monto || estado.monto || 0);
    const device_id = pagoLocal.device_id || "GALAGA_001";
    const d = asegurarDevice(device_id);

    d.arcadeCredits = Number(d.arcadeCredits || 0) + creditos;
    d.stats.totalRecaudado += monto;
    d.stats.pagosAprobados += 1;
    d.stats.segundosVendidos += Number(pagoLocal.segundos || 0);
    d.stats.creditosVendidos = Number(d.stats.creditosVendidos || 0) + creditos;
    d.stats.ultimosPagos.unshift({
      monto,
      segundos: Number(pagoLocal.segundos || 0),
      creditos,
      motor_ms: 0,
      fecha: new Date().toISOString(),
      tipo: "arcade"
    });
    d.stats.ultimosPagos = d.stats.ultimosPagos.slice(0, 30);

    guardarDatos();

    res.json({
      ok: true,
      estado: "approved",
      creditos,
      creditosDisponibles: Number(d.arcadeCredits || 0),
      monto,
      device_id
    });
  } catch (err) {
    console.error("Error /arcade/claim-payment:", err.message);
    res.json({ ok: false, estado: "pending", error: err.message, creditos: 0 });
  }
});

app.get("/arcade/state/:deviceId", (req, res) => {
  const device_id = String(req.params.deviceId || "GALAGA_001").toUpperCase();
  const d = asegurarDevice(device_id);
  const operativo = estadoOperativo(device_id);

  res.json({
    ok: true,
    activo: operativo.ok,
    motivo: operativo.motivo,
    mensaje: operativo.mensaje,
    device_id,
    creditos: Number(d.arcadeCredits || 0),
    creditosPorPartida: Number(configGlobal.arcade.creditosPorPartida || 1)
  });
});

app.post("/arcade/consume-credit", (req, res) => {
  const device_id = String(req.body.device_id || req.body.deviceId || "GALAGA_001").toUpperCase();
  const d = asegurarDevice(device_id);
  const operativo = estadoOperativo(device_id);
  const costo = Math.max(1, Number(configGlobal.arcade.creditosPorPartida || 1));

  if (!operativo.ok) {
    return res.json({ ok: false, creditos: Number(d.arcadeCredits || 0), error: operativo.mensaje });
  }

  if (Number(d.arcadeCredits || 0) < costo) {
    return res.json({ ok: false, creditos: Number(d.arcadeCredits || 0), error: "creditos_insuficientes" });
  }

  d.arcadeCredits = Number(d.arcadeCredits || 0) - costo;
  guardarDatos();

  res.json({ ok: true, creditos: Number(d.arcadeCredits || 0), costo });
});

// =====================================================
// MERCADO PAGO - ESTADO DEL PAGO
// =====================================================

async function buscarEstadoMercadoPago(id) {
  const pagoLocal = pagosCreados[id];
  const deviceId = pagoLocal?.device_id;

  const credential = deviceId
    ? obtenerTokenParaCobrar(deviceId)
    : { token: EVETEC_MP_TOKEN, refreshToken: null };
  const { token } = credential;

  if (!token) {
    return {
      estado: "pending",
      status: "pending",
      detalle: "sin_token",
      segundos: pagoLocal?.segundos || 0,
      monto: pagoLocal?.monto || 0,
      tipo: pagoLocal?.tipo || "unknown"
    };
  }

  const externalRef = pagoLocal?.external_reference || id;

  try {
    const url =
      "https://api.mercadopago.com/v1/payments/search" +
      `?external_reference=${encodeURIComponent(externalRef)}` +
      `&sort=date_created&criteria=desc`;

    const r = deviceId
      ? await fetchMercadoPagoAutorizado(deviceId, url, {}, credential)
      : await fetchConTimeout(url, { headers: { Authorization: `Bearer ${token}` } });

    const data = await r.json();

    if (r.ok && Array.isArray(data.results) && data.results.length > 0) {
      const pago = data.results[0];

      const estado = pago.status || "pending";
      const detalle = pago.status_detail || "";
      const referenciaValida = String(pago.external_reference || "") === String(externalRef);
      const montoEsperado = Number(pagoLocal?.monto || 0);
      const montoValido = montoEsperado > 0 &&
        Math.abs(Number(pago.transaction_amount || 0) - montoEsperado) < 0.001;
      const monedaValida = String(pago.currency_id || "") === String(pagoLocal?.moneda || (deviceId ? monedaDevice(deviceId) : "ARS"));
      const verificado = referenciaValida && montoValido && monedaValida;
      const estadoSeguro = estado === "approved" && !verificado ? "invalid" : estado;
      const feeDetails = Array.isArray(pago.fee_details) ? pago.fee_details.map(fee => ({
        type: String(fee.type || "unknown"),
        amount: Number(fee.amount || 0),
        fee_payer: String(fee.fee_payer || "collector")
      })) : [];
      const marketplaceFeeActual = feeDetails
        .filter(fee => fee.type === "marketplace_fee" || fee.type === "application_fee")
        .reduce((sum, fee) => sum + fee.amount, 0);
      let mpFeeActual = feeDetails
        .filter(fee => fee.type !== "marketplace_fee" && fee.type !== "application_fee" && fee.fee_payer !== "payer")
        .reduce((sum, fee) => sum + fee.amount, 0);
      const netReceivedAmount = Number(pago.transaction_details?.net_received_amount || 0);
      if (mpFeeActual <= 0 && netReceivedAmount > 0) {
        mpFeeActual = Math.max(0, Number(pago.transaction_amount || 0) - netReceivedAmount - marketplaceFeeActual);
      }

      if (pagoLocal) {
        pagoLocal.estado = estadoSeguro;
        pagoLocal.payment_id = pago.id;
        pagoLocal.detalle = detalle;
        pagoLocal.verificado = verificado;
        pagoLocal.comisionMpReal = mpFeeActual;
        pagoLocal.comisionMarketplaceReal = marketplaceFeeActual;
        pagoLocal.netoRecibidoMp = netReceivedAmount;
        pagoLocal.feeDetails = feeDetails;
        pagoLocal.actualizado = new Date().toISOString();
        guardarDatos();
      }

      return {
        estado: estadoSeguro,
        status: estadoSeguro,
        detalle,
        payment_id: pago.id,
        verificado,
        external_reference: pago.external_reference || "",
        moneda: pago.currency_id || "",
        monto_verificado: Number(pago.transaction_amount || 0),
        comision_mp_real: mpFeeActual,
        comision_marketplace_real: marketplaceFeeActual,
        neto_recibido_mp: netReceivedAmount,
        fee_details: feeDetails,
        segundos: pagoLocal?.segundos || pago.metadata?.segundos || 0,
        motor_ms: pagoLocal?.motor_ms || pago.metadata?.motor_ms || 0,
        creditos: pagoLocal?.creditos || pago.metadata?.creditos || 0,
        monto: pagoLocal?.monto || pago.metadata?.monto_total || 0,
        tipo: pagoLocal?.tipo || pago.metadata?.tipo || "unknown"
      };
    }
  } catch (err) {
    console.error("Error consultando pago:", err.message);
  }

  return {
    estado: pagoLocal?.estado || "pending",
    status: pagoLocal?.estado || "pending",
    detalle: pagoLocal ? "esperando_pago" : "no_encontrado",
    segundos: pagoLocal?.segundos || 0,
    motor_ms: pagoLocal?.motor_ms || 0,
    creditos: pagoLocal?.creditos || 0,
    monto: pagoLocal?.monto || 0,
    tipo: pagoLocal?.tipo || "unknown"
  };
}

app.get("/estado/:paymentId", async (req, res) => {
  try {
    const estado = await buscarEstadoMercadoPago(req.params.paymentId);
    res.json(estado);
  } catch (err) {
    console.error("Error /estado:", err.message);

    res.json({
      estado: "pending",
      status: "pending",
      detalle: "error_server",
      segundos: 0,
      monto: 0
    });
  }
});

// Alias para INO básico si consulta por query
app.get("/estado-pago", async (req, res) => {
  try {
    const id = req.query.id || req.query.payment_id || req.query.paymentId;

    if (!id) {
      return res.json({
        estado: "pending",
        status: "pending",
        detalle: "sin_id",
        segundos: 0,
        monto: 0
      });
    }

    const estado = await buscarEstadoMercadoPago(id);
    res.json(estado);

  } catch (err) {
    console.error("Error /estado-pago:", err.message);

    res.json({
      estado: "pending",
      status: "pending",
      detalle: "error_server",
      segundos: 0,
      monto: 0
    });
  }
});

function registrarPagoVerificado(pagoLocal, paymentId) {
  if (!pagoLocal || pagoLocal.estadisticasRegistradas) return;

  const d = asegurarDevice(pagoLocal.device_id);
  const monto = Number(pagoLocal.monto || 0);
  const segundos = Number(pagoLocal.segundos || 0);
  const creditos = Number(pagoLocal.creditos || 0);
  const motorMs = Number(pagoLocal.motor_ms || 0);

  d.stats.totalRecaudado += monto;
  d.stats.pagosAprobados += 1;
  d.stats.segundosVendidos += segundos;
  d.stats.tiempoMotor += segundos;
  d.stats.comisionesMp = Number(d.stats.comisionesMp || 0) + Number(pagoLocal.comisionMpReal || 0);
  d.stats.netoDespuesMp = Number(d.stats.netoDespuesMp || 0) + monto - Number(pagoLocal.comisionMpReal || 0);
  d.stats.creditosVendidos = Number(d.stats.creditosVendidos || 0) + creditos;
  d.stats.motorMsVendidos = Number(d.stats.motorMsVendidos || 0) + motorMs;
  d.stats.ultimosPagos.unshift({
    payment_id: paymentId || pagoLocal.payment_id || null,
    monto,
    segundos,
    creditos,
    motor_ms: motorMs,
    fecha: new Date().toISOString(),
    tipo: d.tipo
  });
  d.stats.ultimosPagos = d.stats.ultimosPagos.slice(0, 30);
  pagoLocal.estadisticasRegistradas = true;
}

app.post("/device/claim-payment", requireDevice, async (req, res) => {
  try {
    const deviceId = String(req.body.device_id || req.body.deviceId || "").trim().toUpperCase();
    const id = String(req.body.payment_id || req.body.paymentId || req.body.id || "").trim();
    const pagoLocal = pagosCreados[id];

    if (!deviceId || !id || !pagoLocal || pagoLocal.device_id !== deviceId) {
      return res.status(404).json({ ok: false, activate: false, status: "not_found" });
    }

    const creadoMs = Date.parse(pagoLocal.creado || "");
    if (!Number.isFinite(creadoMs) || Date.now() - creadoMs > 20 * 60 * 1000) {
      return res.json({ ok: true, activate: false, status: "expired" });
    }

    const estado = await buscarEstadoMercadoPago(id);
    if (estado.estado !== "approved" || !estado.verificado) {
      return res.json({
        ok: true,
        activate: false,
        status: estado.estado || "pending",
        detail: estado.detalle || ""
      });
    }

    if (pagoLocal.consumidoAt) {
      return res.json({
        ok: true,
        activate: false,
        status: "consumed",
        consumed_at: pagoLocal.consumidoAt
      });
    }

    pagoLocal.consumidoAt = new Date().toISOString();
    pagoLocal.consumidoPor = deviceId;
    const registrarVenta = asegurarDevice(deviceId).registroVentasHabilitado !== false;
    const distribucion = calcularDistribucion(deviceId, pagoLocal.monto, estado.comision_mp_real);
    pagoLocal.distribucion = distribucion;
    if (registrarVenta) {
      const d = asegurarDevice(deviceId);
      if (!d.ledgerBaseline && eventosUsoDevice(deviceId).length === 0) {
        d.ledgerBaseline = {
          totalRecaudado: Number(d.stats?.totalRecaudado || 0),
          pagosAprobados: Number(d.stats?.pagosAprobados || 0),
          segundosVendidos: Number(d.stats?.segundosVendidos || 0),
          tiempoMotor: Number(d.stats?.tiempoMotor || 0)
        };
      }
      // Un pago tiene dos identificadores: nuestra referencia externa y el ID
      // numérico de Mercado Pago. El equipo conoce la referencia externa, por
      // lo que esa debe ser la clave canónica en ambos lados para no sumar dos veces.
      const eventId = String(pagoLocal.external_reference || id);
      usageEvents[eventId] = {
        event_id: eventId,
        payment_id: String(estado.payment_id || ""),
        device_id: deviceId,
        approved_epoch: Math.floor(Date.now() / 1000),
        started_epoch: 0,
        finished_epoch: 0,
        amount_cents: Math.round(Number(pagoLocal.monto || 0) * 100),
        sold_seconds: Math.max(1, Math.min(3600, Number(pagoLocal.segundos || 0))),
        actual_seconds: 0,
        evetec_cents: Math.round(Number(pagoLocal.usandoOwner ? pagoLocal.comisionEvetec || 0 : pagoLocal.monto || 0) * 100),
        owner_cents: Math.round(Number(pagoLocal.usandoOwner ? pagoLocal.netoDuenioEstimado || 0 : 0) * 100),
        mp_fee_cents: Math.round(Number(estado.comision_mp_real || 0) * 100),
        net_received_cents: Math.round(Number(estado.neto_recibido_mp || 0) * 100),
        participants: distribucion,
        mode: pagoLocal.modoCobro || "evetec",
        completed: false,
        synced_at: new Date().toISOString()
      };
      registrarPagoVerificado(pagoLocal, estado.payment_id);
    }
    else pagoLocal.registroOmitidoPorModoPrueba = true;
    guardarDatos();

    return res.json({
      ok: true,
      activate: true,
      status: "approved",
      event_id: String(pagoLocal.external_reference || id),
      payment_id: estado.payment_id,
      monto: Number(pagoLocal.monto || 0),
      segundos: Math.max(1, Math.min(3600, Number(pagoLocal.segundos || 0))),
      creditos: Math.max(1, Math.min(3, Number(pagoLocal.creditos || 1))),
      motor_ms: Math.max(100, Math.min(10000, Number(pagoLocal.motor_ms || 500))),
      modo_activacion: pagoLocal.modo_activacion === "pulsos" ? "pulsos" : "tiempo",
      segundos_por_jugada: Math.max(1, Math.min(600, Number(pagoLocal.segundos_por_jugada || 30))),
      approved_epoch: Math.floor(Date.now() / 1000),
      modo_cobro: pagoLocal.modoCobro || "evetec",
      comision_evetec: Number(pagoLocal.comisionEvetec || 0),
      neto_duenio: Number(pagoLocal.usandoOwner ? pagoLocal.netoDuenioEstimado || 0 : 0),
      ganancia_evetec: Number(pagoLocal.usandoOwner ? pagoLocal.comisionEvetec || 0 : pagoLocal.monto || 0),
      registrar_venta: registrarVenta,
      comision_mp_real: Number(estado.comision_mp_real || 0),
      neto_recibido_mp: Number(estado.neto_recibido_mp || 0),
      participantes: distribucion
    });
  } catch (err) {
    console.error("Error /device/claim-payment:", err.message);
    return res.status(500).json({ ok: false, activate: false, status: "server_error" });
  }
});

app.get("/device/usage-status/:deviceId", requireDevice, (req, res) => {
  const deviceId = String(req.params.deviceId || "").trim().toUpperCase();
  const d = asegurarDevice(deviceId);
  const events = eventosUsoDevice(deviceId);
  const latest = events.length ? events[events.length - 1].event_id : "";
  res.json({
    ok: true,
    count: Math.max(0, Number(d.salesResetLocalFloor || 0)) + events.length,
    latest_event_id: latest,
    sales_reset_generation: Number(d.salesResetGeneration || 0),
    server_epoch: Math.floor(Date.now() / 1000)
  });
});

app.post("/device/usage-sync", requireDevice, (req, res) => {
  const deviceId = String(req.body.device_id || req.body.deviceId || "").trim().toUpperCase();
  const incoming = Array.isArray(req.body.events) ? req.body.events.slice(0, 20) : [];
  if (!deviceId || !devices[deviceId]) {
    return res.status(404).json({ ok: false, error: "device_not_found" });
  }

  const d = asegurarDevice(deviceId);
  if (incoming.length && !d.ledgerBaseline && eventosUsoDevice(deviceId).length === 0) {
    const incomingAmount = incoming.reduce((n, e) => n + Number(e.amount_cents || 0) / 100, 0);
    const incomingSeconds = incoming.reduce((n, e) => n + Number(e.sold_seconds || 0), 0);
    d.ledgerBaseline = {
      totalRecaudado: Math.max(0, Number(d.stats?.totalRecaudado || 0) - incomingAmount),
      pagosAprobados: Math.max(0, Number(d.stats?.pagosAprobados || 0) - incoming.length),
      segundosVendidos: Math.max(0, Number(d.stats?.segundosVendidos || 0) - incomingSeconds),
      tiempoMotor: Math.max(0, Number(d.stats?.tiempoMotor || 0) - incomingSeconds)
    };
  }

  let accepted = 0;
  let updated = 0;
  for (const source of incoming) {
    const eventId = String(source.event_id || source.payment_id || "").trim().slice(0, 120);
    if (!eventId) continue;
    const approvedEpoch = Math.max(0, Math.round(Number(source.approved_epoch || 0)));
    if (Number(d.salesResetAtEpoch || 0) && approvedEpoch <= Number(d.salesResetAtEpoch)) continue;
    const existing = usageEvents[eventId];
    if (existing && existing.device_id !== deviceId) continue;
    const amountCents = Math.max(0, Math.round(Number(source.amount_cents || 0)));
    const evetecCents = Math.max(0, Math.min(amountCents, Math.round(Number(source.evetec_cents || 0))));
    const ownerCents = Math.max(0, Math.min(amountCents, Math.round(Number(source.owner_cents || 0))));
    const normalized = {
      event_id: eventId,
      payment_id: String(source.payment_id || eventId).slice(0, 120),
      device_id: deviceId,
      approved_epoch: approvedEpoch,
      started_epoch: Math.max(0, Math.round(Number(source.started_epoch || 0))),
      finished_epoch: Math.max(0, Math.round(Number(source.finished_epoch || 0))),
      amount_cents: amountCents,
      sold_seconds: Math.max(0, Math.min(86400, Math.round(Number(source.sold_seconds || 0)))),
      actual_seconds: Math.max(0, Math.min(86400, Math.round(Number(source.actual_seconds || 0)))),
      evetec_cents: evetecCents,
      owner_cents: ownerCents,
      mp_fee_cents: Math.max(0, Math.round(Number(source.mp_fee_cents || 0))),
      net_received_cents: Math.round(Number(source.net_received_cents || 0)),
      participants: (Array.isArray(source.participants) ? source.participants : []).slice(0, MAX_PARTICIPANTS).map((p, index) => ({
        id: String(p.id || `p${index + 1}`).slice(0, 10),
        nombre: String(p.nombre || `Participante ${index + 1}`).slice(0, 40),
        porcentaje: Math.max(0, Math.min(100, Number(p.porcentaje || 0))),
        monto_cents: Math.round(Number(p.monto_cents || 0)),
        comision_mp_cents: Math.max(0, Math.round(Number(p.comision_mp_cents || 0))),
        neto_cents: Math.round(Number(p.neto_cents || 0))
      })),
      mode: String(source.mode || "evetec").slice(0, 30),
      completed: source.completed !== false,
      synced_at: new Date().toISOString()
    };
    if (existing) {
      if (!normalized.approved_epoch) normalized.approved_epoch = Number(existing.approved_epoch || 0);
      if (!normalized.mp_fee_cents && Number(existing.mp_fee_cents || 0) > 0) normalized.mp_fee_cents = existing.mp_fee_cents;
      if (!normalized.net_received_cents && Number(existing.net_received_cents || 0) > 0) normalized.net_received_cents = existing.net_received_cents;
      if (!normalized.participants.length && Array.isArray(existing.participants)) normalized.participants = existing.participants;
      updated += 1;
    } else {
      accepted += 1;
    }
    usageEvents[eventId] = normalized;
  }
  if (accepted || updated) guardarDatos();
  const events = eventosUsoDevice(deviceId);
  res.json({
    ok: true,
    accepted,
    updated,
    count: events.length,
    latest_event_id: events.length ? events[events.length - 1].event_id : ""
  });
});

// =====================================================
// OAUTH MERCADO PAGO - VINCULAR DUEÑO
// =====================================================

app.get("/oauth/link/:deviceId", (req, res) => {
  try {
    const deviceId = String(req.params.deviceId || "").toUpperCase();
    asegurarDevice(deviceId);

    if (!MP_CLIENT_ID) {
      return res.json({
        ok: false,
        error: "Falta MP_CLIENT_ID",
        qr_size: 0,
        qr_matrix: ""
      });
    }

    const stateToken = crypto.randomBytes(24).toString("hex");
    oauthStates.set(stateToken, { deviceId, expiresAt: Date.now() + 10 * 60 * 1000 });
    for (const [key, value] of oauthStates) {
      if (value.expiresAt < Date.now()) oauthStates.delete(key);
    }

    const url =
      "https://auth.mercadopago.com.ar/authorization" +
      `?response_type=code` +
      `&client_id=${encodeURIComponent(MP_CLIENT_ID)}` +
      `&redirect_uri=${encodeURIComponent(REDIRECT_URI)}` +
      `&state=${encodeURIComponent(stateToken)}`;

    const qr = generarQRMatrix(url);

    res.json({
      ok: true,
      url,
      qr_size: qr.qr_size,
      qr_matrix: qr.qr_matrix
    });
  } catch (err) {
    res.json({
      ok: false,
      error: err.message,
      qr_size: 0,
      qr_matrix: ""
    });
  }
});

app.get("/oauth/participant-link/:deviceId/:participantId", (req, res) => {
  try {
    const deviceId = String(req.params.deviceId || "").trim().toUpperCase();
    const participantId = String(req.params.participantId || "").trim().toLowerCase();
    const d = asegurarDevice(deviceId);
    const participant = d.participantes.find(p => p.id === participantId);
    if (!participant || participantId === "p1") {
      return res.status(404).json({ ok: false, error: "participante_invalido" });
    }
    if (d.participantLinkRequest?.participantId !== participantId) {
      return res.status(410).json({ ok: false, error: "vinculacion_cancelada", qr_size: 0, qr_matrix: "" });
    }
    if (!MP_CLIENT_ID) return res.status(503).json({ ok: false, error: "Falta MP_CLIENT_ID" });
    if (!d.participantLinkRequest.shareToken) {
      d.participantLinkRequest.shareToken = crypto.randomBytes(24).toString("hex");
      guardarDatos();
    }
    const url = `${PUBLIC_BASE_URL}/vincular/${encodeURIComponent(deviceId)}/${encodeURIComponent(participantId)}/${encodeURIComponent(d.participantLinkRequest.shareToken)}`;
    const qr = generarQRMatrix(url);
    res.json({
      ok: true,
      url,
      alias: participant.nombre || participantId,
      participant_id: participantId,
      qr_size: qr.qr_size,
      qr_matrix: qr.qr_matrix
    });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

app.get("/vincular/:deviceId/:participantId/:shareToken", (req, res) => {
  const deviceId = String(req.params.deviceId || "").trim().toUpperCase();
  const participantId = String(req.params.participantId || "").trim().toLowerCase();
  const shareToken = String(req.params.shareToken || "").trim();
  const d = asegurarDevice(deviceId);
  const request = d.participantLinkRequest;
  const valid = request?.participantId === participantId &&
    shareToken.length >= 32 &&
    request.shareToken === shareToken;
  if (!valid) {
    return res.status(410).send("<h2>Vinculación no disponible</h2><p>El enlace fue cancelado, reemplazado o ya se utilizó.</p>");
  }
  if (!MP_CLIENT_ID) return res.status(503).send("<h2>Vinculación temporalmente no disponible</h2>");

  invalidarOauthParticipante(deviceId, participantId);
  const stateToken = crypto.randomBytes(24).toString("hex");
  oauthStates.set(stateToken, { deviceId, participantId, expiresAt: Date.now() + 10 * 60 * 1000 });
  for (const [key, value] of oauthStates) {
    if (value.expiresAt < Date.now()) oauthStates.delete(key);
  }
  const authorizationUrl =
    "https://auth.mercadopago.com.ar/authorization" +
    `?response_type=code` +
    `&client_id=${encodeURIComponent(MP_CLIENT_ID)}` +
    `&redirect_uri=${encodeURIComponent(REDIRECT_URI)}` +
    `&state=${encodeURIComponent(stateToken)}`;
  res.redirect(authorizationUrl);
});

app.get("/oauth/callback", async (req, res) => {
  const code = req.query.code;
  const stateToken = String(req.query.state || "");
  const stateData = oauthStates.get(stateToken);
  oauthStates.delete(stateToken);
  const deviceId = stateData && stateData.expiresAt >= Date.now()
    ? String(stateData.deviceId || "").toUpperCase()
    : "";
  const participantId = stateData && stateData.expiresAt >= Date.now()
    ? String(stateData.participantId || "").toLowerCase()
    : "";

  if (!code || !deviceId) {
    return res.send("<h2>Sistema</h2><p>Faltan datos de autorización.</p>");
  }

  try {
    const d = asegurarDevice(deviceId);

    const r = await fetchConTimeout("https://api.mercadopago.com/oauth/token", {
      method: "POST",
      headers: {
        "Content-Type": "application/json"
      },
      body: JSON.stringify({
        client_id: MP_CLIENT_ID,
        client_secret: MP_CLIENT_SECRET,
        grant_type: "authorization_code",
        code,
        redirect_uri: REDIRECT_URI
      })
    });

    const data = await r.json();

    if (!r.ok) {
      console.error("Error OAuth Mercado Pago:", data);

      return res.send(`
        <h2>Sistema</h2>
        <p>Error vinculando cuenta Mercado Pago.</p>
        <pre>${escaparHtml(JSON.stringify(data, null, 2))}</pre>
      `);
    }

    let linkedName = "Cuenta dueña";
    if (participantId) {
      const participant = d.participantes.find(p => p.id === participantId);
      if (!participant || participantId === "p1") throw new Error("Participante inválido");
      participant.accessToken = data.access_token;
      participant.refreshToken = data.refresh_token || null;
      participant.accessTokenExpiresAt = data.expires_in ? Date.now() + Number(data.expires_in) * 1000 : null;
      participant.userId = data.user_id || null;
      participant.linked = true;
      linkedName = participant.nombre || participantId;
      if (d.participantLinkRequest?.participantId === participantId) d.participantLinkRequest = null;
    } else {
      d.ownerAccessToken = data.access_token;
      d.ownerRefreshToken = data.refresh_token || null;
      d.ownerAccessTokenExpiresAt = data.expires_in ? Date.now() + Number(data.expires_in) * 1000 : null;
      d.ownerUserId = data.user_id || null;
      d.ownerLinked = true;
    }

    guardarDatos();

    res.send(`
      <html>
      <head>
        <meta name="viewport" content="width=device-width, initial-scale=1">
        <style>
          body { font-family: Arial; background:#050816; color:white; padding:30px; }
          .box { max-width:560px; margin:auto; background:#111827; border:1px solid #22d3ee; border-radius:16px; padding:22px; }
          h1 { color:#22c55e; }
        </style>
      </head>
      <body>
        <div class="box">
          <h1>Cuenta vinculada correctamente</h1>
          <p><b>${escaparHtml(linkedName)}</b> quedó vinculado al módulo <b>${escaparHtml(deviceId)}</b>.</p>
          <p>Ya podés cerrar esta página.</p>
        </div>
      </body>
      </html>
    `);

  } catch (err) {
    console.error("Error /oauth/callback:", err);

    res.send(`
      <h2>Sistema</h2>
      <p>Error interno vinculando cuenta.</p>
      <pre>${escaparHtml(err.message)}</pre>
    `);
  }
});

app.post("/unlink-owner/:deviceId", requireAdmin, (req, res) => {
  if (String(req.body.confirmation || "").trim().toUpperCase() !== "DESVINCULAR") {
    return res.status(400).send("Confirmación requerida. La cuenta no fue modificada.");
  }
  const d = asegurarDevice(req.params.deviceId);

  d.ownerLinked = false;
  d.ownerAccessToken = null;
  d.ownerRefreshToken = null;
  d.ownerUserId = null;
  d.ownerEmail = "";

  guardarDatos();

  res.redirect(`/admin?device=${encodeURIComponent(String(req.params.deviceId || "").toUpperCase())}`);
});

app.get("/owner-status/:deviceId", (req, res) => {
  const d = asegurarDevice(req.params.deviceId);
  const participantOwner = participantePrincipalParaCobro(d);

  res.json({
    ok: true,
    linked: cuentaExternaLista(d),
    ownerUserId: participantOwner?.userId || d.ownerUserId || null,
    tipo: d.tipo,
    modoCobro: d.modoCobro,
    comisionEvetecPorcentaje: d.comisionEvetecPorcentaje
  });
});

app.get("/galaga", (req, res) => {
  asegurarDevice("GALAGA_001");
  const arcade = configGlobal.arcade;
  const planes = (arcade.planes || []).slice(0, 3);

  res.send(`<!doctype html>
<html lang="es">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
  <title>${escaparHtml(arcade.titulo || "GALAGA QR")}</title>
  <style>
    *{box-sizing:border-box} html,body{margin:0;width:100%;height:100%;overflow:hidden;background:#05070d;color:#f8fafc;font-family:Arial,Helvetica,sans-serif}
    body{display:grid;place-items:center}
    .shell{position:relative;width:100vw;height:100vh;background:radial-gradient(circle at 50% 18%,#17324e 0,#07101f 38%,#02040a 100%)}
    canvas{display:block;width:100%;height:100%;image-rendering:pixelated}
    .hud{position:absolute;inset:0;pointer-events:none;padding:14px;display:flex;justify-content:space-between;align-items:flex-start;font-weight:800;text-shadow:0 2px 8px #000}
    .hud div{background:rgba(1,8,18,.58);border:1px solid rgba(125,211,252,.28);border-radius:8px;padding:8px 10px}
    .center{position:absolute;inset:0;display:grid;place-items:center;pointer-events:none}
    .panel{width:min(560px,92vw);background:rgba(2,8,23,.88);border:1px solid rgba(56,189,248,.45);border-radius:8px;padding:18px;box-shadow:0 24px 80px rgba(0,0,0,.5);text-align:center;pointer-events:auto}
    h1{margin:0 0 6px;font-size:36px;letter-spacing:0;color:#facc15} p{margin:8px 0;color:#cbd5e1}
    .plans{display:grid;grid-template-columns:repeat(3,1fr);gap:10px;margin-top:14px}
    button{border:0;border-radius:8px;background:#22d3ee;color:#001018;font-weight:900;padding:12px 10px;cursor:pointer}
    button.secondary{background:#111827;color:#e2e8f0;border:1px solid #334155}
    button.start{background:#22c55e;color:#02140a;font-size:18px;margin-top:12px;width:100%}
    button:disabled{opacity:.45;cursor:not-allowed}
    .small{font-size:13px;color:#94a3b8}.qr{width:min(280px,70vw);height:min(280px,70vw);background:white;margin:12px auto;padding:10px;border-radius:8px}
    .qr img{width:100%;height:100%;display:block}.hidden{display:none}.status{min-height:22px;color:#facc15;font-weight:800}
    @media (max-width:620px){.plans{grid-template-columns:1fr} h1{font-size:28px}.hud{font-size:13px;padding:8px}.hud div{padding:6px 7px}}
  </style>
</head>
<body>
  <div class="shell">
    <canvas id="game" width="480" height="720"></canvas>
    <div class="hud">
      <div>PUNTOS <span id="score">0</span></div>
      <div>CREDITOS <span id="credits">0</span></div>
      <div>VIDAS <span id="lives">3</span></div>
    </div>
    <div class="center" id="menu">
      <div class="panel">
        <h1>${escaparHtml(arcade.titulo || "GALAGA QR")}</h1>
        <p>${escaparHtml(arcade.mensaje || "Inserta creditos con Mercado Pago")}</p>
        <p class="small">Joystick USB: mover con eje horizontal, disparar con boton 0. Teclado: flechas/A-D y Espacio.</p>
        <button class="start" id="startBtn">JUGAR (${Number(arcade.creditosPorPartida || 1)} CREDITO)</button>
        <div class="plans">
          ${planes.map((p, i) => `<button data-plan="${i}">${escaparHtml(p.nombre || (p.creditos + " CREDITOS"))}<br>$${formatoDinero(p.monto)}<br><span class="small">${escaparHtml(p.etiqueta || "")}</span></button>`).join("")}
        </div>
        <p class="status" id="payStatus"></p>
      </div>
    </div>
    <div class="center hidden" id="payModal">
      <div class="panel">
        <h1>PAGAR QR</h1>
        <p id="payTitle">Escanea y paga</p>
        <div class="qr" id="qrBox"></div>
        <p class="status" id="qrStatus">Esperando pago...</p>
        <button class="secondary" id="closePay">Cerrar</button>
      </div>
    </div>
  </div>
  <script>
  (function(){
    const DEVICE_ID = 'GALAGA_001';
    const COST = ${Number(arcade.creditosPorPartida || 1)};
    const canvas = document.getElementById('game');
    const ctx = canvas.getContext('2d');
    const W = canvas.width, H = canvas.height;
    const scoreEl = document.getElementById('score');
    const creditsEl = document.getElementById('credits');
    const livesEl = document.getElementById('lives');
    const menu = document.getElementById('menu');
    const payModal = document.getElementById('payModal');
    const qrBox = document.getElementById('qrBox');
    const qrStatus = document.getElementById('qrStatus');
    const payTitle = document.getElementById('payTitle');
    const payStatus = document.getElementById('payStatus');
    const keys = {};
    let credits = 0;
    let score = 0, lives = 3, level = 1, playing = false, over = false;
    let stars = [], enemies = [], bullets = [], enemyBullets = [], particles = [];
    let player = {x:W/2,y:H-64,w:34,h:34,cool:0,inv:0};
    let pollTimer = null, lastShot = false;

    function saveCredits(){ creditsEl.textContent = credits; }
    async function refreshCredits(){
      try {
        const state = await fetch('/arcade/state/' + DEVICE_ID).then(x=>x.json());
        credits = Number(state.creditos || 0);
        saveCredits();
      } catch (err) {}
    }
    function rnd(a,b){ return a + Math.random() * (b-a); }
    function resetStars(){ stars = Array.from({length:90}, () => ({x:rnd(0,W), y:rnd(0,H), z:rnd(.4,1.8)})); }
    function spawnWave(){
      enemies = [];
      const rows = Math.min(5, 3 + Math.floor(level/2));
      const cols = 8;
      for(let r=0;r<rows;r++){
        for(let c=0;c<cols;c++){
          enemies.push({x:54+c*52,y:64+r*42,baseX:54+c*52,baseY:64+r*42,w:28,h:24,hp:r===0?2:1,t:r*9+c*3,diving:false});
        }
      }
    }
    async function newGame(){
      const consume = await fetch('/arcade/consume-credit',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({device_id:DEVICE_ID})}).then(x=>x.json()).catch(err => ({ok:false,error:err.message}));
      if(!consume.ok){ credits = Number(consume.creditos || credits || 0); saveCredits(); payStatus.textContent = consume.error === 'creditos_insuficientes' ? 'Faltan creditos' : (consume.error || 'No se pudo iniciar'); return; }
      credits = Number(consume.creditos || 0); saveCredits();
      score = 0; lives = 3; level = 1; playing = true; over = false;
      player = {x:W/2,y:H-64,w:34,h:34,cool:0,inv:80};
      bullets = []; enemyBullets = []; particles = [];
      spawnWave(); menu.classList.add('hidden'); updateHud();
    }
    function updateHud(){ scoreEl.textContent = score; livesEl.textContent = lives; creditsEl.textContent = credits; }
    function hit(a,b){ return Math.abs(a.x-b.x)*2 < (a.w+b.w) && Math.abs(a.y-b.y)*2 < (a.h+b.h); }
    function boom(x,y,color){
      for(let i=0;i<12;i++) particles.push({x,y,vx:rnd(-3,3),vy:rnd(-3,3),life:rnd(18,36),color});
    }
    function input(){
      let move = 0, fire = false;
      if(keys.ArrowLeft || keys.KeyA) move -= 1;
      if(keys.ArrowRight || keys.KeyD) move += 1;
      if(keys.Space || keys.Enter) fire = true;
      const pads = navigator.getGamepads ? navigator.getGamepads() : [];
      for(const pad of pads){
        if(!pad) continue;
        const ax = pad.axes[0] || 0;
        if(Math.abs(ax) > .22) move += ax;
        fire = fire || (pad.buttons[0] && pad.buttons[0].pressed) || (pad.buttons[1] && pad.buttons[1].pressed);
      }
      player.x += Math.max(-1, Math.min(1, move)) * 6.2;
      player.x = Math.max(22, Math.min(W-22, player.x));
      if(fire && !lastShot && player.cool <= 0 && playing){
        bullets.push({x:player.x,y:player.y-22,w:5,h:16,vy:-9});
        player.cool = 10;
      }
      lastShot = fire;
    }
    function update(){
      stars.forEach(s => { s.y += s.z * (playing ? 2.2 : 1); if(s.y > H){s.y=0;s.x=rnd(0,W);} });
      if(!playing) return;
      input();
      if(player.cool>0) player.cool--; if(player.inv>0) player.inv--;
      bullets.forEach(b => b.y += b.vy); bullets = bullets.filter(b => b.y > -30);
      enemyBullets.forEach(b => b.y += b.vy); enemyBullets = enemyBullets.filter(b => b.y < H+40);
      const wave = Math.sin(Date.now()/520) * (20 + level*2);
      enemies.forEach(e => {
        e.t += .04;
        e.x = e.baseX + wave + Math.sin(e.t) * 10;
        e.y = e.baseY + Math.sin(e.t*.7) * 8;
        if(Math.random() < 0.0018 + level*0.0007) enemyBullets.push({x:e.x,y:e.y+18,w:6,h:14,vy:3.1+level*.25});
      });
      for(const b of bullets){
        for(const e of enemies){
          if(!e.dead && hit(b,e)){
            b.dead = true; e.hp--; boom(b.x,b.y,'#fde047');
            if(e.hp <= 0){ e.dead = true; score += 120 + level*15; boom(e.x,e.y,'#fb7185'); }
            break;
          }
        }
      }
      bullets = bullets.filter(b => !b.dead);
      enemies = enemies.filter(e => !e.dead);
      for(const b of enemyBullets){
        if(player.inv <= 0 && hit(player,b)){
          b.dead = true; lives--; player.inv = 110; boom(player.x,player.y,'#38bdf8');
          if(lives <= 0){ playing = false; over = true; menu.classList.remove('hidden'); payStatus.textContent = 'Fin de partida. Puntos: ' + score; }
        }
      }
      enemyBullets = enemyBullets.filter(b => !b.dead);
      particles.forEach(p => {p.x+=p.vx;p.y+=p.vy;p.vy+=.04;p.life--;});
      particles = particles.filter(p => p.life > 0);
      if(enemies.length === 0){ level++; spawnWave(); player.inv = 70; }
      updateHud();
    }
    function drawShip(x,y,blink){
      if(blink && Math.floor(Date.now()/90)%2) return;
      ctx.fillStyle = '#38bdf8'; ctx.beginPath(); ctx.moveTo(x,y-22); ctx.lineTo(x-18,y+18); ctx.lineTo(x,y+10); ctx.lineTo(x+18,y+18); ctx.closePath(); ctx.fill();
      ctx.fillStyle = '#facc15'; ctx.fillRect(x-5,y-4,10,14);
    }
    function draw(){
      ctx.clearRect(0,0,W,H);
      ctx.fillStyle = '#020617'; ctx.fillRect(0,0,W,H);
      stars.forEach(s => { ctx.fillStyle = s.z > 1.2 ? '#e0f2fe' : '#64748b'; ctx.fillRect(s.x,s.y,s.z*1.6,s.z*1.6); });
      ctx.strokeStyle = 'rgba(34,211,238,.18)'; for(let y=0;y<H;y+=48){ctx.beginPath();ctx.moveTo(0,y);ctx.lineTo(W,y);ctx.stroke();}
      enemies.forEach(e => {
        ctx.fillStyle = e.hp > 1 ? '#f97316' : '#a78bfa';
        ctx.beginPath(); ctx.ellipse(e.x,e.y,17,12,0,0,Math.PI*2); ctx.fill();
        ctx.fillStyle = '#22c55e'; ctx.fillRect(e.x-18,e.y+4,36,6);
        ctx.fillStyle = '#020617'; ctx.fillRect(e.x-7,e.y-3,5,5); ctx.fillRect(e.x+3,e.y-3,5,5);
      });
      ctx.fillStyle = '#f8fafc'; bullets.forEach(b => ctx.fillRect(b.x-2,b.y-8,b.w,b.h));
      ctx.fillStyle = '#fb7185'; enemyBullets.forEach(b => ctx.fillRect(b.x-3,b.y-7,b.w,b.h));
      drawShip(player.x, player.y, player.inv > 0);
      particles.forEach(p => { ctx.globalAlpha = Math.max(0,p.life/36); ctx.fillStyle=p.color; ctx.fillRect(p.x,p.y,4,4); ctx.globalAlpha=1; });
      if(!playing){
        ctx.fillStyle = 'rgba(2,6,23,.65)'; ctx.fillRect(0,0,W,H);
        ctx.fillStyle = '#facc15'; ctx.font = 'bold 34px Arial'; ctx.textAlign = 'center'; ctx.fillText(over ? 'GAME OVER' : 'READY?', W/2, H/2-42);
        ctx.fillStyle = '#e2e8f0'; ctx.font = '18px Arial'; ctx.fillText('Paga por QR o presiona JUGAR si tienes creditos', W/2, H/2);
      }
    }
    function loop(){ update(); draw(); requestAnimationFrame(loop); }
    async function buy(planIndex){
      payStatus.textContent = 'Creando pago...';
      const r = await fetch('/crear-pago',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({device_id:DEVICE_ID,tipo:'arcade',plan_index:planIndex})});
      const data = await r.json();
      if(!data.ok){ payStatus.textContent = data.error || 'No se pudo crear el pago'; return; }
      payTitle.textContent = 'Paga $' + data.monto + ' y recibes ' + data.creditos + ' credito(s)';
      qrBox.innerHTML = '';
      const qr = await fetch('/qr-data?text=' + encodeURIComponent(data.link)).then(x=>x.json());
      if(qr.ok){ qrBox.innerHTML = '<img alt="QR Mercado Pago" src="' + qr.dataUrl + '">'; }
      qrStatus.textContent = 'Escanea el QR. Se acredita automatico al aprobar.';
      payModal.classList.remove('hidden');
      clearInterval(pollTimer);
      pollTimer = setInterval(async () => {
        const claim = await fetch('/arcade/claim-payment',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({id:data.payment_id})}).then(x=>x.json());
        if(claim.ok && claim.creditos > 0){
          credits = Number(claim.creditosDisponibles ?? (credits + Number(claim.creditos || 0))); saveCredits();
          qrStatus.textContent = 'Pago aprobado. Creditos cargados.';
          payStatus.textContent = 'Creditos agregados: +' + claim.creditos;
          clearInterval(pollTimer); setTimeout(()=>payModal.classList.add('hidden'),1200);
        } else if(claim.estado && claim.estado !== 'pending'){
          qrStatus.textContent = 'Estado: ' + claim.estado;
        }
      }, 3000);
    }
    document.addEventListener('keydown', e => { keys[e.code]=true; if((e.code==='Enter'||e.code==='Space') && !playing && menu.classList.contains('hidden')===false) newGame(); });
    document.addEventListener('keyup', e => keys[e.code]=false);
    document.getElementById('startBtn').addEventListener('click', newGame);
    document.querySelectorAll('[data-plan]').forEach(btn => btn.addEventListener('click', () => buy(Number(btn.dataset.plan))));
    document.getElementById('closePay').addEventListener('click', () => { payModal.classList.add('hidden'); clearInterval(pollTimer); });
    window.addEventListener('gamepadconnected', e => { payStatus.textContent = 'Joystick conectado: ' + e.gamepad.id; });
    resetStars(); refreshCredits(); updateHud(); loop();
  })();
  </script>
</body>
</html>`);
});
// =====================================================
// PORTAL LIMITADO PARA CLIENTES
// =====================================================

function cookieSesionCliente(req, token, maxAgeSeconds) {
  const secure = req.secure || String(req.headers["x-forwarded-proto"] || "").split(",")[0].trim() === "https";
  return `evetec_client_session=${encodeURIComponent(token)}; Path=/cliente; HttpOnly; SameSite=Lax; Max-Age=${maxAgeSeconds}${secure ? "; Secure" : ""}`;
}

function cookieSesionAdmin(req, token, maxAgeSeconds) {
  const secure = req.secure || String(req.headers["x-forwarded-proto"] || "").split(",")[0].trim() === "https";
  return `evetec_admin_session=${encodeURIComponent(token)}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${maxAgeSeconds}${secure ? "; Secure" : ""}`;
}

function htmlLoginUnificado(error = "", next = "") {
  return `<!doctype html><html lang="es"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Ingresar · EVETEC</title><style>*{box-sizing:border-box}body{margin:0;min-height:100vh;display:grid;place-items:center;background:radial-gradient(circle at top,#15344b,#06111e 55%);font-family:system-ui,-apple-system,Segoe UI,sans-serif;color:#edf8ff}.login{width:min(92vw,430px);background:#0d1d2c;border:1px solid #28445d;border-radius:22px;padding:32px;box-shadow:0 30px 80px #0008}.brand{color:#39d8e7;font-weight:900;letter-spacing:.16em;font-size:13px}h1{margin:8px 0 6px;font-size:30px}p{color:#9cb2c6;margin:0 0 24px}.field{display:grid;gap:7px;margin:14px 0}label{font-size:12px;text-transform:uppercase;letter-spacing:.08em;color:#a9c1d5;font-weight:800}input{width:100%;padding:13px;border-radius:11px;border:1px solid #35516a;background:#081521;color:white;font-size:16px}button{width:100%;border:0;border-radius:11px;padding:14px;background:#35d5e4;color:#03202a;font-weight:900;font-size:15px;cursor:pointer;margin-top:8px}.error{background:#4a1d29;border:1px solid #923649;color:#ffc2ca;padding:11px;border-radius:10px;margin:15px 0}.note{font-size:12px;color:#7892a8;margin-top:16px;text-align:center}</style></head><body><main class="login"><div class="brand">EVETEC</div><h1>Acceso a la plataforma</h1><p>Usá tus credenciales. Te llevaremos automáticamente al panel que corresponda.</p>${error ? `<div class="error">${escaparHtml(error)}</div>` : ""}<form method="POST" action="/login"><input type="hidden" name="next" value="${escaparHtml(String(next || "").slice(0,200))}"><div class="field"><label>Usuario</label><input name="username" autocomplete="username" required autofocus></div><div class="field"><label>Contraseña</label><input type="password" name="password" autocomplete="current-password" required></div><button type="submit">Ingresar</button></form><div class="note">Administradores y clientes utilizan este mismo acceso.</div></main></body></html>`;
}

app.get("/login", (req, res) => {
  if (leerSesionAdmin(req)) return res.redirect("/admin");
  res.send(htmlLoginUnificado(req.query.error ? "Usuario o contraseña incorrectos." : "", req.query.next));
});

app.post("/login", (req, res) => {
  if (!CLIENT_SESSION_SECRET) return res.status(503).send("Acceso no configurado.");
  const username = normalizarUsuarioCliente(req.body.username);
  const password = String(req.body.password || "");
  if (username === "admin" && comparacionSegura(password, ADMIN_PASSWORD)) {
    const token = firmarSesionAdmin({ role: "admin", exp: Date.now() + 12 * 60 * 60 * 1000 });
    res.set("Set-Cookie", cookieSesionAdmin(req, token, 12 * 60 * 60));
    return res.redirect("/admin");
  }
  const ip = String(req.headers["x-forwarded-for"] || req.socket.remoteAddress || "").split(",")[0].trim();
  const now = Date.now();
  const attempts = clientLoginAttempts.get(ip) || { count: 0, since: now };
  if (now - attempts.since > 15 * 60 * 1000) Object.assign(attempts, { count: 0, since: now });
  if (attempts.count >= 8) return res.status(429).send("Demasiados intentos. Esperá 15 minutos.");
  const account = clientAccounts[username];
  if (!account?.active || !verificarPasswordCliente(password, account)) {
    attempts.count++;
    clientLoginAttempts.set(ip, attempts);
    return res.redirect("/login?error=1");
  }
  clientLoginAttempts.delete(ip);
  const csrf = crypto.randomBytes(18).toString("base64url");
  const token = firmarSesionCliente({ u: username, v: Number(account.sessionVersion || 1), csrf, exp: now + 12 * 60 * 60 * 1000 });
  res.set("Set-Cookie", cookieSesionCliente(req, token, 12 * 60 * 60));
  const requestedNext = String(req.body.next || "");
  res.redirect(requestedNext.startsWith("/cliente") && !requestedNext.startsWith("//") ? requestedNext : "/cliente");
});

app.get("/logout", (req, res) => {
  res.set("Set-Cookie", [cookieSesionAdmin(req, "", 0), cookieSesionCliente(req, "", 0)]);
  res.redirect("/login");
});

function payloadEstadisticasCliente(deviceId) {
  const d = asegurarDevice(deviceId);
  const usageList = eventosUsoDevice(deviceId);
  const stats = usageList.length ? statsDesdeUso(deviceId) : (d.stats || statsIniciales());
  const total = Number(stats.totalRecaudado || 0);
  const participantCount = Math.max(1, Math.min(MAX_PARTICIPANTS, Number(d.cantidadParticipantes || 1)));
  return {
    ok: true,
    online: Boolean(d.online),
    ultimaConexion: d.ultimaConexion || null,
    firmware: d.telemetria?.firmware || "Sin informar",
    ssid: d.telemetria?.ssid || "-",
    rssi: Number(d.telemetria?.rssi || 0),
    totalRecaudado: total,
    pagosAprobados: Number(stats.pagosAprobados || 0),
    segundosVendidos: Number(stats.segundosVendidos || 0),
    tiempoMotor: Number(stats.tiempoMotor || 0),
    comisionesMp: Number(stats.comisionesMp || 0),
    netoDespuesMp: Number(stats.netoDespuesMp || 0),
    tasaMpEfectiva: total > 0 ? Number(stats.comisionesMp || 0) * 100 / total : 0,
    participantTotals: stats.participantTotals || {},
    participants: d.participantes.slice(0, participantCount).filter(p => p.nombre && Number(p.porcentaje) > 0).map(p => ({ id: p.id, nombre: p.nombre, porcentaje: Number(p.porcentaje), total: Number(stats.participantTotals?.[p.id] || 0) }))
  };
}

app.get("/cliente/login", (req, res) => {
  if (leerSesionCliente(req)) return res.redirect("/cliente");
  const next = String(req.query.next || "/cliente");
  res.redirect(`/login?next=${encodeURIComponent(next)}${req.query.error ? "&error=1" : ""}`);
});

app.post("/cliente/login", (req, res) => {
  if (!CLIENT_SESSION_SECRET) return res.status(503).send("Acceso de clientes no configurado.");
  const ip = String(req.headers["x-forwarded-for"] || req.socket.remoteAddress || "").split(",")[0].trim();
  const now = Date.now();
  const attempts = clientLoginAttempts.get(ip) || { count: 0, since: now };
  if (now - attempts.since > 15 * 60 * 1000) Object.assign(attempts, { count: 0, since: now });
  if (attempts.count >= 8) return res.status(429).send("Demasiados intentos. Esperá 15 minutos.");
  const username = normalizarUsuarioCliente(req.body.username);
  const account = clientAccounts[username];
  if (!account?.active || !verificarPasswordCliente(req.body.password, account)) {
    attempts.count++;
    clientLoginAttempts.set(ip, attempts);
    return res.redirect("/cliente/login?error=1");
  }
  clientLoginAttempts.delete(ip);
  const csrf = crypto.randomBytes(18).toString("base64url");
  const token = firmarSesionCliente({ u: username, v: Number(account.sessionVersion || 1), csrf, exp: now + 12 * 60 * 60 * 1000 });
  res.set("Set-Cookie", cookieSesionCliente(req, token, 12 * 60 * 60));
  const next = String(req.body.next || "/cliente");
  res.redirect(next.startsWith("/cliente") && !next.startsWith("//") ? next : "/cliente");
});

app.use("/cliente", (req, res, next) => req.path === "/login" ? next() : requireClient(req, res, next));

app.post("/cliente/logout", verificarCsrfCliente, (req, res) => {
  res.set("Set-Cookie", cookieSesionCliente(req, "", 0));
  res.redirect("/cliente/login");
});

app.get("/cliente", (req, res) => {
  const allowedIds = req.clientAccount.deviceIds.filter(id => devices[id]);
  if (!allowedIds.length) return res.status(403).send("Esta cuenta todavía no tiene equipos asignados. Contactá a EVETEC.");
  const requested = String(req.query.device || "").trim().toUpperCase();
  const id = allowedIds.includes(requested) ? requested : allowedIds[0];
  const d = asegurarDevice(id);
  const cfg = d.tipo === "gachapon" ? configuracionGachaponDevice(id) : configuracionServicioDevice(id);
  const live = payloadEstadisticasCliente(id);
  const events = eventosUsoDevice(id).slice(-30).reverse();
  const tabs = allowedIds.map(deviceId => `<a class="tab ${deviceId === id ? "active" : ""}" href="/cliente?device=${encodeURIComponent(deviceId)}"><i class="${devices[deviceId].online ? "on" : ""}"></i><span>${escaparHtml(nombreVisibleDevice(deviceId) || deviceId)}</span><small>${escaparHtml(deviceId)}</small></a>`).join("");
  const participantCards = live.participants.map(p => `<div class="card stat"><span>${escaparHtml(p.nombre)} · ${p.porcentaje.toLocaleString("es-AR", {maximumFractionDigits:2})}%</span><b data-participant="${escaparHtml(p.id)}">$${formatoDinero(p.total)}</b><small>neto acumulado, comisión MP proporcional</small></div>`).join("");
  const configForm = d.tipo === "gachapon" ? `<h2>Precios y tiempo</h2><p class="muted">El modo de funcionamiento y la cantidad de opciones los administra EVETEC.</p><form method="POST" action="/cliente/device/${encodeURIComponent(id)}/update"><input type="hidden" name="csrf" value="${escaparHtml(req.clientCsrf)}"><div class="grid"><label>Segundos por jugada<input name="segundosPorJugada" type="number" min="1" max="600" step="1" value="${Number(cfg.segundos_por_jugada || 30)}" required></label>${cfg.planes.slice(0, Number(cfg.cantidad_opciones || 3)).map((plan,index)=>`<label>Precio · ${index+1} jugada${index ? "s" : ""}<input name="monto${index}" type="number" min="1" step="0.01" value="${Number(plan.monto)}" required></label>`).join("")}</div><button>Guardar precios y tiempo</button></form>` : `<h2>Precio y duración</h2><form method="POST" action="/cliente/device/${encodeURIComponent(id)}/update"><input type="hidden" name="csrf" value="${escaparHtml(req.clientCsrf)}"><div class="grid"><label>Precio (ARS)<input name="monto" type="number" min="1" step="0.01" value="${Number(cfg.monto)}" required></label><label>Minutos<input name="minutos" type="number" min="0" max="60" value="${Math.floor(Number(cfg.segundos)/60)}" required></label><label>Segundos<input name="segundosServicio" type="number" min="0" max="59" value="${Number(cfg.segundos)%60}" required></label></div><button>Guardar precio y duración</button></form>`;
  const rows = events.map(e => `<tr><td>${e.approved_epoch ? new Date(Number(e.approved_epoch)*1000).toLocaleString("es-AR") : "-"}</td><td>$${formatoDinero(Number(e.amount_cents||0)/100)}</td><td>$${formatoDinero(Number(e.mp_fee_cents||0)/100)}</td><td>${formatoTiempo(e.sold_seconds)}</td><td>${formatoTiempo(e.actual_seconds)}</td><td>${e.completed === false ? "Interrumpido" : "Completado"}</td></tr>`).join("");
  res.set("Cache-Control", "no-store");
  res.send(`<!doctype html><html lang="es"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${escaparHtml(cfg.nombre)} · EVETEC</title><style>:root{--bg:#06111e;--panel:#0d1d2c;--line:#29445c;--cyan:#35d5e4;--muted:#9bb1c4;--green:#31d17c;--yellow:#ffc84b}*{box-sizing:border-box}body{margin:0;background:linear-gradient(145deg,#071522,#04101b);color:#edf8ff;font-family:system-ui,-apple-system,Segoe UI,sans-serif}main{max-width:1220px;margin:auto;padding:22px}.top{display:flex;justify-content:space-between;gap:16px;align-items:center;margin:18px 0}.brand{color:var(--cyan);font-size:12px;font-weight:900;letter-spacing:.16em}h1{margin:4px 0;font-size:clamp(26px,4vw,42px)}h2{margin-top:0}.muted,small{color:var(--muted)}.status{padding:10px 14px;border:1px solid var(--line);border-radius:999px;font-weight:800}.status i,.tab i{display:inline-block;width:9px;height:9px;border-radius:50%;background:#e95064;margin-right:7px}.status i.on,.tab i.on{background:var(--green);box-shadow:0 0 10px var(--green)}.tabs{display:flex;gap:9px;overflow:auto}.tab{min-width:190px;padding:12px;border:1px solid var(--line);border-radius:13px;color:white;text-decoration:none;display:grid;grid-template-columns:14px 1fr}.tab small{grid-column:2}.tab.active{border-color:var(--cyan);background:#113047}.stats{display:grid;grid-template-columns:repeat(4,1fr);gap:13px;margin:18px 0}.card{background:var(--panel);border:1px solid var(--line);border-radius:17px;padding:20px}.stat span{display:block;color:#a9c2d6;text-transform:uppercase;font-size:11px;font-weight:850;letter-spacing:.07em}.stat b{font-size:28px;display:block;margin:8px 0}.columns{display:grid;grid-template-columns:1.2fr .8fr;gap:14px}.grid{display:grid;grid-template-columns:repeat(3,1fr);gap:11px}label{display:grid;gap:7px;color:#a9c2d6;font-size:12px;text-transform:uppercase;font-weight:800}input{padding:12px;border-radius:10px;border:1px solid #35516a;background:#071522;color:white;font-size:17px}button{border:0;border-radius:10px;padding:12px 16px;background:var(--cyan);color:#03202a;font-weight:900;cursor:pointer;margin-top:14px}.readonly{display:flex;justify-content:space-between;gap:10px;border-bottom:1px solid var(--line);padding:10px 0}.table{overflow:auto;margin-top:14px}table{width:100%;border-collapse:collapse}th,td{text-align:left;padding:11px;border-bottom:1px solid var(--line);white-space:nowrap}th{color:var(--muted);font-size:11px;text-transform:uppercase}.logout{background:transparent;color:#bcd0df;border:1px solid var(--line);margin:0}@media(max-width:850px){.stats{grid-template-columns:repeat(2,1fr)}.columns{grid-template-columns:1fr}}@media(max-width:560px){main{padding:14px}.top{align-items:flex-start}.grid{grid-template-columns:1fr}.stats{gap:8px}.card{padding:15px}}</style></head><body><main><div class="tabs">${tabs}</div><header class="top"><div><div class="brand">EVETEC · PORTAL DEL CLIENTE</div><h1>${escaparHtml(cfg.nombre)}</h1><div class="muted">${escaparHtml(req.clientAccount.displayName)} · ${escaparHtml(id)}</div></div><form method="POST" action="/cliente/logout"><input type="hidden" name="csrf" value="${escaparHtml(req.clientCsrf)}"><button class="logout">Salir</button></form></header><div class="status"><i id="online-dot" class="${live.online ? "on" : ""}"></i><span id="online-label">${live.online ? "Equipo online" : "Equipo offline"}</span></div><section class="stats"><div class="card stat"><span>Recaudado</span><b id="total">$${formatoDinero(live.totalRecaudado)}</b></div><div class="card stat"><span>Pagos aprobados</span><b id="payments">${live.pagosAprobados}</b></div><div class="card stat"><span>Tiempo vendido</span><b id="sold">${formatoTiempo(live.segundosVendidos)}</b></div><div class="card stat"><span>Uso real</span><b id="used">${formatoTiempo(live.tiempoMotor)}</b></div>${participantCards}<div class="card stat"><span>Comisión MP real</span><b id="fees">$${formatoDinero(live.comisionesMp)}</b></div><div class="card stat"><span>Tasa efectiva MP</span><b id="rate">${live.tasaMpEfectiva.toLocaleString("es-AR",{minimumFractionDigits:2,maximumFractionDigits:2})}%</b></div><div class="card stat"><span>Neto tras MP</span><b id="net">$${formatoDinero(live.netoDespuesMp)}</b></div></section><section class="columns"><div class="card">${configForm}</div><aside class="card"><h2>Estado del equipo</h2><div class="readonly"><span>Última conexión</span><b id="last-seen">${live.ultimaConexion ? new Date(live.ultimaConexion).toLocaleString("es-AR") : "Nunca"}</b></div><div class="readonly"><span>Firmware</span><b>${escaparHtml(live.firmware)}</b></div><div class="readonly"><span>WiFi / señal</span><b>${escaparHtml(live.ssid)} ${live.rssi ? `(${live.rssi} dBm)` : ""}</b></div><div class="readonly"><span>Reparto</span><b>Solo lectura</b></div><p class="muted">Los porcentajes, vinculaciones y la cuenta receptora son administrados por EVETEC. Las cifras reflejan los pagos confirmados y sincronizados.</p></aside></section><section class="card" style="margin-top:14px"><h2>Servicios confirmados</h2><div class="table"><table><thead><tr><th>Fecha</th><th>Monto</th><th>Comisión MP</th><th>Vendido</th><th>Uso real</th><th>Estado</th></tr></thead><tbody>${rows || `<tr><td colspan="6">Todavía no hay servicios registrados.</td></tr>`}</tbody></table></div></section><script>const money=n=>'$'+Number(n||0).toLocaleString('es-AR',{maximumFractionDigits:2});const time=n=>{n=Number(n||0);const h=Math.floor(n/3600),m=Math.floor(n%3600/60),s=n%60;return h?h+'h '+m+'m':m?m+'m '+s+'s':s+'s'};async function refresh(){try{const r=await fetch('/cliente/device/${encodeURIComponent(id)}/live-stats',{cache:'no-store'});if(!r.ok)return;const x=await r.json();document.getElementById('online-dot').classList.toggle('on',x.online);document.getElementById('online-label').textContent=x.online?'Equipo online':'Equipo offline';document.getElementById('total').textContent=money(x.totalRecaudado);document.getElementById('payments').textContent=x.pagosAprobados;document.getElementById('sold').textContent=time(x.segundosVendidos);document.getElementById('used').textContent=time(x.tiempoMotor);document.getElementById('fees').textContent=money(x.comisionesMp);document.getElementById('net').textContent=money(x.netoDespuesMp);document.getElementById('rate').textContent=Number(x.tasaMpEfectiva).toLocaleString('es-AR',{minimumFractionDigits:2,maximumFractionDigits:2})+'%';document.getElementById('last-seen').textContent=x.ultimaConexion?new Date(x.ultimaConexion).toLocaleString('es-AR'):'Nunca';document.querySelectorAll('[data-participant]').forEach(el=>el.textContent=money(x.participantTotals[el.dataset.participant]||0))}catch(_){}}setInterval(refresh,5000)</script></main></body></html>`);
});

app.get("/cliente/device/:deviceId/live-stats", (req, res) => {
  const id = String(req.params.deviceId || "").trim().toUpperCase();
  if (!req.clientAccount.deviceIds.includes(id) || !devices[id]) return res.status(403).json({ ok: false, error: "device_forbidden" });
  res.set("Cache-Control", "no-store");
  res.json(payloadEstadisticasCliente(id));
});

app.post("/cliente/device/:deviceId/update", verificarCsrfCliente, (req, res) => {
  const id = String(req.params.deviceId || "").trim().toUpperCase();
  if (!req.clientAccount.deviceIds.includes(id) || !devices[id]) return res.status(403).send("Equipo no autorizado.");
  const d = asegurarDevice(id);
  if (d.tipo === "gachapon") {
    const cfg = configuracionGachaponDevice(id);
    const seconds = Number(req.body.segundosPorJugada);
    if (Number.isFinite(seconds)) cfg.segundos_por_jugada = Math.max(1, Math.min(600, Math.round(seconds)));
    for (let index = 0; index < Number(cfg.cantidad_opciones || 3); index++) {
      const amount = Number(req.body[`monto${index}`]);
      if (Number.isFinite(amount) && amount > 0) cfg.planes[index].monto = Math.round(amount * 100) / 100;
    }
  } else {
    const cfg = configuracionServicioDevice(id);
    const amount = Number(req.body.monto);
    const minutes = Number(req.body.minutos);
    const seconds = Number(req.body.segundosServicio);
    if (Number.isFinite(amount) && amount > 0) cfg.monto = Math.round(amount * 100) / 100;
    if (Number.isFinite(minutes) && Number.isFinite(seconds)) cfg.segundos = Math.max(1, Math.min(3600, Math.round(Math.max(0, Math.min(60, minutes))) * 60 + Math.round(Math.max(0, Math.min(59, seconds)))));
  }
  guardarDatos();
  res.redirect(`/cliente?device=${encodeURIComponent(id)}`);
});

// =====================================================
// ADMIN
// =====================================================

app.get("/", (req, res) => {
  res.redirect("/login");
});

app.get("/admin", (req, res) => {
  const requestedId = String(req.query.device || "").trim().toUpperCase();
  const deviceIds = Object.keys(devices).sort();
  const id = requestedId && devices[requestedId] ? requestedId : (devices[PROTOTYPE_DEVICE_ID] ? PROTOTYPE_DEVICE_ID : deviceIds[0]);
  const d = asegurarDevice(id);
  const cfg = d.tipo === "gachapon" ? configuracionGachaponDevice(id) : configuracionServicioDevice(id);
  const usageList = eventosUsoDevice(id);
  const stats = usageList.length ? statsDesdeUso(id) : (d.stats || statsIniciales());
  const ultimoPago = stats.ultimosPagos?.[0] || null;
  const ultimaConexion = d.ultimaConexion
    ? new Date(d.ultimaConexion).toLocaleString("es-AR")
    : "Nunca";
  const pagos = usageList.slice(-30).reverse();
  const backupConfirmedCount = Math.max(0, Number(d.backupConfirmedCount || 0));
  const paymentsSinceBackup = Math.max(0, usageList.length - backupConfirmedCount);
  const backupDue = paymentsSinceBackup >= 4000;
  const backupProgress = Math.min(100, (paymentsSinceBackup / 4000) * 100);
  const distributionError = String(req.query.dist_error || "");
  const participantCount = Math.max(1, Math.min(MAX_PARTICIPANTS, Number(d.cantidadParticipantes || 1)));
  const chargingParticipant = participantePrincipalParaCobro(d);
  const externalAccountReady = cuentaExternaLista(d);
  const paymentAccountReady = d.modoCobro === "evetec" ? Boolean(EVETEC_MP_TOKEN) : externalAccountReady;
  const paymentAccountName = d.modoCobro === "evetec"
    ? "EVETEC"
    : (chargingParticipant?.nombre || (d.ownerLinked ? "Cuenta dueña" : "Sin asignar"));
  const paymentAccountUserId = chargingParticipant?.userId || d.ownerUserId || null;
  const paymentAccountEmail = chargingParticipant?.email || d.ownerEmail || "";
  const participantRows = d.participantes.map((p, index) => {
    const linked = Boolean(p.linked && p.accessToken);
    const pending = index > 0 && d.participantLinkRequest?.participantId === p.id;
    const invitationUrl = pending && d.participantLinkRequest?.shareToken
      ? `${PUBLIC_BASE_URL}/vincular/${encodeURIComponent(id)}/${encodeURIComponent(p.id)}/${encodeURIComponent(d.participantLinkRequest.shareToken)}`
      : "";
    const accountControls = index === 0
      ? `<span class="pill ${EVETEC_MP_TOKEN ? "success" : "warning"}">${EVETEC_MP_TOKEN ? "Cuenta base lista" : "Falta credencial"}</span>`
      : `${pending
          ? `<span class="pill warning">QR pendiente: ${escaparHtml(d.participantLinkRequest.alias || p.nombre || p.id)}</span>`
          : `<span class="pill ${linked ? "success" : "muted"}">${linked ? "Cuenta vinculada" : "Sin vincular"}</span>`}
        <button class="mini-btn" type="button" data-participant-link="${p.id}">${pending ? "Reemplazar QR" : (linked ? "Cambiar cuenta" : "Generar QR")}</button>
        ${pending && invitationUrl ? `<button class="mini-btn" type="button" data-participant-share="${escaparHtml(invitationUrl)}">Copiar / enviar enlace</button>` : ""}
        ${pending ? `<button class="mini-btn danger-mini" type="button" data-participant-cancel="${p.id}">Cancelar QR</button>` : ""}
        ${linked ? `<button class="mini-btn danger-mini" type="button" data-participant-unlink="${p.id}">Desvincular cuenta</button>` : ""}`;
    return `
      <div class="participant-row" data-participant-row="${index + 1}" ${index >= participantCount ? "hidden" : ""}>
        <span class="participant-number">${index + 1}</span>
        <input name="participant_name_${index + 1}" maxlength="40" placeholder="Nombre del coparticipante" value="${escaparHtml(index === 0 ? "EVETEC" : p.nombre)}" ${index === 0 ? "readonly aria-label=\"EVETEC, participante fijo\"" : ""}>
        <div class="percent-input"><input name="participant_pct_${index + 1}" type="number" min="0" max="100" step="0.01" value="${Number(p.porcentaje)}"><span>%</span></div>
        <b>$${formatoDinero(Number(stats.participantTotals?.[p.id] || 0))}</b>
        <div class="participant-account">${accountControls}</div>
      </div>`;
  }).join("");
  const activeParticipantStats = d.participantes
    .slice(0, participantCount)
    .filter(participant => participant.nombre && Number(participant.porcentaje) > 0);
  const participantStatCards = activeParticipantStats.map(participant => `
      <div class="card stat"><span class="label">Ganancia ${escaparHtml(participant.nombre)}</span><b data-participant-total="${escaparHtml(participant.id)}">$${formatoDinero(Number(stats.participantTotals?.[participant.id] || 0))}</b><small>${Number(participant.porcentaje).toLocaleString("es-AR", { maximumFractionDigits: 2 })}% · comisión MP proporcional</small></div>`).join("");
  const mpEffectiveRate = Number(stats.totalRecaudado || 0) > 0
    ? Number(stats.comisionesMp || 0) * 100 / Number(stats.totalRecaudado || 0)
    : 0;
  const deviceTabs = deviceIds.map(deviceId => {
    const tabDevice = asegurarDevice(deviceId);
    return `<a class="device-tab ${deviceId === id ? "active" : ""}" href="/admin?device=${encodeURIComponent(deviceId)}"><span class="tab-dot ${tabDevice.online ? "online-dot" : ""}"></span><span>${escaparHtml(nombreVisibleDevice(deviceId) || deviceId)}</span><small>${escaparHtml(deviceId)}</small></a>`;
  }).join("");
  const clientAccountRows = Object.values(clientAccounts).sort((a, b) => a.displayName.localeCompare(b.displayName)).map(account => `
    <tr>
      <td><b>${escaparHtml(account.displayName)}</b><br><span class="hint">${escaparHtml(account.username)}</span></td>
      <td>${account.deviceIds.map(deviceId => `<span class="pill muted">${escaparHtml(devices[deviceId] ? (nombreVisibleDevice(deviceId) || deviceId) : deviceId)}</span>`).join(" ") || "Sin equipos"}</td>
      <td><span class="pill ${account.active ? "success" : "warning"}">${account.active ? "Habilitado" : "Suspendido"}</span></td>
      <td><button class="mini-btn" type="button" data-client-edit="${escaparHtml(account.username)}" data-client-name="${escaparHtml(account.displayName)}" data-client-devices="${escaparHtml(account.deviceIds.join(","))}">Editar / clave nueva</button><form method="POST" action="/admin/client-account/toggle" style="display:inline"><input type="hidden" name="username" value="${escaparHtml(account.username)}"><button class="mini-btn ${account.active ? "danger-mini" : ""}" type="submit">${account.active ? "Suspender" : "Habilitar"}</button></form></td>
    </tr>`).join("");

  let pagosHtml = pagos.map(p => `
    <tr>
      <td>${escaparHtml(p.approved_epoch ? new Date(Number(p.approved_epoch) * 1000).toLocaleString("es-AR") : "Sin fecha")}</td>
      <td>${escaparHtml(p.payment_id || p.event_id || "-")}</td>
      <td>$${formatoDinero(Number(p.amount_cents || 0) / 100)}</td>
      <td>$${formatoDinero(Number(p.mp_fee_cents || 0) / 100)}</td>
      <td>${Number(p.amount_cents || 0) > 0 ? (Number(p.mp_fee_cents || 0) * 100 / Number(p.amount_cents)).toLocaleString("es-AR", { minimumFractionDigits: 2, maximumFractionDigits: 2 }) : "0,00"}%</td>
      <td>$${formatoDinero((Number(p.amount_cents || 0) - Number(p.mp_fee_cents || 0)) / 100)}</td>
      <td>${formatoTiempo(p.sold_seconds)}</td>
      <td>${formatoTiempo(p.actual_seconds)}</td>
      <td><span class="pill ${p.completed === false ? "warning" : "success"}">${p.completed === false ? "Interrumpido" : "Completado"}</span></td>
    </tr>
  `).join("");

  if (!pagosHtml) pagosHtml = `<tr><td colspan="9" class="empty">Todavía no hay servicios sincronizados desde este equipo.</td></tr>`;

  const serviceConfigHtml = d.tipo === "gachapon" ? `
        <h2>Configuración de la máquina de peluches</h2>
        <form method="POST" action="/admin/device/${encodeURIComponent(id)}/update">
          <div class="switches">
            <label class="check"><input type="checkbox" name="activo" ${d.activo && cfg.activo ? "checked" : ""}> Equipo habilitado</label>
            <label class="check"><input type="checkbox" name="mantenimiento" ${d.modoMantenimiento ? "checked" : ""}> Modo mantenimiento</label>
          </div>
          <div class="form-grid">
            <div class="field wide"><label>Nombre visible y de la pestaña</label><input name="nombre" value="${escaparHtml(cfg.nombre)}" maxlength="60" required></div>
            <div class="field"><label>Opciones visibles</label><select name="cantidadOpciones">${[1,2,3].map(n => `<option value="${n}" ${Number(cfg.cantidad_opciones || 3) === n ? "selected" : ""}>${n} opción${n > 1 ? "es" : ""}</option>`).join("")}</select></div>
            <div class="field"><label>Funcionamiento del relé</label><select name="modoActivacion"><option value="tiempo" ${cfg.modo_activacion !== "pulsos" ? "selected" : ""}>Tiempo por jugada + botón START</option><option value="pulsos" ${cfg.modo_activacion === "pulsos" ? "selected" : ""}>Pulsos automáticos para cargar créditos</option></select></div>
            <div class="field"><label>Segundos encendido por jugada</label><input name="segundosPorJugada" type="number" min="1" max="600" step="1" value="${Number(cfg.segundos_por_jugada || 30)}" required></div>
            <div class="field"><label>Duración de cada pulso (ms)</label><input name="pulsoMotorMs" type="number" min="100" max="10000" step="50" value="${Number(cfg.pulso_motor_ms || 500)}" required></div>
            <div class="field"><label>Pausa entre pulsos (ms)</label><input name="pausaPremiosMs" type="number" min="0" max="10000" step="50" value="${Number(cfg.pausa_premios_ms || 650)}" required></div>
            <div class="field"><label>Título en pantalla</label><input name="titulo" value="${escaparHtml(cfg.titulo || "ATRAPÁ TU PELUCHE")}" maxlength="40"></div>
            <div class="field wide"><label>Mensaje</label><input name="mensaje" value="${escaparHtml(cfg.mensaje || "Elegí tus jugadas y pagá con QR")}" maxlength="100"></div>
          </div>
          <h3>Precios por cantidad de jugadas</h3>
          <div class="plan-grid">${[0,1,2].map(index => { const p = cfg.planes[index]; return `<div class="plan-card"><b>${index + 1} jugada${index ? "s" : ""}</b><label>Precio (ARS)<input name="monto${index}" type="number" min="1" step="0.01" value="${Number(p.monto)}" required></label><label>Texto breve<input name="etiqueta${index}" value="${escaparHtml(p.etiqueta || "Elegir y pagar")}" maxlength="28"></label></div>`; }).join("")}</div>
          <p class="hint"><b>Tiempo por jugada:</b> el pago deja créditos disponibles; cada START consume uno y mantiene el relé encendido durante los segundos indicados. <b>Pulsos:</b> el pago envía automáticamente un pulso por crédito para que la electrónica original administre las partidas.</p>
          <div class="actions"><button class="btn primary" type="submit">Guardar cambios</button></div>
        </form>` : `
        <h2>Configuración del servicio</h2>
        <form method="POST" action="/admin/device/${encodeURIComponent(id)}/update">
          <div class="switches">
            <label class="check"><input type="checkbox" name="activo" ${d.activo && cfg.activo ? "checked" : ""}> Equipo habilitado</label>
            <label class="check"><input type="checkbox" name="mantenimiento" ${d.modoMantenimiento ? "checked" : ""}> Modo mantenimiento</label>
            <label class="check"><input type="checkbox" name="preinicioHabilitado" ${cfg.preinicioHabilitado !== false ? "checked" : ""}> Espera antes de encender</label>
          </div>
          <div class="form-grid">
            <div class="field wide"><label>Nombre visible</label><input name="nombre" value="${escaparHtml(cfg.nombre)}" maxlength="60" required></div>
            <div class="field"><label>Precio (ARS)</label><input name="monto" type="number" min="1" step="0.01" value="${Number(cfg.monto)}" required></div>
            <div class="field"><label>Duración: minutos</label><input name="minutos" type="number" min="0" max="60" value="${Math.floor(Number(cfg.segundos) / 60)}" required></div>
            <div class="field"><label>Duración: segundos</label><input name="segundosServicio" type="number" min="0" max="59" value="${Number(cfg.segundos) % 60}" required></div>
            <div class="field"><label>Espera antes de encender (segundos)</label><input name="preinicioSegundos" type="number" min="0" max="120" value="${Number(cfg.preinicioSegundos)}" required></div>
            <div class="field wide"><label>Descripción</label><input name="descripcion" value="${escaparHtml(cfg.descripcion)}" maxlength="120"></div>
          </div>
          <div class="actions"><button class="btn primary" type="submit">Guardar cambios</button></div>
        </form>`;

  res.send(`<!doctype html>
  <html lang="es">
  <head>
    <meta charset="utf-8">
    <meta name="viewport" content="width=device-width, initial-scale=1">
    <title>EVETEC | Gestión de módulos</title>
    <style>
      :root{color-scheme:dark;--bg:#07111f;--panel:#101d2d;--panel2:#142438;--line:#263a50;--text:#f4f8fb;--muted:#91a4b7;--cyan:#27d3e2;--green:#38d987;--red:#ff6474;--yellow:#ffc857}
      *{box-sizing:border-box}[hidden]{display:none!important}body{margin:0;background:radial-gradient(circle at 80% 0,#12324a 0,transparent 34%),var(--bg);color:var(--text);font:15px Inter,Segoe UI,Arial,sans-serif}
      main{width:min(1120px,calc(100% - 32px));margin:auto;padding:34px 0 60px}.top{display:flex;justify-content:space-between;gap:24px;align-items:center;margin-bottom:24px}
      .brand{font-size:13px;letter-spacing:.22em;color:var(--cyan);font-weight:800}.top h1{margin:7px 0 5px;font-size:clamp(27px,4vw,42px)}.sub,.hint{color:var(--muted)}
      .status{display:flex;align-items:center;gap:9px;background:var(--panel);border:1px solid var(--line);border-radius:999px;padding:10px 15px;font-weight:700}.dot{width:9px;height:9px;border-radius:50%;background:${d.online ? "var(--green)" : "var(--red)"};box-shadow:0 0 12px currentColor}
      .stats,.columns{display:grid;gap:16px}.stats{grid-template-columns:repeat(4,1fr);margin-bottom:16px}.columns{grid-template-columns:1.25fr .75fr}.card{background:linear-gradient(145deg,var(--panel),#0c1826);border:1px solid var(--line);border-radius:18px;padding:22px;box-shadow:0 16px 45px #0004}.stat b{display:block;font-size:25px;margin-top:8px}.stat small{display:block;margin-top:8px;color:var(--muted);font-size:11px}.label{font-size:12px;text-transform:uppercase;letter-spacing:.1em;color:var(--muted);font-weight:700}
      h2{margin:0 0 18px;font-size:20px}h3{margin:25px 0 12px;color:var(--cyan);font-size:14px;text-transform:uppercase;letter-spacing:.08em}.form-grid{display:grid;grid-template-columns:repeat(2,1fr);gap:15px}.field{display:flex;flex-direction:column;gap:7px}.wide{grid-column:1/-1}label{font-weight:650}input,select{width:100%;background:#091522;color:var(--text);border:1px solid var(--line);border-radius:10px;padding:11px 12px;font:inherit;outline:none}input:focus,select:focus{border-color:var(--cyan)}
      .switches{display:flex;flex-wrap:wrap;gap:12px;margin-bottom:20px}.check{display:flex;align-items:center;gap:9px;background:var(--panel2);border:1px solid var(--line);border-radius:10px;padding:11px 13px}.check input{width:auto;margin:0}.actions{display:flex;flex-wrap:wrap;gap:9px;margin-top:20px}.btn{display:inline-flex;align-items:center;justify-content:center;border:0;border-radius:10px;padding:11px 15px;text-decoration:none;font-weight:800;cursor:pointer}.primary{background:var(--cyan);color:#03141a}.secondary{background:#20344a;color:var(--text);border:1px solid #34506d}.danger{background:#421d29;color:#ffb3bc;border:1px solid #7b3041}
      .owner{background:var(--panel2);border:1px solid var(--line);border-radius:14px;padding:16px}.owner-line{display:flex;justify-content:space-between;gap:12px;margin:8px 0}.pill{display:inline-block;border-radius:999px;padding:4px 9px;font-size:12px;font-weight:800}.success{background:#123d2d;color:#70f0ad}.muted{background:#293746;color:#b9c7d5}.warning{background:#493b18;color:#ffe08a}
      .backup{margin-bottom:16px;border-color:${backupDue ? "var(--yellow)" : "var(--line)"};background:${backupDue ? "linear-gradient(145deg,#352c14,#171b20)" : "linear-gradient(145deg,var(--panel),#0c1826)"}}.backup-head{display:flex;justify-content:space-between;align-items:flex-start;gap:18px}.backup h2{margin-bottom:7px}.progress{height:10px;border-radius:999px;background:#07111f;overflow:hidden;margin-top:16px}.progress span{display:block;height:100%;width:${backupProgress}%;background:${backupDue ? "var(--yellow)" : "var(--cyan)"};border-radius:inherit}.backup-alert{color:var(--yellow);font-weight:850}
      .test-mode{display:flex;justify-content:space-between;align-items:center;gap:20px;margin-bottom:16px;border-color:${d.registroVentasHabilitado !== false ? "#216846" : "var(--yellow)"};background:${d.registroVentasHabilitado !== false ? "linear-gradient(145deg,#102a22,#0c1826)" : "linear-gradient(145deg,#352c14,#171b20)"}}.test-mode h2{margin-bottom:6px}.test-mode form{flex:0 0 auto}.test-mode .btn{min-width:210px}@media(max-width:650px){.test-mode{align-items:stretch;flex-direction:column}.test-mode form,.test-mode .btn{width:100%}}
      .distribution{margin-bottom:16px}.participant-head,.participant-row{display:grid;grid-template-columns:34px minmax(150px,1fr) 120px 125px minmax(190px,auto);gap:10px;align-items:center}.participant-head{color:var(--muted);font-size:11px;text-transform:uppercase;font-weight:800;padding:0 0 7px}.participant-row{margin:8px 0}.participant-number{width:28px;height:28px;display:grid;place-items:center;border-radius:50%;background:var(--panel2);color:var(--cyan);font-weight:900}.percent-input{position:relative}.percent-input input{padding-right:32px}.percent-input span{position:absolute;right:12px;top:12px;color:var(--muted)}.distribution-note{border-left:3px solid var(--yellow);padding:10px 13px;margin-top:17px;background:#493b1833;color:#ffe7a7}.form-error{background:#4d1d26;border:1px solid #8f3445;color:#ffc1c8;padding:12px;border-radius:10px;margin-bottom:14px}.participant-account{display:flex;align-items:center;gap:6px;flex-wrap:wrap}.mini-btn{border:1px solid #34506d;background:#20344a;color:var(--text);padding:7px 9px;border-radius:8px;font-weight:750;cursor:pointer}.danger-mini{background:#421d29;color:#ffb3bc;border-color:#7b3041}
      .device-tabs{display:flex;gap:10px;overflow:auto;margin:0 0 18px;padding:3px}.device-tab{min-width:205px;display:grid;grid-template-columns:10px 1fr;gap:2px 9px;align-items:center;padding:12px 14px;border:1px solid var(--line);border-radius:13px;background:#0b1725;color:var(--text);text-decoration:none}.device-tab.active{border-color:var(--cyan);background:#123047;box-shadow:0 0 0 1px #27d3e244}.device-tab small{grid-column:2;color:var(--muted);font-size:10px}.tab-dot{width:8px;height:8px;border-radius:50%;background:var(--red)}.online-dot{background:var(--green);box-shadow:0 0 9px var(--green)}.participant-picker{display:flex;align-items:center;justify-content:space-between;gap:16px;background:var(--panel2);padding:14px;border-radius:12px;margin:16px 0}.participant-picker select{width:150px}.mp-rate{color:var(--yellow)!important}.country-note{margin-top:16px;padding:14px;border:1px solid #31516c;border-radius:12px;background:#0a2032}.country-note b{color:var(--cyan)}
      details.module-add{margin-top:16px}details.module-add summary{cursor:pointer;font-weight:800;color:var(--cyan)}.new-device-form{display:grid;grid-template-columns:1fr 180px auto;gap:10px;margin-top:16px;align-items:end}
      .plan-grid{display:grid;grid-template-columns:repeat(3,1fr);gap:10px}.plan-card{display:flex;flex-direction:column;gap:10px;padding:14px;border:1px solid var(--line);border-radius:13px;background:var(--panel2)}.plan-card>b{color:var(--cyan);font-size:16px}.plan-card label{display:flex;flex-direction:column;gap:6px;font-size:12px;color:var(--muted)}
      table{width:100%;border-collapse:collapse}th,td{padding:12px 10px;border-bottom:1px solid var(--line);text-align:left}th{color:var(--muted);font-size:12px;text-transform:uppercase}.table-wrap{overflow:auto}.empty{text-align:center;color:var(--muted);padding:25px}.footer{margin-top:14px;color:var(--muted);font-size:12px}
      @media(max-width:900px){.stats{grid-template-columns:repeat(2,1fr)}.columns{grid-template-columns:1fr}.top{align-items:flex-start;flex-direction:column}.participant-head{display:none}.participant-row{grid-template-columns:34px 1fr 110px}.participant-row>b,.participant-account{grid-column:2/-1}.new-device-form{grid-template-columns:1fr}}@media(max-width:650px){.plan-grid{grid-template-columns:1fr}}@media(max-width:520px){.form-grid{grid-template-columns:1fr}.wide{grid-column:auto}.stats{grid-template-columns:1fr 1fr}.card{padding:17px}.participant-row{grid-template-columns:30px 1fr}.percent-input,.participant-row>b,.participant-account{grid-column:2}}
    </style>
  </head>
  <body><main>
    <nav class="device-tabs" aria-label="Módulos">${deviceTabs}</nav>
    <header class="top">
      <div><div class="brand">EVETEC AUTOMOTIVE</div><h1>${escaparHtml(cfg.nombre || "Equipo QR")}</h1><div class="sub">Panel independiente del módulo <b>${id}</b></div></div>
      <div class="actions"><div class="status"><span class="dot"></span>${d.online ? "Equipo online" : "Equipo offline"}</div><a class="btn secondary" href="/logout">Cerrar sesión</a></div>
    </header>

    <section class="card test-mode">
      <div><h2>${d.registroVentasHabilitado !== false ? "Registro de ventas activo" : "Modo prueba activo"}</h2><div class="${d.registroVentasHabilitado !== false ? "hint" : "backup-alert"}">${d.registroVentasHabilitado !== false ? "Los próximos pagos aprobados sumarán ganancias, usos y respaldo." : "Los próximos cobros accionarán el equipo, pero no se guardarán como ventas ni usos reales."}</div></div>
      <form method="POST" action="/admin/device/${encodeURIComponent(id)}/toggle-sales-log"><button class="btn ${d.registroVentasHabilitado !== false ? "danger" : "primary"}" type="submit">${d.registroVentasHabilitado !== false ? "Activar modo prueba" : "Reactivar ventas reales"}</button></form>
    </section>

    <section class="card backup">
      <div class="backup-head"><div><h2>${backupDue ? "Respaldo externo requerido" : "Respaldo local del equipo"}</h2><div class="${backupDue ? "backup-alert" : "hint"}">${backupDue ? `Ya se acumularon ${paymentsSinceBackup} pagos desde el ultimo respaldo. Descarga el CSV y confirmalo.` : `${paymentsSinceBackup} de 4.000 pagos para el proximo aviso de respaldo.`}</div></div><span class="pill ${backupDue ? "warning" : "success"}">${usageList.length} guardados</span></div>
      <div class="progress"><span></span></div>
      <div class="actions"><a class="btn secondary" href="/admin/device/${encodeURIComponent(id)}/usage-backup.csv">Descargar respaldo CSV</a>${backupDue ? `<form method="POST" action="/admin/device/${encodeURIComponent(id)}/backup-confirm"><button class="btn primary" type="submit">Marcar respaldo realizado</button></form>` : ""}</div>
    </section>

    <section class="stats">
      <div class="card stat"><span class="label">Recaudado</span><b>$${formatoDinero(stats.totalRecaudado)}</b></div>
      <div class="card stat"><span class="label">Pagos aprobados</span><b>${stats.pagosAprobados || 0}</b></div>
      <div class="card stat"><span class="label">Tiempo vendido</span><b>${formatoTiempo(stats.segundosVendidos)}</b></div>
      <div class="card stat"><span class="label">Uso real</span><b>${formatoTiempo(stats.tiempoMotor)}</b></div>
      ${participantStatCards}
      <div class="card stat"><span class="label">Comisión MP real</span><b id="mp-fees">$${formatoDinero(stats.comisionesMp)}</b></div>
      <div class="card stat"><span class="label">Tasa efectiva MP</span><b class="mp-rate" id="mp-rate">${mpEffectiveRate.toLocaleString("es-AR", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}%</b></div>
      <div class="card stat"><span class="label">Neto tras MP</span><b id="net-after-mp">$${formatoDinero(stats.netoDespuesMp)}</b></div>
    </section>

    <section class="card distribution">
      <h2>Reparto entre coparticipantes</h2>
      <p class="hint">Los porcentajes se congelan en cada venta. La última columna acumula el neto asignado a cada participante.</p>
      <div class="distribution-note"><b>Las vinculaciones quedan guardadas.</b> Podés cambiar porcentajes, alias y responsable de comisión todas las veces que necesites sin volver a escanear. Una autorización sólo se elimina mediante “Desvincular cuenta”.</div>
      ${distributionError ? `<div class="form-error">${escaparHtml(distributionError)}</div>` : ""}
      <form method="POST" action="/admin/device/${encodeURIComponent(id)}/distribution-update" id="distribution-form">
        <div class="participant-picker"><div><b>Participantes totales, incluyendo EVETEC</b><div class="hint">EVETEC siempre ocupa el primer lugar. Podés configurar hasta ocho participantes por módulo.</div></div><select name="participantCount" id="participant-count">${PARTICIPANT_NUMBERS.map(count => `<option value="${count}" ${count === participantCount ? "selected" : ""}>${count} participante${count > 1 ? "s" : ""}</option>`).join("")}</select></div>
        <label class="check auto-share"><input type="checkbox" id="auto-distribution" checked> Ajustar automáticamente los demás porcentajes para completar 100% <span class="hint">Desmarcá para redondear o editar todo manualmente.</span></label>
        <div class="participant-head"><span>#</span><span>Alias</span><span>Participación</span><span>Neto acumulado</span><span>Cuenta Mercado Pago</span></div>
        ${participantRows}
        <div class="distribution-note"><b>Comisión Mercado Pago: reparto proporcional fijo.</b> Cada participante absorbe la comisión según su porcentaje; esta regla no puede cambiarse individualmente.</div>
        <div class="hint" style="margin-top:12px">La cuenta de cobro y la participación EVETEC se determinan automáticamente con los porcentajes configurados arriba.</div>
        <div class="distribution-note">Este reparto es una liquidación contable. Mercado Pago estándar transfiere automáticamente solo entre vendedor y marketplace; los pagos 1:N requieren habilitación comercial especial.</div>
        <div class="actions"><button class="btn primary" type="submit">Guardar reparto</button></div>
      </form>
    </section>

    <section class="columns">
      <div class="card">
        ${serviceConfigHtml}
      </div>

      <aside class="card">
        <h2>Cuenta de cobro Mercado Pago</h2>
        <div class="owner">
          <div class="owner-line"><span>Cuenta EVETEC base</span><span class="pill ${EVETEC_MP_TOKEN ? "success" : "warning"}">${EVETEC_MP_TOKEN ? "Lista para cobrar" : "Falta credencial"}</span></div>
          <div class="owner-line"><span>Cuenta seleccionada</span><b>${escaparHtml(paymentAccountName)}</b></div>
          <div class="owner-line"><span>Estado operativo</span><span class="pill ${paymentAccountReady ? "success" : "warning"}">${paymentAccountReady ? "Lista para cobrar" : "Falta vincular"}</span></div>
          <div class="owner-line"><span>Usuario MP</span><b>${escaparHtml(paymentAccountUserId || "No asignado")}</b></div>
          <div class="owner-line"><span>Correo</span><b>${escaparHtml(paymentAccountEmail || "No informado")}</b></div>
        </div>
        <p class="hint">Las cuentas de los coparticipantes se administran en sus respectivas filas. Cambiar el reparto no modifica ninguna autorización.</p>
        ${!chargingParticipant && d.modoCobro !== "evetec" ? `<div class="actions"><a class="btn primary" href="/oauth/link/${encodeURIComponent(id)}">${d.ownerLinked ? "Cambiar cuenta dueña heredada" : "Vincular cuenta dueña"}</a>${d.ownerLinked ? `<form method="POST" action="/unlink-owner/${encodeURIComponent(id)}" data-owner-unlink><input type="hidden" name="confirmation" value=""><button class="btn danger" type="submit">Desvincular</button></form>` : ""}</div>` : ""}
        <h3>Estado del equipo</h3>
        <div class="owner-line"><span>Última conexión</span><b>${escaparHtml(ultimaConexion)}</b></div>
        <div class="owner-line"><span>Salida</span><b>GPIO 40</b></div>
        <div class="owner-line"><span>Mercado</span><b>${d.paisOperacion === "BR" ? "Brasil" : "Argentina"}</b></div>
        <div class="owner-line"><span>Moneda</span><b>${escaparHtml(monedaDevice(id))}</b></div>
        <div class="owner-line"><span>Firmware</span><b>${escaparHtml(d.telemetria?.firmware || "Sin informar")}</b></div>
        <div class="owner-line"><span>WiFi / señal</span><b>${escaparHtml(d.telemetria?.ssid || "-")} ${Number(d.telemetria?.rssi || 0) ? `(${Number(d.telemetria.rssi)} dBm)` : ""}</b></div>
        <div class="owner-line"><span>Registros locales</span><b>${Number(d.telemetria?.localSales || 0)}</b></div>
        <div class="country-note"><b>PIX / Brasil</b><div class="hint">La plataforma está preparada para separar el mercado por módulo. PIX se habilita al vincular una cuenta Mercado Pago Brasil compatible; una cuenta argentina no puede cobrar PIX directamente.</div></div>
      </aside>
    </section>

    <section class="card" style="margin-top:16px"><h2>Servicios confirmados por el equipo</h2><p class="hint">La tasa mostrada es el porcentaje real descontado en cada transacción, no una estimación.</p><div class="table-wrap"><table><thead><tr><th>Fecha</th><th>Pago</th><th>Monto</th><th>Comisión MP</th><th>% MP real</th><th>Neto MP</th><th>Vendido</th><th>Uso real</th><th>Estado</th></tr></thead><tbody>${pagosHtml}</tbody></table></div></section>
    <section class="card" style="margin-top:16px">
      <h2>Accesos de clientes</h2>
      <p class="hint">Cada cliente ve únicamente sus módulos y sus datos en vivo. Puede cambiar precios y tiempos; reparto, cuentas Mercado Pago, mantenimiento, respaldos y registro de ventas siguen siendo exclusivos de EVETEC.</p>
      <form method="POST" action="/admin/client-account/save" id="client-account-form">
        <input type="hidden" name="originalUsername" id="client-original-username">
        <div class="form-grid">
          <div class="field"><label>Nombre del cliente</label><input name="displayName" id="client-display-name" maxlength="60" required></div>
          <div class="field"><label>Usuario</label><input name="username" id="client-username" pattern="[A-Za-z0-9._-]{3,48}" autocomplete="off" required></div>
          <div class="field wide"><label>Contraseña <span class="hint">(obligatoria al crear; en blanco conserva la actual)</span></label><div style="display:flex;gap:8px"><input name="password" id="client-password" type="password" minlength="10" autocomplete="new-password" style="flex:1"><button class="mini-btn" type="button" id="generate-client-password">Generar</button></div></div>
          <div class="field wide"><label>Equipos asignados <span class="hint">(marcar agrega; desmarcar quita)</span></label><div class="switches">${deviceIds.map(deviceId => `<label class="check"><input type="checkbox" name="deviceIds" value="${escaparHtml(deviceId)}" data-client-device="${escaparHtml(deviceId)}"> ${escaparHtml(nombreVisibleDevice(deviceId) || deviceId)}</label>`).join("")}</div></div>
        </div>
        <div class="actions"><button class="btn primary" type="submit">Guardar acceso</button><a class="btn secondary" href="/login" target="_blank" rel="noopener">Abrir acceso unificado</a></div>
      </form>
      <div class="table-wrap" style="margin-top:16px"><table><thead><tr><th>Cliente</th><th>Equipos</th><th>Estado</th><th>Acciones</th></tr></thead><tbody>${clientAccountRows || `<tr><td colspan="4" class="empty">Todavía no hay accesos de clientes.</td></tr>`}</tbody></table></div>
    </section>
    <details class="card module-add"><summary>+ Incorporar otro módulo</summary><form class="new-device-form" method="POST" action="/admin/device/add"><div class="field"><label>Identificador único</label><input name="deviceId" placeholder="PELUCHE_001" pattern="[A-Za-z0-9_-]{3,40}" required></div><div class="field"><label>Tipo</label><select name="tipo"><option value="basic">Servicio temporizado</option><option value="gachapon">Máquina de peluches / premios</option><option value="arcade">Arcade / créditos</option><option value="premium">Planes múltiples</option></select></div><button class="btn primary" type="submit">Crear módulo</button></form></details>
    <div class="footer">Los cambios de precio y tiempos son consultados automáticamente por la pantalla. Base: ${escaparHtml(PUBLIC_BASE_URL)}</div>
      <script>
      const participantCount=document.getElementById('participant-count');
      const autoDistribution=document.getElementById('auto-distribution');
      const clientForm=document.getElementById('client-account-form');
      document.getElementById('generate-client-password').addEventListener('click',()=>{const chars='ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz23456789!@#$%';const bytes=crypto.getRandomValues(new Uint8Array(16));const value=[...bytes].map(byte=>chars[byte%chars.length]).join('');const input=document.getElementById('client-password');input.type='text';input.value=value;input.focus();input.select()});
      document.querySelectorAll('[data-client-edit]').forEach(button=>button.addEventListener('click',()=>{document.getElementById('client-original-username').value=button.dataset.clientEdit;document.getElementById('client-username').value=button.dataset.clientEdit;document.getElementById('client-display-name').value=button.dataset.clientName;document.getElementById('client-password').value='';const assigned=new Set(button.dataset.clientDevices.split(',').filter(Boolean));document.querySelectorAll('[data-client-device]').forEach(input=>input.checked=assigned.has(input.value));clientForm.scrollIntoView({behavior:'smooth',block:'center'})}));
      let balancingPercentages=false;
      function syncParticipantRows(){const count=Number(participantCount.value);document.querySelectorAll('[data-participant-row]').forEach(row=>{const number=Number(row.dataset.participantRow);const visible=number<=count;row.hidden=!visible;row.querySelectorAll('input').forEach(input=>input.disabled=!visible)})}
      function activePercentageInputs(){return [...document.querySelectorAll('input[name^="participant_pct_"]')].filter(input=>!input.disabled)}
      function percentageText(value){return (Math.round(value*100)/100).toFixed(2).replace(/\\.00$/,'')}
      function equalizePercentages(){const inputs=activePercentageInputs();if(!inputs.length)return;balancingPercentages=true;const base=Math.floor(10000/inputs.length)/100;let used=0;inputs.forEach((input,index)=>{const value=index===inputs.length-1?100-used:base;input.value=percentageText(value);used=Math.round((used+value)*100)/100});balancingPercentages=false}
      function rebalanceFrom(changed){if(balancingPercentages||!autoDistribution.checked)return;const inputs=activePercentageInputs();if(inputs.length===1){changed.value='100';return}const selected=Math.max(0,Math.min(100,Number(changed.value)||0));const others=inputs.filter(input=>input!==changed);const base=Math.floor(((100-selected)/others.length)*100)/100;balancingPercentages=true;changed.value=percentageText(selected);let used=selected;others.forEach((input,index)=>{const value=index===others.length-1?Math.max(0,100-used):base;input.value=percentageText(value);used=Math.round((used+value)*100)/100});balancingPercentages=false}
      participantCount.addEventListener('change',()=>{syncParticipantRows();if(autoDistribution.checked)equalizePercentages()});document.querySelectorAll('input[name^="participant_name_"]').forEach(input=>input.addEventListener('input',syncParticipantRows));document.querySelectorAll('input[name^="participant_pct_"]').forEach(input=>input.addEventListener('input',()=>rebalanceFrom(input)));autoDistribution.addEventListener('change',()=>{if(autoDistribution.checked)equalizePercentages()});syncParticipantRows();
      document.querySelectorAll('[data-participant-link]').forEach(button=>button.addEventListener('click',async()=>{const row=button.closest('[data-participant-row]');const alias=row.querySelector('input[name^="participant_name_"]').value.trim();if(!alias){alert('Escribí primero el alias del participante.');return}button.disabled=true;button.textContent='Enviando...';try{const response=await fetch('/admin/device/${encodeURIComponent(id)}/participant-link-request',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({participantId:button.dataset.participantLink,alias})});const data=await response.json();if(!response.ok||!data.ok)throw new Error(data.error||'No se pudo generar el QR');location.reload()}catch(error){button.disabled=false;button.textContent='Generar QR';alert(error.message)}}));
      document.querySelectorAll('[data-participant-cancel]').forEach(button=>button.addEventListener('click',async()=>{if(!confirm('¿Cancelar este QR? Dejará de mostrarse en el módulo y ya no podrá completar la vinculación.'))return;button.disabled=true;const response=await fetch('/admin/device/${encodeURIComponent(id)}/participant-link-cancel',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({participantId:button.dataset.participantCancel})});const data=await response.json().catch(()=>({}));if(response.ok&&data.ok)location.reload();else{button.disabled=false;alert(data.error||'No se pudo cancelar el QR.')}}));
      document.querySelectorAll('[data-participant-share]').forEach(button=>button.addEventListener('click',async()=>{const url=button.dataset.participantShare;try{if(navigator.share){await navigator.share({title:'Vinculación Mercado Pago',text:'Abrí este enlace para vincular tu cuenta al equipo ${encodeURIComponent(id)}.',url});return}await navigator.clipboard.writeText(url);button.textContent='Enlace copiado';setTimeout(()=>button.textContent='Copiar / enviar enlace',1800)}catch(error){if(error&&error.name==='AbortError')return;prompt('Copiá y enviá este enlace al participante:',url)}}));
      document.querySelectorAll('[data-participant-unlink]').forEach(button=>button.addEventListener('click',async()=>{const confirmation=prompt('Esta acción borra la autorización guardada. Escribí DESVINCULAR para confirmar:');if(String(confirmation||'').trim().toUpperCase()!=='DESVINCULAR')return;button.disabled=true;const response=await fetch('/admin/device/${encodeURIComponent(id)}/participant-unlink',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({participantId:button.dataset.participantUnlink,confirmation:'DESVINCULAR'})});const data=await response.json().catch(()=>({}));if(response.ok&&data.ok)location.reload();else{button.disabled=false;alert(data.error||'No se pudo desvincular la cuenta.')}}));
      document.querySelectorAll('[data-owner-unlink]').forEach(form=>form.addEventListener('submit',event=>{const confirmation=prompt('Esta acción borra la autorización guardada. Escribí DESVINCULAR para confirmar:');if(String(confirmation||'').trim().toUpperCase()!=='DESVINCULAR'){event.preventDefault();return}form.querySelector('input[name="confirmation"]').value='DESVINCULAR'}));
      setInterval(async()=>{try{const r=await fetch('/admin/device/${encodeURIComponent(id)}/live-stats',{cache:'no-store'});if(!r.ok)return;const s=await r.json();const money=n=>'$'+Number(n||0).toLocaleString('es-AR',{minimumFractionDigits:0,maximumFractionDigits:2});document.getElementById('mp-fees').textContent=money(s.comisionesMp);document.getElementById('net-after-mp').textContent=money(s.netoDespuesMp);document.getElementById('mp-rate').textContent=Number(s.tasaMpEfectiva||0).toLocaleString('es-AR',{minimumFractionDigits:2,maximumFractionDigits:2})+'%';document.querySelectorAll('[data-participant-total]').forEach(element=>{element.textContent=money((s.participantTotals||{})[element.dataset.participantTotal]||0)})}catch(_){ }},5000);
    </script>
  </main></body></html>`);
});

function renderLegacyAdminDisabled(req, res) {
  let html = `
  <!doctype html>
  <html>
  <head>
    <meta name="viewport" content="width=device-width, initial-scale=1">
    <title>Panel Timers Vending</title>
    <style>
      body{font-family:Arial;background:#050816;color:white;padding:20px}
      h1{color:#22d3ee;margin-bottom:4px}
      h2{color:#facc15}
      h3{color:#67e8f9}
      .box{background:#111827;border:1px solid #22d3ee;border-radius:14px;padding:16px;margin-bottom:20px}
      input,select{padding:8px;margin:4px;border-radius:8px;border:0}
      button{padding:10px 14px;border:0;border-radius:10px;font-weight:bold;cursor:pointer;margin:4px}
      .save{background:#22c55e;color:#001b08}
      .danger{background:#ef4444;color:white}
      .promo{background:#facc15;color:#111}
      .online{color:#22c55e;font-weight:bold}
      .offline{color:#ef4444;font-weight:bold}
      .small{color:#94a3b8;font-size:13px}
      .tag{display:inline-block;background:#0f172a;color:#67e8f9;border:1px solid #155e75;border-radius:999px;padding:4px 10px;font-size:12px}
      .basic{color:#60a5fa;font-weight:bold}
      .premium{color:#c084fc;font-weight:bold}
      .gachapon{color:#f97316;font-weight:bold}
      .arcade{color:#facc15;font-weight:bold}
      .ok{color:#22c55e;font-weight:bold}
      .bad{color:#ef4444;font-weight:bold}
      table{width:100%;border-collapse:collapse}
      td,th{border-bottom:1px solid #1f2937;padding:8px;text-align:left;vertical-align:middle}
      .grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(280px,1fr));gap:14px}
      .money{font-size:20px;color:#22c55e;font-weight:bold}
    </style>
  </head>
  <body>
    <h1>PANEL SISTEMA VENDING / TIMERS</h1>
    <p class="small">Base pública: ${escaparHtml(PUBLIC_BASE_URL)}</p>
    <p class="small">Redirect OAuth: ${escaparHtml(REDIRECT_URI)}</p>
    <p class="small">
      MP_CLIENT_ID: <b class="${MP_CLIENT_ID ? "ok" : "bad"}">${MP_CLIENT_ID ? "OK" : "FALTA"}</b> |
      MP_CLIENT_SECRET: <b class="${MP_CLIENT_SECRET ? "ok" : "bad"}">${MP_CLIENT_SECRET ? "OK" : "FALTA"}</b> |
      Token fallback: <b class="${EVETEC_MP_TOKEN ? "ok" : "bad"}">${EVETEC_MP_TOKEN ? "OK" : "FALTA"}</b>
    </p>

    <div class="box">
      <h2>Recaudación por equipo</h2>
      <table>
        <tr>
          <th>Equipo</th>
          <th>Tipo</th>
          <th>Online</th>
          <th>Recaudado</th>
          <th>Pagos OK</th>
          <th>Tiempo vendido</th>
          <th>Último pago</th>
        </tr>
  `;

  for (const id of Object.keys(devices).sort()) {
    const d = asegurarDevice(id);
    const stats = d.stats || statsIniciales();
    const ultimo = stats.ultimosPagos && stats.ultimosPagos.length ? stats.ultimosPagos[0] : null;

    html += `
      <tr>
        <td><b>${escaparHtml(id)}</b></td>
        <td class="${claseTipoDevice(d.tipo)}">${etiquetaTipoDevice(d.tipo)}</td>
        <td class="${d.online ? "online" : "offline"}">${d.online ? "ONLINE" : "OFFLINE"}</td>
        <td class="money">$${formatoDinero(stats.totalRecaudado)}</td>
        <td>${stats.pagosAprobados || 0}</td>
        <td>${formatoTiempo(stats.segundosVendidos)}</td>
        <td>${ultimo ? `$${formatoDinero(ultimo.monto)} - ${escaparHtml(new Date(ultimo.fecha).toLocaleString("es-AR"))}` : "Sin pagos"}</td>
      </tr>
    `;
  }

  html += `
      </table>
    </div>

    <div class="grid">
      <div class="box">
        <h2>Estado general</h2>
        <form method="POST" action="/admin/global/update">
          Sistema activo:
          <input type="checkbox" name="activo" ${configGlobal.activo ? "checked" : ""}><br>
          Mensaje activo:
          <input type="checkbox" name="mensajeGlobalActivo" ${configGlobal.mensajeGlobalActivo ? "checked" : ""}><br>
          Mensaje:<br>
          <input name="mensajeGlobal" value="${escaparHtml(configGlobal.mensajeGlobal)}" size="42"><br>
          <button class="save" type="submit">Guardar estado</button>
        </form>
      </div>

      <div class="box">
        <h2>Inflador QR</h2>
        <p class="small">Configuración de INFLADOR_001. El precio y los tiempos se actualizan automáticamente en la pantalla.</p>
        <form method="POST" action="/admin/basic/update">
          Activo:
          <input type="checkbox" name="activo" ${configGlobal.basic.activo ? "checked" : ""}><br>
          Nombre:
          <input name="nombre" value="${escaparHtml(configGlobal.basic.nombre)}" size="18"><br>
          Precio:
          <input name="monto" value="${configGlobal.basic.monto}" size="8">
          Segundos:
          <input name="segundos" value="${configGlobal.basic.segundos}" size="8"><br>
          Espera antes de encender:
          <input name="preinicioSegundos" value="${configGlobal.basic.preinicioSegundos}" size="8"> segundos
          Descripción:
          <input name="descripcion" value="${escaparHtml(configGlobal.basic.descripcion)}" size="42"><br>
          <button class="save" type="submit">Guardar básico</button>
        </form>
      </div>
    </div>

    <div class="box">
      <h2>Gachapon: precios, créditos y tiempos de motor</h2>
      <p class="small">Esto es lo que lee el INO desde /config/GACHAPON_001. El tiempo de giro se expresa en milisegundos: 10000 = 10 segundos.</p>
      <form method="POST" action="/admin/gachapon/update">
        Activo:
        <input type="checkbox" name="activo" ${configGlobal.gachapon.activo ? "checked" : ""}><br>
        Nombre:<input name="nombre" value="${escaparHtml(configGlobal.gachapon.nombre)}" size="16">
        Título:<input name="titulo" value="${escaparHtml(configGlobal.gachapon.titulo)}" size="16"><br>
        Mensaje:<input name="mensaje" value="${escaparHtml(configGlobal.gachapon.mensaje)}" size="32">
        Instrucción:<input name="instruccion" value="${escaparHtml(configGlobal.gachapon.instruccion)}" size="24"><br>
        Pulso motor ms:<input name="pulso_motor_ms" value="${configGlobal.gachapon.pulso_motor_ms}" size="8">
        Pausa premios ms:<input name="pausa_premios_ms" value="${configGlobal.gachapon.pausa_premios_ms}" size="8"><br><br>
  `;

  configGlobal.gachapon.planes.slice(0, 3).forEach((p, i) => {
    html += `
      <div>
        <b>Opción ${i + 1}</b>
        ID:<input name="id${i}" value="${escaparHtml(p.id || "G" + (i + 1))}" size="5">
        Créditos:<input name="creditos${i}" value="${p.creditos || i + 1}" size="4">
        Nombre:<input name="nombre${i}" value="${escaparHtml(p.nombre)}" size="12">
        Etiqueta:<input name="etiqueta${i}" value="${escaparHtml(p.etiqueta || "")}" size="14">
        Precio:<input name="monto${i}" value="${p.monto}" size="7">
        Giro ms:<input name="giro_ms${i}" value="${p.giro_ms}" size="8">
        Desc:<input name="descripcion${i}" value="${escaparHtml(p.descripcion || "")}" size="18">
      </div>
    `;
  });

  html += `
        <button class="save" type="submit">Guardar Gachapon</button>
      </form>
    </div>

    <div class="box">
      <h2>Arcade Galaga: creditos y QR</h2>
      <p class="small">Pantalla jugable: <b>/galaga</b>. Cada partida descuenta los creditos configurados abajo.</p>
      <form method="POST" action="/admin/arcade/update">
        Activo:
        <input type="checkbox" name="activo" ${configGlobal.arcade.activo ? "checked" : ""}><br>
        Nombre:<input name="nombre" value="${escaparHtml(configGlobal.arcade.nombre)}" size="18">
        Titulo:<input name="titulo" value="${escaparHtml(configGlobal.arcade.titulo)}" size="18">
        Creditos por partida:<input name="creditosPorPartida" value="${configGlobal.arcade.creditosPorPartida}" size="4"><br>
        Mensaje:<input name="mensaje" value="${escaparHtml(configGlobal.arcade.mensaje)}" size="48"><br><br>
  `;

  configGlobal.arcade.planes.slice(0, 3).forEach((p, i) => {
    html += `
      <div>
        <b>Pack ${i + 1}</b>
        ID:<input name="id${i}" value="${escaparHtml(p.id || "A" + (i + 1))}" size="5">
        Creditos:<input name="creditos${i}" value="${p.creditos || i + 1}" size="4">
        Nombre:<input name="nombre${i}" value="${escaparHtml(p.nombre)}" size="12">
        Etiqueta:<input name="etiqueta${i}" value="${escaparHtml(p.etiqueta || "")}" size="14">
        Precio:<input name="monto${i}" value="${p.monto}" size="7">
        Desc:<input name="descripcion${i}" value="${escaparHtml(p.descripcion || "")}" size="18">
      </div>
    `;
  });

  html += `
        <button class="save" type="submit">Guardar Arcade</button>
      </form>
    </div>

    <div class="box">
      <h2>Premium: 3 precios principales</h2>
      <form method="POST" action="/admin/premium/prices/update">
  `;

  configGlobal.premium.planes.forEach((p, i) => {
    html += `
      <div>
        <b>Plan ${i + 1}</b>
        ID:<input name="id${i}" value="${escaparHtml(p.id || "P" + (i + 1))}" size="5">
        Nombre:<input name="nombre${i}" value="${escaparHtml(p.nombre)}" size="12">
        Seg:<input name="segundos${i}" value="${p.segundos}" size="6">
        Precio:<input name="monto${i}" value="${p.monto}" size="7">
        Desc:<input name="descripcion${i}" value="${escaparHtml(p.descripcion)}" size="26">
      </div>
    `;
  });

  html += `
        <button class="save" type="submit">Guardar precios premium</button>
      </form>
    </div>

    <div class="box">
      <h2>Premium: 3 precios extra post-tiempo</h2>
      <form method="POST" action="/admin/premium/extra-prices/update">
  `;

  configGlobal.premium.preciosExtra.forEach((p, i) => {
    html += `
      <div>
        <b>Extra ${i + 1}</b>
        ID:<input name="id${i}" value="${escaparHtml(p.id || "E" + (i + 1))}" size="5">
        Nombre:<input name="nombre${i}" value="${escaparHtml(p.nombre)}" size="12">
        Seg:<input name="segundos${i}" value="${p.segundos}" size="6">
        Precio:<input name="monto${i}" value="${p.monto}" size="7">
        Desc:<input name="descripcion${i}" value="${escaparHtml(p.descripcion)}" size="26">
      </div>
    `;
  });

  html += `
        <button class="save" type="submit">Guardar extras premium</button>
      </form>
    </div>

    <div class="box">
      <h2>Premium: 4° precio / promo opcional</h2>
      <form method="POST" action="/admin/premium/promo/update">
        Activa:<input type="checkbox" name="activa" ${configGlobal.premium.promoGlobal.activa ? "checked" : ""}><br>
        ID:<input name="id" value="${escaparHtml(configGlobal.premium.promoGlobal.id || "PROMO")}" size="8">
        Nombre:<input name="nombre" value="${escaparHtml(configGlobal.premium.promoGlobal.nombre)}" size="20"><br>
        Duración:<input name="segundos" value="${configGlobal.premium.promoGlobal.segundos}" size="8"> segundos
        Precio:<input name="monto" value="${configGlobal.premium.promoGlobal.monto}" size="8"><br>
        Descripción:<input name="descripcion" value="${escaparHtml(configGlobal.premium.promoGlobal.descripcion)}" size="42"><br>
        <button class="save" type="submit">Guardar promo premium</button>
      </form>
    </div>

    <div class="box">
      <h2>Descuentos rápidos Premium</h2>
      <form method="POST" action="/admin/premium/discount">
        <button class="promo" name="descuento" value="50">50% OFF</button>
        <button class="promo" name="descuento" value="40">40% OFF</button>
        <button class="promo" name="descuento" value="30">30% OFF</button>
        <button class="promo" name="descuento" value="20">20% OFF</button>
        <button class="promo" name="descuento" value="10">10% OFF</button>
        <button class="promo" name="descuento" value="5">5% OFF</button>
      </form>

      <form method="POST" action="/admin/premium/reset-prices">
        <button class="danger" type="submit">Restaurar precios base premium</button>
      </form>
    </div>

    <div class="box">
      <h2>Máquinas / mantenimiento / cobro</h2>
      <table>
        <tr>
          <th>Equipo</th>
          <th>Tipo</th>
          <th>Online</th>
          <th>Activo</th>
          <th>Mantenimiento</th>
          <th>Cuenta MP</th>
          <th>Modo cobro</th>
          <th>Comisión</th>
          <th>Última conexión</th>
          <th>Acciones</th>
        </tr>
  `;

  for (const id of Object.keys(devices).sort()) {
    const d = asegurarDevice(id);
    const last = d.ultimaConexion ? new Date(d.ultimaConexion).toLocaleString("es-AR") : "Nunca";

    html += `
      <tr>
        <td><b>${escaparHtml(id)}</b></td>
        <td class="${claseTipoDevice(d.tipo)}">${etiquetaTipoDevice(d.tipo)}</td>
        <td class="${d.online ? "online" : "offline"}">${d.online ? "ONLINE" : "OFFLINE"}</td>
        <td>${d.activo ? "SI" : "NO"}</td>
        <td>${d.modoMantenimiento ? "SI" : "NO"}</td>
        <td class="${d.ownerLinked ? "ok" : "bad"}">${d.ownerLinked ? "VINCULADA" : "NO VINCULADA"}</td>

        <td>
          <form method="POST" action="/admin/device/${encodeURIComponent(id)}/billing">
            <select name="modoCobro">
              <option value="owner_commission" ${d.modoCobro === "owner_commission" ? "selected" : ""}>Dueño + comisión</option>
              <option value="owner_direct" ${d.modoCobro === "owner_direct" ? "selected" : ""}>Dueño directo</option>
              <option value="evetec" ${d.modoCobro === "evetec" ? "selected" : ""}>Cuenta fallback</option>
            </select>
            <button class="save" type="submit">OK</button>
          </form>
        </td>

        <td>
          <form method="POST" action="/admin/device/${encodeURIComponent(id)}/commission">
            <input name="comision" value="${d.comisionEvetecPorcentaje}" size="4"> %
            <button class="save" type="submit">OK</button>
          </form>
        </td>

        <td>${escaparHtml(last)}</td>

        <td>
          <form method="POST" action="/admin/device/${encodeURIComponent(id)}/status">
            <input type="hidden" name="activo" value="${d.activo ? "0" : "1"}">
            <button class="${d.activo ? "danger" : "save"}" type="submit">
              ${d.activo ? "Dar baja" : "Activar"}
            </button>
          </form>

          <form method="POST" action="/admin/device/${encodeURIComponent(id)}/maintenance">
            <input type="hidden" name="mantenimiento" value="${d.modoMantenimiento ? "0" : "1"}">
            <button class="${d.modoMantenimiento ? "save" : "danger"}" type="submit">
              ${d.modoMantenimiento ? "Quitar mant." : "Mantenimiento"}
            </button>
          </form>

          <form method="POST" action="/unlink-owner/${encodeURIComponent(id)}">
            <button class="danger" type="submit">Desvincular MP</button>
          </form>
        </td>
      </tr>
    `;
  }

  html += `
      </table>
    </div>

    <div class="box">
      <h2>Agregar equipo</h2>
      <form method="POST" action="/admin/device/add">
        ID equipo:
        <input name="deviceId" value="GALAGA_001" size="24">
        Tipo:
        <select name="tipo">
          <option value="basic">Básico</option>
          <option value="premium">Premium</option>
          <option value="gachapon">Gachapon</option>
          <option value="arcade">Arcade</option>
        </select>
        <button class="save" type="submit">Agregar</button>
      </form>
    </div>

    <div class="box">
      <h2>Últimos pagos globales</h2>
      <table>
        <tr>
          <th>Referencia</th>
          <th>Equipo</th>
          <th>Tipo</th>
          <th>Monto</th>
          <th>Segundos</th>
          <th>Créditos</th>
          <th>Motor</th>
          <th>Estado</th>
        </tr>
  `;

  const pagos = Object.values(pagosCreados)
    .filter((p, index, arr) => arr.findIndex(x => x.external_reference === p.external_reference) === index)
    .slice(-30)
    .reverse();

  for (const p of pagos) {
    html += `
      <tr>
        <td>${escaparHtml(p.external_reference)}</td>
        <td>${escaparHtml(p.device_id)}</td>
        <td>${escaparHtml(p.tipo || "")}</td>
        <td>$${formatoDinero(p.monto)}</td>
        <td>${formatoTiempo(p.segundos)}</td>
        <td>${p.creditos || 0}</td>
        <td>${p.motor_ms ? `${p.motor_ms} ms` : "-"}</td>
        <td>${escaparHtml(p.estado)}</td>
      </tr>
    `;
  }

  html += `
      </table>
    </div>

  </body>
  </html>
  `;

  res.send(html);
}

// =====================================================
// ACCIONES ADMIN
// =====================================================

function celdaCsv(value) {
  let text = String(value ?? "");
  if (/^[=+\-@]/.test(text)) text = `'${text}`;
  return `"${text.replace(/"/g, '""')}"`;
}

function adminDeviceUrl(deviceId, params = "") {
  return `/admin?device=${encodeURIComponent(deviceId)}${params}`;
}

function enviarBackupUso(deviceId, res) {
  const id = String(deviceId || "").trim().toUpperCase();
  const events = eventosUsoDevice(id);
  const columns = [
    "event_id", "payment_id", "device_id", "approved_at", "started_at", "finished_at",
    "amount", "mp_fee", "mp_effective_rate_pct", "net_after_mp", "sold_seconds", "actual_seconds",
    "evetec", "owner",
    ...PARTICIPANT_NUMBERS.flatMap(index => [`participant_${index}`, `participant_${index}_net`]),
    "mode", "completed"
  ];
  const rows = events.map(e => {
    const amountCents = Number(e.amount_cents || 0);
    const feeCents = Number(e.mp_fee_cents || 0);
    return [
      e.event_id, e.payment_id, e.device_id,
      e.approved_epoch ? new Date(Number(e.approved_epoch) * 1000).toISOString() : "",
      e.started_epoch ? new Date(Number(e.started_epoch) * 1000).toISOString() : "",
      e.finished_epoch ? new Date(Number(e.finished_epoch) * 1000).toISOString() : "",
      (amountCents / 100).toFixed(2), (feeCents / 100).toFixed(2),
      (amountCents > 0 ? feeCents * 100 / amountCents : 0).toFixed(4),
      ((amountCents - feeCents) / 100).toFixed(2),
      Number(e.sold_seconds || 0), Number(e.actual_seconds || 0),
      (Number(e.evetec_cents || 0) / 100).toFixed(2),
      (Number(e.owner_cents || 0) / 100).toFixed(2),
      ...PARTICIPANT_NUMBERS.map(number => number - 1).flatMap(index => {
        const p = (e.participants || [])[index] || {};
        return [p.nombre || "", (Number(p.neto_cents || 0) / 100).toFixed(2)];
      }),
      e.mode || "", e.completed !== false ? "yes" : "no"
    ];
  });
  const csv = "\uFEFF" + [columns, ...rows].map(row => row.map(celdaCsv).join(",")).join("\r\n");
  const stamp = new Date().toISOString().slice(0, 10);
  res.set("Content-Type", "text/csv; charset=utf-8");
  res.set("Content-Disposition", `attachment; filename="evetec-${id}-${stamp}.csv"`);
  res.send(csv);
}

app.get("/admin/device/:deviceId/usage-backup.csv", (req, res) => {
  enviarBackupUso(req.params.deviceId, res);
});

app.post("/admin/device/:deviceId/backup-confirm", (req, res) => {
  const id = String(req.params.deviceId || "").trim().toUpperCase();
  const d = asegurarDevice(id);
  d.backupConfirmedCount = eventosUsoDevice(id).length;
  d.backupConfirmedAt = new Date().toISOString();
  guardarDatos();
  res.redirect(adminDeviceUrl(id));
});

app.post("/admin/device/:deviceId/toggle-sales-log", (req, res) => {
  const id = String(req.params.deviceId || "").trim().toUpperCase();
  const d = asegurarDevice(id);
  d.registroVentasHabilitado = d.registroVentasHabilitado === false;
  guardarDatos();
  res.redirect(adminDeviceUrl(id));
});

app.post("/admin/sales-reset-all", (req, res) => {
  if (String(req.body.confirmation || "").trim().toUpperCase() !== "BORRAR VENTAS") {
    return res.status(400).json({ ok: false, error: "confirmation_required" });
  }
  const resetAt = new Date();
  const resetEpoch = Math.floor(resetAt.getTime() / 1000);
  const resetGeneration = resetEpoch;
  const removedEvents = Object.keys(usageEvents).length;
  const removedPayments = Object.keys(pagosCreados).length;
  usageEvents = {};
  pagosCreados = {};
  for (const id of Object.keys(devices)) {
    const d = asegurarDevice(id);
    d.stats = statsIniciales();
    d.ledgerBaseline = null;
    d.backupConfirmedCount = 0;
    d.backupConfirmedAt = null;
    d.salesResetAtEpoch = resetEpoch;
    d.salesResetGeneration = resetGeneration;
    d.salesResetLocalFloor = Math.max(0, Number(d.telemetria?.localSales || 0));
    if (d.tipo === "arcade") d.arcadeCredits = 0;
  }
  guardarDatos();
  res.json({ ok: true, removed_events: removedEvents, removed_payment_keys: removedPayments, reset_generation: resetGeneration });
});

app.get("/admin/device/:deviceId/live-stats", (req, res) => {
  const id = String(req.params.deviceId || "").trim().toUpperCase();
  const usageList = eventosUsoDevice(id);
  const d = asegurarDevice(id);
  const stats = usageList.length ? statsDesdeUso(id) : (d.stats || statsIniciales());
  const total = Number(stats.totalRecaudado || 0);
  res.set("Cache-Control", "no-store");
  res.json({
    ok: true,
    comisionesMp: Number(stats.comisionesMp || 0),
    netoDespuesMp: Number(stats.netoDespuesMp || 0),
    tasaMpEfectiva: total > 0 ? Number(stats.comisionesMp || 0) * 100 / total : 0,
    pagosAprobados: Number(stats.pagosAprobados || 0),
    participantTotals: stats.participantTotals || {}
  });
});

app.post("/admin/client-account/save", (req, res) => {
  const username = normalizarUsuarioCliente(req.body.username);
  const originalUsername = normalizarUsuarioCliente(req.body.originalUsername);
  const displayName = String(req.body.displayName || "").trim().slice(0, 60);
  const password = String(req.body.password || "");
  const requestedDevices = Array.isArray(req.body.deviceIds) ? req.body.deviceIds : (req.body.deviceIds ? [req.body.deviceIds] : []);
  const deviceIds = [...new Set(requestedDevices.map(id => String(id || "").trim().toUpperCase()).filter(id => devices[id]))];
  const existing = clientAccounts[originalUsername || username];
  if (username.length < 3 || !displayName) return res.status(400).send("Completá nombre y un usuario válido.");
  if (!existing && password.length < 10) return res.status(400).send("La contraseña inicial debe tener al menos 10 caracteres.");
  if (username !== originalUsername && clientAccounts[username]) return res.status(409).send("Ese usuario ya existe.");
  const account = {
    ...(existing || {}),
    username,
    displayName,
    deviceIds,
    active: existing?.active !== false,
    sessionVersion: Math.max(1, Number(existing?.sessionVersion || 1)),
    createdAt: existing?.createdAt || new Date().toISOString(),
    updatedAt: new Date().toISOString()
  };
  if (password) {
    if (password.length < 10) return res.status(400).send("La contraseña debe tener al menos 10 caracteres.");
    const credential = hashPasswordCliente(password);
    account.passwordSalt = credential.salt;
    account.passwordHash = credential.hash;
    account.sessionVersion++;
  }
  if (originalUsername && originalUsername !== username) delete clientAccounts[originalUsername];
  clientAccounts[username] = account;
  guardarDatos();
  res.redirect(deviceIds[0] ? `/admin?device=${encodeURIComponent(deviceIds[0])}` : "/admin");
});

app.post("/admin/client-account/toggle", (req, res) => {
  const username = normalizarUsuarioCliente(req.body.username);
  const account = clientAccounts[username];
  if (!account) return res.status(404).send("Cliente inexistente.");
  account.active = !account.active;
  account.sessionVersion = Math.max(1, Number(account.sessionVersion || 1)) + 1;
  account.updatedAt = new Date().toISOString();
  guardarDatos();
  res.redirect("/admin");
});

app.get("/participant-status/:deviceId/:participantId", (req, res) => {
  const d = asegurarDevice(req.params.deviceId);
  const participantId = String(req.params.participantId || "").toLowerCase();
  const participant = d.participantes.find(p => p.id === participantId);
  if (!participant) return res.status(404).json({ ok: false, linked: false });
  res.json({
    ok: true,
    linked: participantId === "p1" ? Boolean(EVETEC_MP_TOKEN) : Boolean(participant.linked && participant.accessToken),
    participant_id: participantId,
    alias: participant.nombre || ""
  });
});

app.post("/admin/device/:deviceId/participant-link-request", (req, res) => {
  const id = String(req.params.deviceId || "").trim().toUpperCase();
  const participantId = String(req.body.participantId || "").trim().toLowerCase();
  const participantNumber = Number(participantId.slice(1));
  const d = asegurarDevice(id);
  const participant = d.participantes.find(p => p.id === participantId);
  const alias = String(req.body.alias || participant?.nombre || "").trim().slice(0, 40);
  if (!participant || participantId === "p1" || !alias || participantNumber < 2 || participantNumber > MAX_PARTICIPANTS) {
    return res.status(400).json({ ok: false, error: "Elegí un participante y escribí su alias." });
  }
  invalidarOauthParticipante(id, participantId);
  participant.nombre = alias;
  d.cantidadParticipantes = Math.max(d.cantidadParticipantes, participantNumber);
  d.participantLinkRequest = {
    participantId,
    alias,
    requestedAt: new Date().toISOString(),
    shareToken: crypto.randomBytes(24).toString("hex")
  };
  guardarDatos();
  const invitationUrl = `${PUBLIC_BASE_URL}/vincular/${encodeURIComponent(id)}/${encodeURIComponent(participantId)}/${encodeURIComponent(d.participantLinkRequest.shareToken)}`;
  res.json({ ok: true, participant_id: participantId, alias, invitation_url: invitationUrl, message: "QR y enlace de vinculación disponibles" });
});

app.post("/admin/device/:deviceId/participant-link-cancel", (req, res) => {
  const id = String(req.params.deviceId || "").trim().toUpperCase();
  const participantId = String(req.body.participantId || "").trim().toLowerCase();
  const d = asegurarDevice(id);
  const pendingParticipantId = String(d.participantLinkRequest?.participantId || "").trim().toLowerCase();
  if (!pendingParticipantId) {
    return res.json({ ok: true, canceled: false, message: "No había un QR pendiente" });
  }
  if (participantId && participantId !== pendingParticipantId) {
    return res.status(409).json({ ok: false, error: "Ese QR ya no es la vinculación pendiente." });
  }
  const invalidatedStates = invalidarOauthParticipante(id, pendingParticipantId);
  d.participantLinkRequest = null;
  guardarDatos();
  res.json({
    ok: true,
    canceled: true,
    participant_id: pendingParticipantId,
    invalidated_states: invalidatedStates,
    message: "QR cancelado"
  });
});

app.post("/admin/device/:deviceId/participant-unlink", (req, res) => {
  const id = String(req.params.deviceId || "").trim().toUpperCase();
  const participantId = String(req.body.participantId || "").trim().toLowerCase();
  if (String(req.body.confirmation || "").trim().toUpperCase() !== "DESVINCULAR") {
    return res.status(400).json({ ok: false, error: "Confirmación requerida. La cuenta permanece vinculada." });
  }
  const d = asegurarDevice(id);
  const participant = d.participantes.find(p => p.id === participantId);
  if (!participant || participantId === "p1") return res.status(400).json({ ok: false, error: "Participante inválido" });
  participant.linked = false;
  participant.accessToken = null;
  participant.refreshToken = null;
  participant.userId = null;
  participant.email = "";
  if (d.participantLinkRequest?.participantId === participantId) d.participantLinkRequest = null;
  invalidarOauthParticipante(id, participantId);
  guardarDatos();
  res.json({ ok: true, participant_id: participantId, message: "Cuenta desvinculada para nuevos cobros" });
});

app.post("/admin/device/:deviceId/distribution-update", (req, res) => {
  const id = String(req.params.deviceId || "").trim().toUpperCase();
  const d = asegurarDevice(id);
  const count = Math.max(1, Math.min(MAX_PARTICIPANTS, Math.round(Number(req.body.participantCount || 1))));
  const participants = PARTICIPANT_NUMBERS.map(index => {
    const participantId = `p${index}`;
    const existing = d.participantes.find(p => p.id === participantId) || {};
    return {
      ...existing,
      id: participantId,
      nombre: index === 1 ? "EVETEC" : (index <= count ? String(req.body[`participant_name_${index}`] || "").trim().slice(0, 40) : String(existing.nombre || "").slice(0, 40)),
      porcentaje: index <= count ? Math.max(0, Math.min(100, Number(req.body[`participant_pct_${index}`] || 0))) : 0
    };
  });
  const selected = participants.slice(0, count);
  const active = selected.filter(p => p.nombre && p.porcentaje > 0);
  const total = selected.reduce((sum, p) => sum + p.porcentaje, 0);
  let error = "";
  if (selected.some(p => !p.nombre)) error = "Completá el nombre de todos los coparticipantes elegidos.";
  else if (!active.length) error = "Al menos un participante debe tener un porcentaje mayor a cero.";
  else if (Math.abs(total - 100) > 0.001) error = "Los participantes activos deben sumar exactamente 100%.";
  if (error) return res.redirect(adminDeviceUrl(id, `&dist_error=${encodeURIComponent(error)}`));
  d.cantidadParticipantes = count;
  d.participantes = participants;
  d.pagadorComisionMp = "proportional";
  const evetecPercentage = Math.max(0, Math.min(100, Number(participants[0]?.porcentaje || 0)));
  d.comisionEvetecPorcentaje = evetecPercentage;
  d.modoCobro = evetecPercentage >= 99.999
    ? "evetec"
    : (evetecPercentage > 0 ? "owner_commission" : "owner_direct");
  guardarDatos();
  res.redirect(adminDeviceUrl(id));
});

app.post("/admin/device/:deviceId/update", (req, res) => {
  const id = String(req.params.deviceId || "").trim().toUpperCase();
  const d = asegurarDevice(id);
  if (d.tipo === "gachapon") {
    const cfg = configuracionGachaponDevice(id);
    const activo = req.body.activo === "on";
    d.activo = activo;
    d.modoMantenimiento = req.body.mantenimiento === "on";
    cfg.activo = activo;
    cfg.nombre = String(req.body.nombre || cfg.nombre).trim().slice(0, 60);
    cfg.titulo = String(req.body.titulo || cfg.titulo).trim().slice(0, 40);
    cfg.mensaje = String(req.body.mensaje || cfg.mensaje).trim().slice(0, 100);
    cfg.cantidad_opciones = Math.max(1, Math.min(3, Number(req.body.cantidadOpciones || 1)));
    cfg.modo_activacion = req.body.modoActivacion === "pulsos" ? "pulsos" : "tiempo";
    cfg.segundos_por_jugada = Math.max(1, Math.min(600, Number(req.body.segundosPorJugada || 30)));
    cfg.pulso_motor_ms = Math.max(100, Math.min(10000, Number(req.body.pulsoMotorMs || 500)));
    cfg.pausa_premios_ms = Math.max(0, Math.min(10000, Number(req.body.pausaPremiosMs || 650)));
    for (let index = 0; index < 3; index++) {
      const monto = Number(req.body[`monto${index}`]);
      const plan = cfg.planes[index];
      plan.id = `G${index + 1}`;
      plan.creditos = index + 1;
      plan.nombre = `${index + 1} JUGADA${index ? "S" : ""}`;
      plan.descripcion = `${index + 1} jugada${index ? "s" : ""}`;
      plan.giro_ms = cfg.pulso_motor_ms;
      if (Number.isFinite(monto) && monto > 0) plan.monto = Math.round(monto * 100) / 100;
      plan.etiqueta = String(req.body[`etiqueta${index}`] || "Elegir y pagar").trim().slice(0, 28);
    }
    guardarDatos();
    return res.redirect(adminDeviceUrl(id));
  }
  const cfg = configuracionServicioDevice(id);
  const activo = req.body.activo === "on";
  const monto = Number(req.body.monto);
  const minutos = Number(req.body.minutos);
  const segundos = Number(req.body.segundosServicio);
  const preinicio = Number(req.body.preinicioSegundos);
  d.activo = activo;
  d.modoMantenimiento = req.body.mantenimiento === "on";
  cfg.activo = activo;
  cfg.preinicioHabilitado = req.body.preinicioHabilitado === "on";
  cfg.nombre = String(req.body.nombre || cfg.nombre).trim().slice(0, 60);
  cfg.descripcion = String(req.body.descripcion || cfg.descripcion).trim().slice(0, 120);
  if (Number.isFinite(monto) && monto > 0) cfg.monto = Math.round(monto * 100) / 100;
  if (Number.isFinite(minutos) && Number.isFinite(segundos)) {
    cfg.segundos = Math.max(1, Math.min(3600, Math.round(Math.max(0, Math.min(60, minutos))) * 60 + Math.round(Math.max(0, Math.min(59, segundos)))));
  }
  if (Number.isFinite(preinicio)) cfg.preinicioSegundos = Math.max(0, Math.min(120, Math.round(preinicio)));
  guardarDatos();
  res.redirect(adminDeviceUrl(id));
});

app.get("/admin/prototype/usage-backup.csv", (req, res) => {
  const events = eventosUsoDevice(PROTOTYPE_DEVICE_ID);
  const columns = [
    "event_id", "payment_id", "device_id", "approved_at", "started_at", "finished_at",
    "amount_ars", "mp_fee_ars", "net_after_mp_ars", "sold_seconds", "actual_seconds",
    "evetec_ars", "owner_ars",
    ...PARTICIPANT_NUMBERS.flatMap(index => [`participant_${index}`, `participant_${index}_net`]),
    "mode", "completed"
  ];
  const rows = events.map(e => [
    e.event_id, e.payment_id, e.device_id,
    e.approved_epoch ? new Date(Number(e.approved_epoch) * 1000).toISOString() : "",
    e.started_epoch ? new Date(Number(e.started_epoch) * 1000).toISOString() : "",
    e.finished_epoch ? new Date(Number(e.finished_epoch) * 1000).toISOString() : "",
    (Number(e.amount_cents || 0) / 100).toFixed(2),
    (Number(e.mp_fee_cents || 0) / 100).toFixed(2),
    ((Number(e.amount_cents || 0) - Number(e.mp_fee_cents || 0)) / 100).toFixed(2),
    Number(e.sold_seconds || 0), Number(e.actual_seconds || 0),
    (Number(e.evetec_cents || 0) / 100).toFixed(2),
    (Number(e.owner_cents || 0) / 100).toFixed(2),
    ...PARTICIPANT_NUMBERS.map(number => number - 1).flatMap(index => {
      const p = (e.participants || [])[index] || {};
      return [p.nombre || "", (Number(p.neto_cents || 0) / 100).toFixed(2)];
    }),
    e.mode || "", e.completed !== false ? "yes" : "no"
  ]);
  const csv = "\uFEFF" + [columns, ...rows].map(row => row.map(celdaCsv).join(",")).join("\r\n");
  const stamp = new Date().toISOString().slice(0, 10);
  res.set("Content-Type", "text/csv; charset=utf-8");
  res.set("Content-Disposition", `attachment; filename="evetec-${PROTOTYPE_DEVICE_ID}-${stamp}.csv"`);
  res.send(csv);
});

app.post("/admin/prototype/backup-confirm", (req, res) => {
  const d = asegurarDevice(PROTOTYPE_DEVICE_ID);
  d.backupConfirmedCount = eventosUsoDevice(PROTOTYPE_DEVICE_ID).length;
  d.backupConfirmedAt = new Date().toISOString();
  guardarDatos();
  res.redirect("/admin");
});

app.post("/admin/prototype/toggle-sales-log", (req, res) => {
  const d = asegurarDevice(PROTOTYPE_DEVICE_ID);
  d.registroVentasHabilitado = d.registroVentasHabilitado === false;
  guardarDatos();
  res.redirect("/admin");
});

app.get("/admin/prototype/live-stats", (req, res) => {
  const usageList = eventosUsoDevice(PROTOTYPE_DEVICE_ID);
  const d = asegurarDevice(PROTOTYPE_DEVICE_ID);
  const stats = usageList.length ? statsDesdeUso(PROTOTYPE_DEVICE_ID) : (d.stats || statsIniciales());
  res.set("Cache-Control", "no-store");
  res.json({
    ok: true,
    comisionesMp: Number(stats.comisionesMp || 0),
    netoDespuesMp: Number(stats.netoDespuesMp || 0),
    pagosAprobados: Number(stats.pagosAprobados || 0),
    participantTotals: stats.participantTotals || {}
  });
});

app.post("/admin/prototype/distribution-update", (req, res) => {
  const d = asegurarDevice(PROTOTYPE_DEVICE_ID);
  const participants = PARTICIPANT_NUMBERS.map(index => ({
    id: `p${index}`,
    nombre: String(req.body[`participant_name_${index}`] || "").trim().slice(0, 40),
    porcentaje: Math.max(0, Math.min(100, Number(req.body[`participant_pct_${index}`] || 0)))
  }));
  const active = participants.filter(p => p.nombre && p.porcentaje > 0);
  const total = active.reduce((sum, p) => sum + p.porcentaje, 0);
  if (!active.length || Math.abs(total - 100) > 0.001) {
    return res.redirect(`/admin?dist_error=${encodeURIComponent("Los participantes activos deben sumar exactamente 100%.")}`);
  }
  if (participants.some(p => (!p.nombre && p.porcentaje > 0) || (p.nombre && p.porcentaje <= 0))) {
    return res.redirect(`/admin?dist_error=${encodeURIComponent("Cada participante debe tener nombre y un porcentaje mayor a cero.")}`);
  }
  d.participantes = participants;
  d.pagadorComisionMp = "proportional";
  guardarDatos();
  res.redirect("/admin");
});

app.post("/admin/prototype/update", (req, res) => {
  const d = asegurarDevice(PROTOTYPE_DEVICE_ID);
  const cfg = configuracionServicioDevice(PROTOTYPE_DEVICE_ID);
  const activo = req.body.activo === "on";
  const modo = String(req.body.modoCobro || "owner_commission");
  const monto = Number(req.body.monto);
  const minutosServicio = Number(req.body.minutos);
  const segundosServicio = Number(req.body.segundosServicio);
  const segundosAnteriores = Number(req.body.segundos);
  const preinicio = Number(req.body.preinicioSegundos);
  const comision = Number(req.body.comision);

  configGlobal.activo = activo;
  cfg.activo = activo;
  d.activo = activo;
  d.modoMantenimiento = req.body.mantenimiento === "on";
  cfg.preinicioHabilitado = req.body.preinicioHabilitado === "on";
  cfg.nombre = String(req.body.nombre || cfg.nombre).trim().slice(0, 60);
  cfg.descripcion = String(req.body.descripcion || cfg.descripcion).trim().slice(0, 120);

  if (Number.isFinite(monto) && monto > 0) cfg.monto = Math.round(monto * 100) / 100;
  if (Number.isFinite(minutosServicio) && Number.isFinite(segundosServicio)) {
    const minutosValidos = Math.max(0, Math.min(60, Math.round(minutosServicio)));
    const segundosValidos = Math.max(0, Math.min(59, Math.round(segundosServicio)));
    const duracionTotal = minutosValidos * 60 + segundosValidos;
    cfg.segundos = Math.max(1, Math.min(3600, duracionTotal));
  } else if (Number.isFinite(segundosAnteriores)) {
    // Compatibilidad con formularios o integraciones anteriores.
    cfg.segundos = Math.max(1, Math.min(3600, Math.round(segundosAnteriores)));
  }
  if (Number.isFinite(preinicio)) cfg.preinicioSegundos = Math.max(0, Math.min(120, Math.round(preinicio)));
  if (Number.isFinite(comision)) d.comisionEvetecPorcentaje = Math.max(0, Math.min(100, comision));

  d.modoCobro = ["owner_commission", "owner_direct", "evetec"].includes(modo)
    ? modo
    : "owner_commission";

  guardarDatos();
  res.redirect("/admin");
});

app.post("/admin/global/update", (req, res) => {
  configGlobal.activo = req.body.activo === "on";
  configGlobal.mensajeGlobalActivo = req.body.mensajeGlobalActivo === "on";
  configGlobal.mensajeGlobal = req.body.mensajeGlobal || "";
  guardarDatos();
  res.redirect("/admin");
});

app.post("/admin/basic/update", (req, res) => {
  const cfg = configuracionServicioDevice(PROTOTYPE_DEVICE_ID);
  cfg.activo = req.body.activo === "on";
  cfg.nombre = req.body.nombre || cfg.nombre;
  cfg.monto = Number(req.body.monto) || cfg.monto;
  cfg.segundos = Math.max(1, Math.min(3600, Number(req.body.segundos) || cfg.segundos));
  cfg.preinicioSegundos = Math.max(0, Math.min(120, Number(req.body.preinicioSegundos) || 0));
  cfg.descripcion = req.body.descripcion || cfg.descripcion;
  cfg.montoBase = cfg.montoBase || cfg.monto;
  guardarDatos();
  res.redirect("/admin");
});

function actualizarArrayPlanes(arr, body, prefijo) {
  for (let i = 0; i < 3; i++) {
    if (!arr[i]) {
      arr[i] = {
        id: `${prefijo}${i + 1}`,
        nombre: `Plan ${i + 1}`,
        segundos: 60,
        monto: 100,
        montoBase: 100,
        descripcion: ""
      };
    }

    arr[i].id = String(body[`id${i}`] || arr[i].id || `${prefijo}${i + 1}`).toUpperCase();
    arr[i].nombre = body[`nombre${i}`] || arr[i].nombre;
    arr[i].segundos = Number(body[`segundos${i}`]) || arr[i].segundos;
    arr[i].monto = Number(body[`monto${i}`]) || arr[i].monto;
    arr[i].montoBase = arr[i].montoBase || arr[i].monto;
    arr[i].descripcion = body[`descripcion${i}`] || arr[i].descripcion;
  }
}

app.post("/admin/gachapon/update", (req, res) => {
  configGlobal.gachapon.activo = req.body.activo === "on";
  configGlobal.gachapon.nombre = req.body.nombre || configGlobal.gachapon.nombre;
  configGlobal.gachapon.titulo = req.body.titulo || configGlobal.gachapon.titulo;
  configGlobal.gachapon.mensaje = req.body.mensaje || configGlobal.gachapon.mensaje;
  configGlobal.gachapon.instruccion = req.body.instruccion || configGlobal.gachapon.instruccion;
  configGlobal.gachapon.pulso_motor_ms = Math.max(100, Math.min(120000, Number(req.body.pulso_motor_ms) || configGlobal.gachapon.pulso_motor_ms));
  configGlobal.gachapon.pausa_premios_ms = Math.max(0, Math.min(30000, Number(req.body.pausa_premios_ms) || configGlobal.gachapon.pausa_premios_ms));

  for (let i = 0; i < 3; i++) {
    if (!configGlobal.gachapon.planes[i]) configGlobal.gachapon.planes[i] = {};
    const p = configGlobal.gachapon.planes[i];
    p.id = String(req.body[`id${i}`] || p.id || `G${i + 1}`).toUpperCase();
    p.creditos = Math.max(1, Math.min(99, Number(req.body[`creditos${i}`]) || p.creditos || i + 1));
    p.nombre = req.body[`nombre${i}`] || p.nombre || `${p.creditos} CREDITO`;
    p.etiqueta = req.body[`etiqueta${i}`] || p.etiqueta || "Elegir y pagar";
    p.monto = Math.max(1, Number(req.body[`monto${i}`]) || p.monto || 1000);
    p.montoBase = p.montoBase || p.monto;
    p.giro_ms = Math.max(500, Math.min(120000, Number(req.body[`giro_ms${i}`]) || p.giro_ms || 10000));
    p.descripcion = req.body[`descripcion${i}`] || p.descripcion || "";
  }

  guardarDatos();
  res.redirect("/admin");
});

app.post("/admin/arcade/update", (req, res) => {
  configGlobal.arcade.activo = req.body.activo === "on";
  configGlobal.arcade.nombre = req.body.nombre || configGlobal.arcade.nombre;
  configGlobal.arcade.titulo = req.body.titulo || configGlobal.arcade.titulo;
  configGlobal.arcade.mensaje = req.body.mensaje || configGlobal.arcade.mensaje;
  configGlobal.arcade.creditosPorPartida = Math.max(1, Math.min(10, Number(req.body.creditosPorPartida) || configGlobal.arcade.creditosPorPartida || 1));

  for (let i = 0; i < 3; i++) {
    if (!configGlobal.arcade.planes[i]) configGlobal.arcade.planes[i] = {};
    const p = configGlobal.arcade.planes[i];
    p.id = String(req.body[`id${i}`] || p.id || `A${i + 1}`).toUpperCase();
    p.creditos = Math.max(1, Math.min(99, Number(req.body[`creditos${i}`]) || p.creditos || i + 1));
    p.nombre = req.body[`nombre${i}`] || p.nombre || `${p.creditos} CREDITO`;
    p.etiqueta = req.body[`etiqueta${i}`] || p.etiqueta || "Jugar";
    p.monto = Math.max(1, Number(req.body[`monto${i}`]) || p.monto || 500);
    p.montoBase = p.montoBase || p.monto;
    p.descripcion = req.body[`descripcion${i}`] || p.descripcion || "";
  }

  guardarDatos();
  res.redirect("/admin");
});

app.post("/admin/premium/prices/update", (req, res) => {
  actualizarArrayPlanes(configGlobal.premium.planes, req.body, "P");
  guardarDatos();
  res.redirect("/admin");
});

app.post("/admin/premium/extra-prices/update", (req, res) => {
  actualizarArrayPlanes(configGlobal.premium.preciosExtra, req.body, "E");
  guardarDatos();
  res.redirect("/admin");
});

app.post("/admin/premium/promo/update", (req, res) => {
  configGlobal.premium.promoGlobal.activa = req.body.activa === "on";
  configGlobal.premium.promoGlobal.id = String(req.body.id || "PROMO").toUpperCase();
  configGlobal.premium.promoGlobal.nombre = req.body.nombre || configGlobal.premium.promoGlobal.nombre;
  configGlobal.premium.promoGlobal.segundos = Number(req.body.segundos) || configGlobal.premium.promoGlobal.segundos;
  configGlobal.premium.promoGlobal.monto = Number(req.body.monto) || configGlobal.premium.promoGlobal.monto;
  configGlobal.premium.promoGlobal.montoBase = configGlobal.premium.promoGlobal.montoBase || configGlobal.premium.promoGlobal.monto;
  configGlobal.premium.promoGlobal.descripcion = req.body.descripcion || configGlobal.premium.promoGlobal.descripcion;
  guardarDatos();
  res.redirect("/admin");
});

app.post("/admin/premium/discount", (req, res) => {
  const descuento = Number(req.body.descuento) || 0;

  configGlobal.premium.planes = configGlobal.premium.planes.map(p => ({
    ...p,
    montoBase: p.montoBase || p.monto,
    monto: aplicarDescuento(p.montoBase || p.monto, descuento)
  }));

  configGlobal.premium.preciosExtra = configGlobal.premium.preciosExtra.map(p => ({
    ...p,
    montoBase: p.montoBase || p.monto,
    monto: aplicarDescuento(p.montoBase || p.monto, descuento)
  }));

  configGlobal.mensajeGlobalActivo = true;
  configGlobal.mensajeGlobal = `Promoción premium aplicada: ${descuento}% OFF`;

  guardarDatos();
  res.redirect("/admin");
});

app.post("/admin/premium/reset-prices", (req, res) => {
  configGlobal.premium.planes = configGlobal.premium.planes.map(p => ({
    ...p,
    monto: p.montoBase || p.monto
  }));

  configGlobal.premium.preciosExtra = configGlobal.premium.preciosExtra.map(p => ({
    ...p,
    monto: p.montoBase || p.monto
  }));

  configGlobal.premium.promoGlobal.monto =
    configGlobal.premium.promoGlobal.montoBase || configGlobal.premium.promoGlobal.monto;

  configGlobal.mensajeGlobalActivo = true;
  configGlobal.mensajeGlobal = "Precios premium restaurados";

  guardarDatos();
  res.redirect("/admin");
});

app.post("/admin/device/add", (req, res) => {
  const id = String(req.body.deviceId || "").trim().toUpperCase().replace(/[^A-Z0-9_-]/g, "").slice(0, 40);
  const tipo = String(req.body.tipo || detectarTipoDevice(id)).toLowerCase();

  if (id && !devices[id]) {
    devices[id] = nuevoDevice(["basic", "premium", "gachapon", "arcade"].includes(tipo) ? tipo : detectarTipoDevice(id));
    const d = asegurarDevice(id);
    if (d.tipo === "gachapon") {
      d.configuracionGachapon.nombre = id.includes("PELUCHE") ? "Máquina de Peluches 1" : id.replace(/[_-]+/g, " ");
    } else {
      d.configuracionServicio.nombre = id.replace(/[_-]+/g, " ");
    }
  }

  guardarDatos();
  res.redirect(id ? adminDeviceUrl(id) : "/admin");
});

app.post("/admin/device/:deviceId/status", (req, res) => {
  const d = asegurarDevice(req.params.deviceId);
  d.activo = req.body.activo === "1";
  if (d.activo) d.modoMantenimiento = false;
  guardarDatos();
  res.redirect("/admin");
});

app.post("/admin/device/:deviceId/maintenance", (req, res) => {
  const d = asegurarDevice(req.params.deviceId);
  d.modoMantenimiento = req.body.mantenimiento === "1";
  if (d.modoMantenimiento) d.activo = false;
  guardarDatos();
  res.redirect("/admin");
});

app.post("/admin/device/:deviceId/commission", (req, res) => {
  const d = asegurarDevice(req.params.deviceId);
  d.comisionEvetecPorcentaje = Number(req.body.comision);

  if (!Number.isFinite(d.comisionEvetecPorcentaje)) {
    d.comisionEvetecPorcentaje = COMISION_EVETEC_PORCENTAJE;
  }

  guardarDatos();
  res.redirect("/admin");
});

app.post("/admin/device/:deviceId/billing", (req, res) => {
  const d = asegurarDevice(req.params.deviceId);
  const modo = String(req.body.modoCobro || "owner_commission");

  d.modoCobro = ["owner_commission", "owner_direct", "evetec"].includes(modo)
    ? modo
    : "owner_commission";

  guardarDatos();
  res.redirect("/admin");
});

// =====================================================
// HEALTH
// =====================================================

app.get("/health", (req, res) => {
  const deviceSummary = Object.fromEntries(
    Object.entries(devices).map(([id, d]) => [id, {
      tipo: d.tipo,
      activo: Boolean(d.activo),
      online: Boolean(d.online),
      modoMantenimiento: Boolean(d.modoMantenimiento),
      ultimaConexion: d.ultimaConexion || null,
      ownerLinked: cuentaExternaLista(d),
      ownerUserId: participantePrincipalParaCobro(d)?.userId || d.ownerUserId || null,
      modoCobro: d.modoCobro,
      sales_reset_generation: Number(d.salesResetGeneration || 0),
      comisionEvetecPorcentaje: d.comisionEvetecPorcentaje,
      telemetria: d.telemetria || null
    }])
  );

  res.json({
    ok: true,
    server: "DUAL_TIMERS_PREMIUM_BASIC",
    publicBaseUrl: PUBLIC_BASE_URL,
    redirectUri: REDIRECT_URI,
    mpClientId: Boolean(MP_CLIENT_ID),
    mpClientSecret: Boolean(MP_CLIENT_SECRET),
    fallbackToken: Boolean(EVETEC_MP_TOKEN),
    adminProtected: Boolean(ADMIN_PASSWORD),
    deviceApiProtected: Boolean(DEVICE_API_KEY),
    persistence: databaseReady ? "postgresql" : "local-file-ephemeral",
    databaseConfigured: Boolean(DATABASE_URL),
    devices: deviceSummary
  });
});

// =====================================================
// ONLINE CHECK
// =====================================================

setInterval(() => {
  const ahora = Date.now();

  for (const id of Object.keys(devices)) {
    const d = devices[id];

    if (!d.ultimaConexion) {
      d.online = false;
      continue;
    }

    d.online = ahora - new Date(d.ultimaConexion).getTime() < 20000;
  }
}, 5000);

// =====================================================
// START
// =====================================================

async function startServer() {
  await iniciarPersistencia();
  app.listen(PORT, "0.0.0.0", () => {
  console.log("=======================================");
  console.log(" SERVER DUAL - PREMIUM + BASIC");
  console.log("=======================================");
  console.log(`Servidor local: http://localhost:${PORT}`);
  console.log(`URL pública: ${PUBLIC_BASE_URL}`);
  console.log(`Redirect URI: ${REDIRECT_URI}`);
  console.log(`Admin: ${PUBLIC_BASE_URL}/admin`);
  console.log("=======================================");
  });
}

startServer().catch(err => {
  console.error("No se pudo iniciar el servidor:", err);
  process.exit(1);
});
