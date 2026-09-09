import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const port = 39200 + Math.floor(Math.random() * 500);
const dataFile = join(tmpdir(), `evetec-vending-${randomUUID()}.json`);
const child = spawn(process.execPath, ["server.js"], {
  cwd: new URL("..", import.meta.url),
  env: { ...process.env, PORT: String(port), DATA_FILE: dataFile,
    ADMIN_USERNAME: "Admin2", ADMIN_PASSWORD: "test-admin-password",
    CLIENT_SESSION_SECRET: "test-client-session-secret-at-least-32",
    VENDING_DEVICE_API_KEY: "test-vending-device-key" },
  stdio: ["ignore", "pipe", "pipe"]
});

async function waitForServer() {
  for (let i = 0; i < 40; i++) {
    try { if ((await fetch(`http://127.0.0.1:${port}/health`)).ok) return; } catch (_) {}
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  throw new Error("El servidor local no inició");
}

try {
  await waitForServer();
  const unauthorized = await fetch(`http://127.0.0.1:${port}/vending/config/EXPENDEDORA_001`);
  if (unauthorized.status !== 401) throw new Error(`Se esperaba 401, llegó ${unauthorized.status}`);
  const response = await fetch(`http://127.0.0.1:${port}/vending/config/EXPENDEDORA_001`, {
    headers: { "x-device-key": "test-vending-device-key" }
  });
  const catalog = await response.json();
  if (!response.ok || !catalog.ok || catalog.productos?.length !== 36) throw new Error("Catálogo de 36 productos inválido");
  if (catalog.productos[0].code !== "91" || catalog.productos[35].code !== "48") throw new Error("Distribución de códigos inválida");
  const admin = await fetch(`http://127.0.0.1:${port}/admin/vending?device=EXPENDEDORA_001`, {
    headers: { Authorization: `Basic ${Buffer.from("Admin2:test-admin-password").toString("base64")}` }
  });
  const html = await admin.text();
  if (!admin.ok || (html.match(/<article class="product">/g) || []).length !== 36) throw new Error("Panel de productos inválido");
  if ((html.match(/data-upload-slot=/g) || []).length !== 36) throw new Error("Carga directa de imágenes incompleta");
  if (!html.includes("Generar QR de vinculación") || !html.includes("data-admin-availability=")) throw new Error("Vinculación o disponibilidad no expuestas");
  const adminAuth = { Authorization: `Basic ${Buffer.from("Admin2:test-admin-password").toString("base64")}` };
  const availability = await fetch(`http://127.0.0.1:${port}/admin/vending/EXPENDEDORA_001/availability/1`, {
    method: "PUT", headers: { ...adminAuth, "Content-Type": "application/json" }, body: JSON.stringify({ enabled: false })
  });
  if (!availability.ok || !(await availability.json()).ok) throw new Error("No se pudo dar de baja el producto");
  const afterDisable = await fetch(`http://127.0.0.1:${port}/vending/config/EXPENDEDORA_001`, { headers: { "x-device-key": "test-vending-device-key" } });
  if ((await afterDisable.json()).productos[0].enabled !== false) throw new Error("La baja no llegó al catálogo del módulo");
  const link = await fetch(`http://127.0.0.1:${port}/admin/device/EXPENDEDORA_001/participant-link-request`, {
    method: "POST", headers: { ...adminAuth, "Content-Type": "application/json" }, body: JSON.stringify({ participantId: "p2", alias: "Dueño prueba", ownerPercentage: 85 })
  });
  const linked = await link.json();
  if (!link.ok || !linked.ok || !linked.invitation_url?.includes("/vincular/EXPENDEDORA_001/p2/")) throw new Error("Enlace de vinculación inválido");
  console.log("OK: expendedora aislada, protegida, con 36 productos y carga de imágenes");
} finally {
  child.kill("SIGTERM");
  await rm(dataFile, { force: true });
}
