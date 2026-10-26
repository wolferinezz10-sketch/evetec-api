import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { once } from "node:events";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

// Integration fixture only. It never uses production credentials, a real
// Mercado Pago application, or an outgoing HTTP request from the server.
const projectDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const fixtureDir = fs.mkdtempSync(path.join(os.tmpdir(), "evetec-linking-"));
const dataFile = path.join(fixtureDir, "state.json");
const fakeDbFile = path.join(fixtureDir, "fake-postgres.json");
const fakeDbControl = path.join(fixtureDir, "fake-postgres-control.json");
const fakeDbSignal = path.join(fixtureDir, "fake-postgres-signal.json");
const port = 24000 + crypto.randomInt(10000);
const baseUrl = `http://127.0.0.1:${port}`;
const deviceId = "ASPIRADORA_BASIC_001";
const username = "cliente.linking";
const clientPassword = "Local-linking-client-2026";
const adminPassword = "Local-linking-admin-2026";
const salt = crypto.randomBytes(16).toString("hex");
const sentinel = "EXTERNAL_FETCH_BLOCKED_BY_LINKING_FIXTURE";
const results = [];
let child;
let serverLogs = "";
let clientCookie;
const adminHeaders = { authorization: `Basic ${Buffer.from(`admin:${adminPassword}`).toString("base64")}` };
const state = () => JSON.parse(fs.readFileSync(dataFile, "utf8"));
const finance = d => JSON.stringify({
  modoCobro: d.modoCobro, comisionEvetecPorcentaje: d.comisionEvetecPorcentaje,
  ownerLinked: d.ownerLinked, ownerAccessToken: d.ownerAccessToken,
  ownerRefreshToken: d.ownerRefreshToken, ownerUserId: d.ownerUserId,
  participantes: d.participantes.map(p => ({
    id: p.id, nombre: p.nombre, porcentaje: p.porcentaje, linked: p.linked,
    accessToken: p.accessToken, refreshToken: p.refreshToken, userId: p.userId
  }))
});

fs.writeFileSync(dataFile, JSON.stringify({
  devices: { [deviceId]: {
    tipo: "basic", activo: true, modoMantenimiento: false,
    modoCobro: "owner_commission", comisionEvetecPorcentaje: 40,
    cantidadParticipantes: 3, configRevision: 0,
    participantes: [
      { id: "p1", nombre: "EVETEC", porcentaje: 40 },
      { id: "p2", nombre: "Dueño fixture", porcentaje: 40, linked: true,
        accessToken: "LOCAL_OWNER_TOKEN", refreshToken: "LOCAL_OWNER_REFRESH", userId: "LOCAL_OWNER_ID" },
      { id: "p3", nombre: "Socio fixture", porcentaje: 20 }
    ],
    configuracionServicio: { activo: true, nombre: "Inflador fixture", monto: 120,
      segundos: 90, descripcion: "Servicio fixture", mensaje: "Bienvenidos",
      preinicioHabilitado: true, preinicioSegundos: 15 }
  } }, pagosCreados: {}, usageEvents: {},
  clientAccounts: { [username]: {
    username, displayName: "Cliente fixture", active: true, sessionVersion: 1,
    deviceIds: [deviceId], passwordSalt: salt,
    passwordHash: crypto.scryptSync(clientPassword, salt, 64).toString("hex")
  } }
}));

async function request(route, options = {}) {
  assert.ok(route.startsWith("/") && !route.startsWith("//"), "Solo se accede a rutas locales");
  return fetch(`${baseUrl}${route}`, { redirect: "manual", ...options });
}
function routeFromUrl(value) {
  const url = new URL(value);
  assert.equal(url.origin, baseUrl, "El QR debe apuntar al servidor local del fixture");
  return `${url.pathname}${url.search}`;
}
async function startServer(fakePg = false) {
  serverLogs = "";
  // The only successful token exchanges are deterministic, entirely in-process
  // fixtures. Any other HTTP fetch throws before opening a network connection.
  const pgMock = fakePg ? `const fs=require('node:fs');const Module=require('node:module');const originalLoad=Module._load;class FakePool{on(){}async query(sql,args=[]){if(/^\\s*SELECT payload FROM evetec_state/.test(sql))return{rows:[{payload:JSON.parse(fs.readFileSync(process.env.LINK_TEST_DB_FILE,'utf8'))}]};if(/^\\s*INSERT INTO evetec_state\\b/.test(sql)){const payload=JSON.parse(args[0]);let control=JSON.parse(fs.readFileSync(process.env.LINK_TEST_DB_CONTROL,'utf8'));if(control.hold&&payload.devices[${JSON.stringify(deviceId)}]?.participantLinkRequest?.alias===control.alias){fs.writeFileSync(process.env.LINK_TEST_DB_SIGNAL,JSON.stringify({entered:true}));while(control.hold){await new Promise(r=>setTimeout(r,15));control=JSON.parse(fs.readFileSync(process.env.LINK_TEST_DB_CONTROL,'utf8'))}if(control.fail)throw new Error('LOCAL_SIMULATED_PG_WRITE_FAILURE')}fs.writeFileSync(process.env.LINK_TEST_DB_FILE,JSON.stringify(payload));return{rows:[]}}if(/^\\s*INSERT INTO evetec_device_config\\b/.test(sql))return{rows:[{revision:Number(args[2])+1}]};return{rows:[]}}}Module._load=function(name,...rest){return name==='pg'?{Pool:FakePool}:originalLoad.call(this,name,...rest)};` : "";
  const bootstrap = `${pgMock}global.fetch=async(url,options)=>{const code=JSON.parse(options?.body||'{}').code;if(String(url)==='https://api.mercadopago.com/oauth/token'&&['LOCAL_SUCCESS','LOCAL_DELAYED_SUCCESS'].includes(code)){if(code==='LOCAL_DELAYED_SUCCESS')await new Promise(r=>setTimeout(r,250));return new Response(JSON.stringify({access_token:'LOCAL_NEW_TOKEN',refresh_token:'LOCAL_NEW_REFRESH',user_id:'LOCAL_NEW_USER',expires_in:3600}),{status:200,headers:{'Content-Type':'application/json'}})}throw new Error(${JSON.stringify(sentinel)})};require('./server.js')`;
  child = spawn(process.execPath, ["-e", bootstrap], {
    cwd: projectDir, windowsHide: true,
    env: { ...process.env, NODE_ENV: "test", RENDER: "", DATABASE_URL: fakePg ? "postgresql://local-fixture-only" : "",
      LINK_TEST_DB_FILE: fakeDbFile, LINK_TEST_DB_CONTROL: fakeDbControl, LINK_TEST_DB_SIGNAL: fakeDbSignal,
      PORT: String(port), DATA_FILE: dataFile, PUBLIC_BASE_URL: baseUrl,
      ADMIN_PASSWORD: adminPassword, CLIENT_SESSION_SECRET: adminPassword,
      DEVICE_API_KEY: "LOCAL_DEVICE_KEY", VENDING_DEVICE_API_KEY: "LOCAL_DEVICE_KEY",
      MP_CLIENT_ID: "LOCAL_TEST_APPLICATION_NOT_REAL", MP_CLIENT_SECRET: "LOCAL_TEST_SECRET",
      MERCADO_PAGO_ACCESS_TOKEN: "LOCAL_EVETEC_TOKEN", MP_ACCESS_TOKEN: "" },
    stdio: ["ignore", "pipe", "pipe"]
  });
  child.stdout.on("data", chunk => { serverLogs = (serverLogs + chunk).slice(-5000); });
  child.stderr.on("data", chunk => { serverLogs = (serverLogs + chunk).slice(-5000); });
  for (let attempt = 0; attempt < 100; attempt++) {
    if (child.exitCode !== null) throw new Error(`El servidor terminó al iniciar: ${serverLogs}`);
    try { if ((await request("/health")).ok) return; } catch (_) {}
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  throw new Error("El fixture local no inició");
}
async function stopServer() {
  if (!child || child.exitCode !== null) return;
  const closed = once(child, "close");
  child.kill();
  await closed;
}
async function check(name, task) {
  try { await task(); results.push({ name, ok: true }); }
  catch (error) { results.push({ name, ok: false, error: error.message }); }
}
async function adminPost(action, fields) {
  return request(`/admin/device/${deviceId}/${action}`, {
    method: "POST", headers: { ...adminHeaders, "content-type": "application/json" },
    body: JSON.stringify(fields)
  });
}
async function generate(participantId = "p2", alias = "Dueño fixture") {
  const response = await adminPost("participant-link-request", { participantId, alias });
  assert.equal(response.status, 200);
  const value = await response.json();
  assert.equal(value.ok, true);
  assert.equal(value.participant_id, participantId);
  return value;
}
async function authorize(invitation) {
  const response = await request(routeFromUrl(invitation.invitation_url));
  assert.equal(response.status, 302);
  const url = new URL(response.headers.get("location"));
  assert.equal(url.origin, "https://auth.mercadopago.com.ar");
  assert.equal(url.pathname, "/authorization");
  assert.equal(url.searchParams.get("client_id"), "LOCAL_TEST_APPLICATION_NOT_REAL");
  assert.equal(url.searchParams.get("response_type"), "code");
  assert.equal(url.searchParams.get("redirect_uri"), `${baseUrl}/oauth/callback`);
  const token = url.searchParams.get("state");
  assert.match(token, /^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/);
  const payload = JSON.parse(Buffer.from(token.split(".")[0], "base64url").toString("utf8"));
  assert.equal(payload.deviceId, deviceId);
  assert.equal(payload.participantId, invitation.participant_id);
  assert.ok(payload.exp > Date.now());
  assert.match(payload.requestFingerprint, /^[a-f0-9]{64}$/);
  assert.ok(payload.nonce);
  assert.ok(!JSON.stringify(payload).includes("LOCAL_OWNER_TOKEN"));
  return token;
}
async function callbackIsAccepted(token) {
  const response = await request(`/oauth/callback?state=${encodeURIComponent(token)}&code=LOCAL_CODE_NEVER_EXCHANGED`);
  const html = await response.text();
  return html.includes(sentinel);
}
async function waitForDbHold() {
  for (let attempt = 0; attempt < 150; attempt++) {
    if (fs.existsSync(fakeDbSignal)) return;
    await new Promise(resolve => setTimeout(resolve, 15));
  }
  throw new Error(`No se inició la escritura PostgreSQL simulada: ${serverLogs}`);
}
function holdDb(alias, fail = false) {
  fs.rmSync(fakeDbSignal, { force: true });
  fs.writeFileSync(fakeDbControl, JSON.stringify({ hold: true, alias, fail }));
}
function releaseDb(fail = false) {
  fs.writeFileSync(fakeDbControl, JSON.stringify({ hold: false, fail }));
}

try {
  await startServer();
  await request(`/config/${deviceId}`);
  const expectedFinance = finance(state().devices[deviceId]);
  const login = await request("/login", { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" }, body: new URLSearchParams({ username, password: clientPassword }) });
  assert.equal(login.status, 302);
  clientCookie = login.headers.get("set-cookie")?.split(";")[0];
  assert.ok(clientCookie?.startsWith("evetec_client_session="));

  await check("El cliente no puede generar, cancelar ni desvincular cuentas", async () => {
    const before = finance(state().devices[deviceId]);
    for (const action of ["participant-link-request", "participant-link-cancel", "participant-unlink"]) {
      const response = await request(`/admin/device/${deviceId}/${action}`, {
        method: "POST", headers: { cookie: clientCookie, "content-type": "application/json" },
        body: JSON.stringify({ participantId: "p2", alias: "Ataque", confirmation: "DESVINCULAR" })
      });
      assert.equal(response.status, 401);
    }
    assert.equal(finance(state().devices[deviceId]), before);
  });
  await check("EVETEC fijo y participantes inexistentes no se pueden vincular", async () => {
    assert.equal((await adminPost("participant-link-request", { participantId: "p1", alias: "EVETEC" })).status, 400);
    assert.equal((await adminPost("participant-link-request", { participantId: "p9", alias: "Inexistente" })).status, 400);
  });

  let invitation = await generate();
  await check("Orden, configuración del módulo y QR apuntan al mismo participante", async () => {
    const config = await request(`/config/${deviceId}`).then(r => r.json());
    assert.equal(config.participant_link_pending.participant_id, "p2");
    assert.equal(config.participant_link_pending.alias, "Dueño fixture");
    const qr = await request(`/oauth/participant-link/${deviceId}/p2`).then(r => r.json());
    assert.equal(qr.ok, true);
    assert.equal(qr.url, invitation.invitation_url);
    assert.equal(qr.participant_id, "p2");
    assert.ok(qr.qr_size > 0);
    assert.equal(qr.qr_matrix.length, qr.qr_size ** 2);
    assert.equal(finance(state().devices[deviceId]), expectedFinance, "Generar QR no debe borrar una autorización existente");
  });
  const firstState = await authorize(invitation);
  await check("El enlace redirige a OAuth oficial con aplicación, callback y estado correctos", async () => {
    assert.equal(await callbackIsAccepted(firstState), true, "El estado debe ser reconocido antes de reiniciar");
  });
  await check("Un token falso o un participante ajeno al QR devuelve 410", async () => {
    const invalid = new URL(invitation.invitation_url);
    invalid.pathname = invalid.pathname.replace(/[^/]+$/, "f".repeat(48));
    assert.equal((await request(routeFromUrl(invalid))).status, 410);
    assert.equal((await request(`/oauth/participant-link/${deviceId}/p3`)).status, 410);
  });

  const stateBeforeCancel = await authorize(invitation);
  await check("Cancelar invalida tanto el enlace como una autorización ya iniciada", async () => {
    assert.equal((await adminPost("participant-link-cancel", { participantId: "p2" })).status, 200);
    assert.equal((await request(routeFromUrl(invitation.invitation_url))).status, 410);
    assert.equal((await request(`/oauth/participant-link/${deviceId}/p2`)).status, 410);
    assert.equal(await callbackIsAccepted(stateBeforeCancel), false);
    assert.equal((await request(`/config/${deviceId}`).then(r => r.json())).participant_link_pending, null);
    assert.equal(finance(state().devices[deviceId]), expectedFinance);
  });

  invitation = await generate();
  const stateBeforeReplacement = await authorize(invitation);
  const replacement = await generate();
  await check("Reemplazar el QR del mismo participante invalida el anterior", async () => {
    assert.notEqual(replacement.invitation_url, invitation.invitation_url);
    assert.equal((await request(routeFromUrl(invitation.invitation_url))).status, 410);
    assert.equal(await callbackIsAccepted(stateBeforeReplacement), false);
  });
  const stateBeforeOtherParticipant = await authorize(replacement);
  await generate("p3", "Socio fixture");
  await check("Reemplazar por otro participante invalida también su autorización anterior", async () => {
    assert.equal((await request(routeFromUrl(replacement.invitation_url))).status, 410);
    assert.equal(await callbackIsAccepted(stateBeforeOtherParticipant), false,
      "El OAuth de p2 siguió vigente aunque el QR fue reemplazado por p3");
  });

  invitation = await generate();
  const stateBeforeRestart = await authorize(invitation);
  await check("Guardar precio, tiempo y mensajes conserva cuentas y porcentajes", async () => {
    const page = await request(`/cliente?device=${deviceId}`, { headers: { cookie: clientCookie } }).then(r => r.text());
    const csrf = page.match(/name="csrf" value="([^"]+)"/)?.[1];
    const revision = page.match(/name="configRevision" value="(\d+)"/)?.[1];
    assert.ok(csrf && revision !== undefined);
    const saved = await request(`/cliente/device/${deviceId}/update`, {
      method: "POST", headers: { cookie: clientCookie, "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ csrf, configRevision: revision, monto: "145.25", minutos: "2", segundosServicio: "35", nombre: "Inflador actualizado", mensaje: "Mensaje actualizado", comisionEvetecPorcentaje: "0", ownerAccessToken: "INJECTED", participant_pct_1: "0" })
    });
    assert.equal(saved.status, 302);
    assert.equal(finance(state().devices[deviceId]), expectedFinance);
    assert.equal(state().devices[deviceId].configuracionServicio.segundos, 155);
    assert.equal(state().devices[deviceId].configuracionServicio.monto, 145.25);
  });
  await stopServer();
  await startServer();
  await check("Enlace pendiente, cuentas, reparto y configuración sobreviven al reinicio", async () => {
    const qr = await request(`/oauth/participant-link/${deviceId}/p2`).then(r => r.json());
    assert.equal(qr.url, invitation.invitation_url);
    assert.equal(finance(state().devices[deviceId]), expectedFinance);
    assert.equal(state().devices[deviceId].configuracionServicio.monto, 145.25);
    assert.equal(state().devices[deviceId].configuracionServicio.segundos, 155);
    await authorize(invitation);
  });
  await check("Una autorización iniciada antes del reinicio aún reconoce su callback", async () => {
    assert.equal(await callbackIsAccepted(stateBeforeRestart), true,
      "Render perdió el estado OAuth al reiniciar; el participante tendría que abrir el enlace otra vez");
  });

  await check("Un estado alterado o vencido no llega al intercambio OAuth", async () => {
    const current = await authorize(invitation);
    const [body, signature] = current.split(".");
    const payload = JSON.parse(Buffer.from(body, "base64url").toString("utf8"));
    const alteredBody = Buffer.from(JSON.stringify({ ...payload, participantId: "p3" })).toString("base64url");
    assert.equal((await request(`/oauth/callback?state=${alteredBody}.${signature}&code=LOCAL_SUCCESS`)).status, 410);
    const expiredBody = Buffer.from(JSON.stringify({ ...payload, exp: Date.now() - 1000 })).toString("base64url");
    const expiredSignature = crypto.createHmac("sha256", adminPassword).update(expiredBody).digest("base64url");
    assert.equal((await request(`/oauth/callback?state=${expiredBody}.${expiredSignature}&code=LOCAL_SUCCESS`)).status, 410);
  });
  await check("Cancelar durante el intercambio evita una revinculación tardía", async () => {
    const pending = await generate();
    const pendingState = await authorize(pending);
    const responsePromise = request(`/oauth/callback?state=${encodeURIComponent(pendingState)}&code=LOCAL_DELAYED_SUCCESS`);
    await new Promise(resolve => setTimeout(resolve, 60));
    assert.equal((await adminPost("participant-link-cancel", { participantId: "p2" })).status, 200);
    assert.equal((await responsePromise).status, 410);
    assert.equal(finance(state().devices[deviceId]), expectedFinance);
  });
  await check("Una autorización simulada se guarda una sola vez y sobrevive al reinicio", async () => {
    const pending = await generate("p3", "Socio fixture");
    const pendingState = await authorize(pending);
    const completed = await request(`/oauth/callback?state=${encodeURIComponent(pendingState)}&code=LOCAL_SUCCESS`);
    assert.equal(completed.status, 200);
    assert.ok((await completed.text()).includes("Cuenta vinculada correctamente"));
    assert.equal((await request(routeFromUrl(pending.invitation_url))).status, 410);
    assert.equal((await request(`/oauth/callback?state=${encodeURIComponent(pendingState)}&code=LOCAL_SUCCESS`)).status, 410);
    const linked = state().devices[deviceId].participantes.find(p => p.id === "p3");
    assert.equal(linked.accessToken, "LOCAL_NEW_TOKEN");
    assert.equal(linked.refreshToken, "LOCAL_NEW_REFRESH");
    assert.equal(linked.porcentaje, 20);
    await stopServer();
    await startServer();
    const restored = state().devices[deviceId].participantes.find(p => p.id === "p3");
    assert.equal(restored.accessToken, linked.accessToken);
    assert.equal(restored.refreshToken, linked.refreshToken);
    assert.equal((await request(`/participant-status/${deviceId}/p3`).then(r => r.json())).linked, true);
  });
  await check("La vinculación heredada conserva un QR corto y se puede revocar", async () => {
    const qrResponse = await request(`/oauth/link/${deviceId}`);
    assert.equal(qrResponse.status, 200);
    const qr = await qrResponse.json();
    assert.equal(qr.ok, true);
    assert.ok(qr.url.length < 250, "El QR del firmware existente debe mantener una URL corta");
    const legacyInvitation = { participant_id: "", invitation_url: qr.url };
    const pendingState = await authorize(legacyInvitation);
    await stopServer();
    await startServer();
    assert.equal(await callbackIsAccepted(pendingState), true);
    const unlinked = await request(`/unlink-owner/${deviceId}`, {
      method: "POST", headers: { ...adminHeaders, "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ confirmation: "DESVINCULAR" })
    });
    assert.equal(unlinked.status, 302);
    assert.equal((await request(routeFromUrl(qr.url))).status, 410);
    assert.equal(await callbackIsAccepted(pendingState), false);
  });

  await stopServer();
  fs.writeFileSync(fakeDbFile, JSON.stringify(state()));
  releaseDb();
  await startServer(true);
  const dbState = () => JSON.parse(fs.readFileSync(fakeDbFile, "utf8"));
  await check("PostgreSQL lento y fallido no publica ni respalda una vinculación provisional", async () => {
    const before = finance(state().devices[deviceId]);
    holdDb("Solicitud fallida", true);
    const pending = adminPost("participant-link-request", { participantId: "p2", alias: "Solicitud fallida" });
    await waitForDbHold();
    await request("/heartbeat", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ device_id: deviceId, firmware: "LOCAL_HEARTBEAT" }) });
    assert.equal((await request(`/config/${deviceId}`).then(r => r.json())).participant_link_pending, null);
    assert.equal(state().devices[deviceId].participantLinkRequest, null);
    await new Promise(resolve => setTimeout(resolve, 350));
    releaseDb(true);
    assert.equal((await pending).status, 503);
    await new Promise(resolve => setTimeout(resolve, 350));
    assert.equal(dbState().devices[deviceId].participantLinkRequest, null);
    assert.equal(state().devices[deviceId].participantLinkRequest, null);
    assert.equal(finance(state().devices[deviceId]), before);
  });
  await check("Un heartbeat encolado durante el commit no sobrescribe la vinculación confirmada", async () => {
    holdDb("Solicitud confirmada");
    const pending = adminPost("participant-link-request", { participantId: "p2", alias: "Solicitud confirmada" });
    await waitForDbHold();
    await request("/heartbeat", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ device_id: deviceId }) });
    await new Promise(resolve => setTimeout(resolve, 350));
    releaseDb();
    assert.equal((await pending).status, 200);
    await new Promise(resolve => setTimeout(resolve, 350));
    assert.equal(dbState().devices[deviceId].participantLinkRequest.alias, "Solicitud confirmada");
    assert.equal(state().devices[deviceId].participantLinkRequest.alias, "Solicitud confirmada");
  });
  await check("Fallo OAuth concurrente conserva el reparto posterior, tokens y precio confirmado", async () => {
    const tokensBefore = state().devices[deviceId].participantes.map(p => [p.id, p.accessToken, p.refreshToken]);
    holdDb("Otra solicitud fallida", true);
    const failed = adminPost("participant-link-request", { participantId: "p2", alias: "Otra solicitud fallida" });
    await waitForDbHold();
    const distribution = request(`/admin/device/${deviceId}/distribution-update`, {
      method: "POST", headers: { ...adminHeaders, "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ participantCount: "3", participant_name_1: "EVETEC", participant_pct_1: "50", participant_name_2: "Dueño final", participant_pct_2: "30", participant_name_3: "Socio fixture", participant_pct_3: "20" })
    });
    const page = await request(`/admin?device=${deviceId}`, { headers: adminHeaders }).then(r => r.text());
    const revision = page.match(/name="configRevision" value="(\d+)"/)[1];
    const priceUpdate = await request(`/admin/device/${deviceId}/update`, {
      method: "POST", headers: { ...adminHeaders, "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ configRevision: revision, monto: "777.25", minutos: "0", segundosServicio: "45" })
    });
    assert.equal(priceUpdate.status, 302);
    releaseDb(true);
    assert.equal((await failed).status, 503);
    assert.equal((await distribution).status, 302);
    await new Promise(resolve => setTimeout(resolve, 350));
    for (const saved of [state(), dbState()]) {
      const d = saved.devices[deviceId];
      assert.deepEqual(d.participantes.slice(0, 3).map(p => p.porcentaje), [50, 30, 20]);
      assert.deepEqual(d.participantes.map(p => [p.id, p.accessToken, p.refreshToken]), tokensBefore);
      assert.equal(d.configuracionServicio.monto, 777.25);
      assert.equal(d.configuracionServicio.segundos, 45);
    }
    const legacy = await request("/admin/prototype/distribution-update", {
      method: "POST", headers: { ...adminHeaders, "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ participant_name_1: "EVETEC", participant_pct_1: "40", participant_name_2: "Dueño final", participant_pct_2: "40", participant_name_3: "Socio fixture", participant_pct_3: "20" })
    });
    assert.equal(legacy.status, 302);
    assert.deepEqual(state().devices[deviceId].participantes.map(p => [p.id, p.accessToken, p.refreshToken]), tokensBefore, "El formulario heredado tampoco debe borrar tokens");
  });

  for (const result of results) console.log(`${result.ok ? "OK" : "FAIL"}: ${result.name}${result.ok ? "" : ` — ${result.error}`}`);
  const failed = results.filter(result => !result.ok);
  console.log(`${results.length - failed.length}/${results.length} comprobaciones de vinculación correctas. Todas las solicitudes fueron locales; OAuth externo estuvo bloqueado.`);
  if (failed.length) process.exitCode = 1;
} finally {
  await stopServer();
  fs.rmSync(fixtureDir, { recursive: true, force: true });
}
