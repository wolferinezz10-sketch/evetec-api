import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { once } from "node:events";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

const projectDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const fixtureDir = fs.mkdtempSync(path.join(os.tmpdir(), "evetec-service-config-"));
const dataFile = path.join(fixtureDir, "state.json");
const port = 14000 + crypto.randomInt(10000);
const baseUrl = `http://127.0.0.1:${port}`;
const basicId = "ASPIRADORA_BASIC_001";
const plushId = "PELUCHE_001";
const otherId = "INFLADOR_AJENO_003";
const username = "cliente.local";
const password = "Local-client-test-2026";
const adminPassword = "Local-admin-test-2026";
const salt = crypto.randomBytes(16).toString("hex");
const participants = [
  { id: "p1", nombre: "EVETEC", porcentaje: 40 },
  { id: "p2", nombre: "Dueño local", porcentaje: 60, linked: true, accessToken: "LOCAL_SENTINEL_TOKEN", refreshToken: "LOCAL_SENTINEL_REFRESH", userId: "LOCAL_OWNER" }
];
const device = tipo => ({
  tipo, activo: true, modoMantenimiento: false, modoCobro: "owner_commission",
  comisionEvetecPorcentaje: 40, cantidadParticipantes: 2,
  participantes: structuredClone(participants), registroVentasHabilitado: true,
  ownerLinked: true, ownerAccessToken: "LOCAL_LEGACY_TOKEN", ownerUserId: "LOCAL_OWNER",
  configRevision: 0,
  configuracionServicio: { activo: true, nombre: "Inflador inicial", monto: 125, segundos: 157, preinicioHabilitado: true, preinicioSegundos: 15, descripcion: "Descripción inicial", mensaje: "Bienvenido" }
});
const basic = device("basic");
const plush = device("gachapon");
plush.configuracionGachapon = {
  activo: true, nombre: "Peluches inicial", titulo: "Elegí tu premio", mensaje: "Jugá con QR",
  cantidad_opciones: 2, modo_activacion: "pulsos", segundos_por_jugada: 30,
  pulso_motor_ms: 500, pausa_premios_ms: 650,
  planes: [1, 2, 3].map(count => ({ id: `G${count}`, creditos: count, nombre: `${count} JUGADAS`, monto: count * 100, etiqueta: "Pagar", giro_ms: 500 }))
};
fs.writeFileSync(dataFile, JSON.stringify({
  devices: { [basicId]: basic, [plushId]: plush, [otherId]: device("basic") },
  pagosCreados: {}, usageEvents: {},
  clientAccounts: {
    [username]: { username, displayName: "Cliente local", active: true, sessionVersion: 1, deviceIds: [basicId, plushId], passwordSalt: salt, passwordHash: crypto.scryptSync(password, salt, 64).toString("hex") }
  }
}));

let child;
let serverLogs = "";
let clientCookie;
const adminHeaders = { authorization: `Basic ${Buffer.from(`admin:${adminPassword}`).toString("base64")}` };
const state = () => JSON.parse(fs.readFileSync(dataFile, "utf8"));
const finance = d => JSON.stringify({
  modoCobro: d.modoCobro, comisionEvetecPorcentaje: d.comisionEvetecPorcentaje,
  cantidadParticipantes: d.cantidadParticipantes, participantes: d.participantes,
  ownerLinked: d.ownerLinked, ownerAccessToken: d.ownerAccessToken,
  ownerRefreshToken: d.ownerRefreshToken, ownerUserId: d.ownerUserId,
  activo: d.activo, modoMantenimiento: d.modoMantenimiento,
  registroVentasHabilitado: d.registroVentasHabilitado
});
async function request(route, options = {}) {
  assert.ok(route.startsWith("/") && !route.startsWith("//"), "Las pruebas solo acceden al servidor local");
  return fetch(`${baseUrl}${route}`, { redirect: "manual", ...options });
}
async function startServer(databaseUrl = "") {
  serverLogs = "";
  child = spawn(process.execPath, ["server.js"], {
    cwd: projectDir, windowsHide: true,
    env: { ...process.env, NODE_ENV: "test", RENDER: "", DATABASE_URL: databaseUrl, PORT: String(port), PUBLIC_BASE_URL: baseUrl, DATA_FILE: dataFile, ADMIN_PASSWORD: adminPassword, CLIENT_SESSION_SECRET: adminPassword, DEVICE_API_KEY: "LOCAL_DEVICE_KEY", MERCADO_PAGO_ACCESS_TOKEN: "LOCAL_TOKEN_NEVER_USED", MP_ACCESS_TOKEN: "", MP_CLIENT_ID: "", MP_CLIENT_SECRET: "" },
    stdio: ["ignore", "pipe", "pipe"]
  });
  child.stdout.on("data", chunk => { serverLogs = (serverLogs + chunk).slice(-4000); });
  child.stderr.on("data", chunk => { serverLogs = (serverLogs + chunk).slice(-4000); });
  for (let attempt = 0; attempt < 100; attempt++) {
    if (child.exitCode !== null) throw new Error(`El servidor terminó antes de iniciar: ${serverLogs}`);
    try { if ((await request("/health")).ok) return; } catch (_) {}
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  throw new Error(`El servidor local no inició: ${serverLogs}`);
}
async function stopServer() {
  if (!child || child.exitCode !== null) return;
  const closed = once(child, "close");
  child.kill();
  await closed;
}
async function clientForm(id) {
  const response = await request(`/cliente?device=${id}`, { headers: { cookie: clientCookie } });
  assert.equal(response.status, 200);
  const html = await response.text();
  const csrf = html.match(/name="csrf" value="([^"]+)"/)?.[1];
  const revision = html.match(/name="configRevision" value="(\d+)"/)?.[1];
  assert.ok(csrf && revision !== undefined, "El formulario debe contener sesión y revisión");
  return { html, csrf, configRevision: revision };
}
async function clientPost(id, fields, revision) {
  const form = await clientForm(basicId === id || plushId === id ? id : basicId);
  return request(`/cliente/device/${id}/update`, {
    method: "POST", headers: { cookie: clientCookie, "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ csrf: form.csrf, configRevision: revision ?? form.configRevision, ...fields })
  });
}

try {
  await startServer();
  await request(`/config/${basicId}`);
  await request(`/config/${plushId}`);
  const basicFinance = finance(state().devices[basicId]);
  const plushFinance = finance(state().devices[plushId]);
  const adminHtml = await request(`/admin?device=${basicId}`, { headers: adminHeaders }).then(r => r.text());
  assert.ok(adminHtml.includes('name="mensaje"') && adminHtml.includes('name="configRevision"'));
  assert.ok(adminHtml.includes('id="evetec-panel-mobile"') && adminHtml.includes("evetec-admin"), "El administrador debe incluir el panel adaptable sin cambiar las rutas del módulo");
  const adminRevision = adminHtml.match(/name="configRevision" value="(\d+)"/)[1];
  const adminSave = await request(`/admin/device/${basicId}/update`, {
    method: "POST", headers: { ...adminHeaders, "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ configRevision: adminRevision, activo: "on", preinicioHabilitado: "on", preinicioSegundos: "15", nombre: "Inflador administrado", monto: "150.50", minutos: "1", segundosServicio: "35", descripcion: "Descripción admin", mensaje: "Mensaje admin" })
  });
  assert.equal(adminSave.status, 302, await adminSave.text());
  let current = state().devices[basicId];
  assert.equal(current.configuracionServicio.segundos, 95);
  assert.equal(current.configuracionServicio.monto, 150.5);
  assert.equal(current.configuracionServicio.mensaje, "Mensaje admin");
  assert.equal(finance(current), basicFinance, "Guardar el servicio como admin no debe cambiar destinatarios ni porcentajes");

  const login = await request("/login", { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" }, body: new URLSearchParams({ username, password }) });
  assert.equal(login.status, 302);
  clientCookie = login.headers.get("set-cookie")?.split(";")[0];
  assert.ok(clientCookie?.startsWith("evetec_client_session="));
  assert.equal((await request("/admin", { headers: { cookie: clientCookie } })).status, 401);
  const basicForm = await clientForm(basicId);
  assert.ok(basicForm.html.includes('id="evetec-panel-mobile"') && basicForm.html.includes("evetec-client"), "El cliente debe incluir el mismo diseño móvil con navegación propia");
  assert.ok(!/name="(?:participant_pct_\d+|ownerAccessToken|comisionEvetecPorcentaje)"/.test(basicForm.html), "El formulario del cliente no expone controles financieros");
  assert.ok(basicForm.html.includes('name="nombre"') && basicForm.html.includes('name="descripcion"') && basicForm.html.includes('name="mensaje"'));
  const injected = { modoCobro: "owner_direct", comision: "0", comisionEvetecPorcentaje: "0", participantes: "[]", ownerAccessToken: "ATTACK", ownerUserId: "ATTACK", activo: "off", mantenimiento: "on", preinicioSegundos: "0" };
  const save = await clientPost(basicId, { ...injected, nombre: "Mi inflador", descripcion: "Mi descripción", mensaje: "Bienvenidos", monto: "245.75", minutos: "2", segundosServicio: "7" });
  assert.equal(save.status, 302, await save.text());
  current = state().devices[basicId];
  assert.equal(current.configuracionServicio.segundos, 127);
  assert.equal(current.configuracionServicio.monto, 245.75);
  assert.equal(current.configuracionServicio.nombre, "Mi inflador");
  assert.equal(current.configuracionServicio.preinicioSegundos, 15);
  assert.equal(finance(current), basicFinance, "El cliente no debe cambiar datos financieros ni controles administrativos");
  assert.equal((await clientPost(basicId, { monto: "900" }, basicForm.configRevision)).status, 409, "Un formulario antiguo no debe pisar cambios posteriores");
  assert.equal((await clientPost(otherId, { monto: "999" })).status, 403);
  assert.equal((await clientPost(basicId, { monto: "" })).status, 400);
  assert.equal((await clientPost(basicId, { segundosServicio: "59.5" })).status, 400);
  assert.equal((await clientPost(basicId, { nombre: "Solo texto", descripcion: "", mensaje: "" })).status, 302);
  current = state().devices[basicId];
  assert.equal(current.configuracionServicio.segundos, 127, "Un cambio solo de texto debe conservar el tiempo");
  assert.equal(current.configuracionServicio.monto, 245.75, "Un cambio solo de texto debe conservar el precio");
  assert.equal(current.configuracionServicio.descripcion, "");
  assert.equal(current.configuracionServicio.mensaje, "");
  assert.equal((await clientPost(plushId, { ...injected, nombre: "Mis peluches", titulo: "Elegí y jugá", mensaje: "Tu próximo premio", segundosPorJugada: "41", monto0: "50.25", monto1: "80.50", modoActivacion: "tiempo", cantidadOpciones: "1", pulsoMotorMs: "100" })).status, 302);
  const plushSaved = state().devices[plushId];
  assert.equal(plushSaved.configuracionGachapon.titulo, "Elegí y jugá");
  assert.equal(plushSaved.configuracionGachapon.segundos_por_jugada, 41);
  assert.equal(plushSaved.configuracionGachapon.planes[0].monto, 50.25);
  assert.equal(plushSaved.configuracionGachapon.planes[1].monto, 80.5);
  assert.equal(plushSaved.configuracionGachapon.modo_activacion, "pulsos");
  assert.equal(plushSaved.configuracionGachapon.cantidad_opciones, 2);
  assert.equal(plushSaved.configuracionGachapon.pulso_motor_ms, 500);
  assert.equal(finance(plushSaved), plushFinance);
  const concurrentForm = await clientForm(basicId);
  const concurrent = await Promise.all([
    clientPost(basicId, { monto: "300.25" }, concurrentForm.configRevision),
    clientPost(basicId, { monto: "400.50" }, concurrentForm.configRevision)
  ]);
  assert.deepEqual(concurrent.map(result => result.status).sort(), [302, 409], "Dos guardados simultáneos de la misma revisión no deben sobrescribirse");
  const savedBasic = structuredClone(state().devices[basicId].configuracionServicio);
  const savedPlush = structuredClone(plushSaved.configuracionGachapon);
  await stopServer();
  await startServer();
  await clientForm(basicId);
  assert.deepEqual(state().devices[basicId].configuracionServicio, savedBasic, "La configuración del inflador debe sobrevivir al reinicio");
  assert.deepEqual(state().devices[plushId].configuracionGachapon, savedPlush, "La configuración de peluches debe sobrevivir al reinicio");
  assert.equal(finance(state().devices[basicId]), basicFinance);
  assert.equal(finance(state().devices[plushId]), plushFinance);
  await stopServer();
  // El puerto 1 de loopback rechaza PostgreSQL sin consultar ningún servicio externo.
  await startServer("postgresql://local_test:local_test@127.0.0.1:1/evetec");
  const beforeFailure = await request(`/config/${basicId}`).then(result => result.json());
  const failedClient = await clientPost(basicId, { monto: "999.99", minutos: "9", segundosServicio: "9", nombre: "No debe publicarse" });
  assert.equal(failedClient.status, 503, "La falla persistente debe informarse al cliente");
  const failureAdminHtml = await request(`/admin?device=${basicId}`, { headers: adminHeaders }).then(result => result.text());
  const failedAdmin = await request(`/admin/device/${basicId}/update`, {
    method: "POST", headers: { ...adminHeaders, "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ configRevision: failureAdminHtml.match(/name="configRevision" value="(\d+)"/)[1], monto: "888", minutos: "8", segundosServicio: "8", nombre: "Tampoco publicar", mantenimiento: "on" })
  });
  assert.equal(failedAdmin.status, 503, "La falla persistente debe informarse al administrador");
  const afterFailure = await request(`/config/${basicId}`).then(result => result.json());
  for (const field of ["monto", "segundos", "nombre", "descripcion", "mensaje", "activo", "mantenimiento", "modoCobro", "comisionEvetecPorcentaje"]) {
    assert.deepEqual(afterFailure[field], beforeFailure[field], `Una falla al guardar no debe alterar ${field} enviado al módulo`);
  }
  assert.deepEqual(state().devices[basicId].configuracionServicio, savedBasic);
  assert.equal(finance(state().devices[basicId]), basicFinance);
  await stopServer();
  fs.renameSync(dataFile, path.join(fixtureDir, "last-confirmed-state.json"));
  await assert.rejects(
    startServer("postgresql://local_test:local_test@127.0.0.1:1/evetec"),
    /El servidor terminó antes de iniciar/,
    "Sin base disponible ni respaldo válido, el servidor debe rechazar el arranque para no cobrar valores predeterminados"
  );
  assert.notEqual(child.exitCode, 0);
  await assert.rejects(request("/health"), "El servidor sin configuración restaurada no debe escuchar peticiones");
  console.log("OK: admin y cliente guardan precio, tiempo y textos; destinatarios protegidos, concurrencia y conflictos controlados, reinicio conserva datos, PostgreSQL caído devuelve 503 sin publicar cambios y arranque sin respaldo queda bloqueado. Sin llamadas externas.");
} finally {
  await stopServer();
  fs.rmSync(fixtureDir, { recursive: true, force: true });
}
