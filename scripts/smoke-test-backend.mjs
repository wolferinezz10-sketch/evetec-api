import fs from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const projectDir = path.resolve(scriptDir, "..");
const envFile = path.join(projectDir, ".env");
const testDataFile = path.join(process.env.TEMP || "C:\\Temp", "evetec-aspiradora-smoke-data.json");

function readSimpleEnv(file) {
  const result = {};
  for (const rawLine of fs.readFileSync(file, "utf8").split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) continue;
    const split = line.indexOf("=");
    if (split < 1) continue;
    result[line.slice(0, split).trim()] = line.slice(split + 1).trim();
  }
  return result;
}

const localEnv = readSimpleEnv(envFile);
const token = localEnv.MERCADO_PAGO_ACCESS_TOKEN || localEnv.MP_ACCESS_TOKEN;
if (!token) throw new Error("Falta token Mercado Pago en .env");

const port = 3107;
const child = spawn(process.execPath, ["server.js"], {
  cwd: projectDir,
  windowsHide: true,
  env: {
    ...process.env,
    PORT: String(port),
    PUBLIC_BASE_URL: "https://evetec-api.onrender.com",
    MERCADO_PAGO_ACCESS_TOKEN: token,
    ADMIN_PASSWORD: "local-admin-test",
    DEVICE_API_KEY: "local-device-test",
    DATA_FILE: testDataFile
  },
  stdio: ["ignore", "pipe", "pipe"]
});

let serverError = "";
child.stderr.on("data", chunk => {
  serverError += String(chunk);
});

async function waitForServer() {
  for (let i = 0; i < 30; i++) {
    try {
      const response = await fetch(`http://127.0.0.1:${port}/health`);
      if (response.ok) return response.json();
    } catch (_) {}
    await new Promise(resolve => setTimeout(resolve, 300));
  }
  throw new Error(`Servidor local no inicio. ${serverError.slice(0, 300)}`);
}

try {
  const health = await waitForServer();
  const healthJson = JSON.stringify(health);
  console.log(JSON.stringify({
    health_ok: health.ok === true,
    tokens_exposed: /ownerAccessToken|ownerRefreshToken/.test(healthJson),
    admin_protected: health.adminProtected === true,
    device_api_protected: health.deviceApiProtected === true,
    prototype_only: Object.keys(health.devices || {}).length === 1 && Boolean(health.devices?.ASPIRADORA_BASIC_001)
  }));

  const config = await fetch(
    `http://127.0.0.1:${port}/config/ASPIRADORA_BASIC_001`
  ).then(response => response.json());
  console.log(JSON.stringify({
    config_ok: config.ok === true,
    price: config.monto,
    seconds: config.segundos,
    active: config.activo
  }));

  const adminResponse = await fetch(`http://127.0.0.1:${port}/admin`, {
    redirect: "manual"
  });
  console.log(JSON.stringify({
    admin_without_credentials_status: adminResponse.status
  }));

  const adminHtml = await fetch(`http://127.0.0.1:${port}/admin`, {
    headers: {
      authorization: `Basic ${Buffer.from("admin:local-admin-test").toString("base64")}`
    }
  }).then(response => response.text());
  console.log(JSON.stringify({
    admin_prototype_visible: adminHtml.includes("ASPIRADORA_BASIC_001"),
    admin_has_owner_controls: adminHtml.includes("Cambiar cuenta dueña") || adminHtml.includes("Vincular cuenta dueña"),
    admin_has_service_controls: adminHtml.includes("Duración del servicio") && adminHtml.includes("Tipo de cobro"),
    admin_has_other_products: /Gachapon|Galaga|Premium: 3 precios/.test(adminHtml)
  }));

  const updateResponse = await fetch(`http://127.0.0.1:${port}/admin/prototype/update`, {
    method: "POST",
    redirect: "manual",
    headers: {
      authorization: `Basic ${Buffer.from("admin:local-admin-test").toString("base64")}`,
      "content-type": "application/x-www-form-urlencoded"
    },
    body: new URLSearchParams({
      activo: "on",
      nombre: "Aspiradora QR",
      monto: "12",
      segundos: "245",
      preinicioSegundos: "10",
      pruebaReleSegundos: "2",
      modoCobro: "owner_direct",
      comision: "0",
      descripcion: "Prueba local"
    })
  });
  const updatedConfig = await fetch(`http://127.0.0.1:${port}/config/ASPIRADORA_BASIC_001`).then(response => response.json());
  console.log(JSON.stringify({
    admin_update_redirect: updateResponse.status === 302,
    admin_update_applied: updatedConfig.monto === 12 && updatedConfig.segundos === 245 && updatedConfig.preinicio_segundos === 10
  }));

  const preference = await fetch(`http://127.0.0.1:${port}/basic/crear-pago`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ device_id: "ASPIRADORA_BASIC_001" })
  }).then(response => response.json());
  console.log(JSON.stringify({
    preference_ok: preference.ok === true,
    amount: preference.monto,
    seconds: preference.segundos,
    has_payment_id: String(preference.payment_id || "").length > 8,
    has_checkout_link: String(preference.link || "").length > 20
  }));

  if (!preference.ok) throw new Error(`Mercado Pago rechazo la preferencia: ${preference.error}`);

  const claim = await fetch(`http://127.0.0.1:${port}/device/claim-payment`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-device-key": "local-device-test"
    },
    body: JSON.stringify({
      device_id: "ASPIRADORA_BASIC_001",
      payment_id: preference.payment_id
    })
  }).then(response => response.json());
  console.log(JSON.stringify({
    pending_claim_ok: claim.ok === true,
    activate: claim.activate === true,
    status: claim.status
  }));
} finally {
  child.kill();
  fs.rmSync(testDataFile, { force: true });
}
