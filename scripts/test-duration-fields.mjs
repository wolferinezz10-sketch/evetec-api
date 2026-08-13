import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

const projectDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const dataFile = path.join(os.tmpdir(), `evetec-duration-${Date.now()}.json`);
const port = 3111;
const child = spawn(process.execPath, ["server.js"], {
  cwd: projectDir,
  windowsHide: true,
  env: {
    ...process.env,
    PORT: String(port),
    PUBLIC_BASE_URL: `http://127.0.0.1:${port}`,
    MERCADO_PAGO_ACCESS_TOKEN: "TEST_TOKEN_NOT_USED",
    ADMIN_PASSWORD: "local-admin-test",
    DEVICE_API_KEY: "local-device-test",
    DATA_FILE: dataFile
  },
  stdio: "ignore"
});

const auth = `Basic ${Buffer.from("admin:local-admin-test").toString("base64")}`;

async function waitForServer() {
  for (let i = 0; i < 40; i++) {
    try {
      const response = await fetch(`http://127.0.0.1:${port}/health`);
      if (response.ok) return;
    } catch (_) {}
    await new Promise(resolve => setTimeout(resolve, 200));
  }
  throw new Error("El servidor local no inició");
}

try {
  await waitForServer();
  const adminHtml = await fetch(`http://127.0.0.1:${port}/admin`, {
    headers: { authorization: auth }
  }).then(response => response.text());

  if (!adminHtml.includes('name="minutos"') || !adminHtml.includes('name="segundosServicio"'))
    throw new Error("Faltan los controles separados de duración");

  const response = await fetch(`http://127.0.0.1:${port}/admin/prototype/update`, {
    method: "POST",
    redirect: "manual",
    headers: {
      authorization: auth,
      "content-type": "application/x-www-form-urlencoded"
    },
    body: new URLSearchParams({
      activo: "on",
      nombre: "Inflador Demo",
      monto: "125",
      minutos: "2",
      segundosServicio: "37",
      preinicioSegundos: "10",
      pruebaReleSegundos: "2",
      modoCobro: "evetec",
      comision: "100",
      descripcion: "Prueba de duración"
    })
  });
  if (response.status !== 302) throw new Error(`Actualización rechazada: HTTP ${response.status}`);

  const config = await fetch(`http://127.0.0.1:${port}/config/ASPIRADORA_BASIC_001`)
    .then(result => result.json());
  if (config.segundos !== 157) throw new Error(`Duración incorrecta: ${config.segundos}`);

  console.log("OK: 2 minutos + 37 segundos = 157 segundos");
} finally {
  child.kill();
  if (fs.existsSync(dataFile)) fs.rmSync(dataFile, { force: true });
}
