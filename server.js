const express = require("express");
const cors = require("cors");
const QRCode = require("qrcode");
const fs = require("fs");
const crypto = require("crypto");

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
const DEVICE_API_KEY = process.env.DEVICE_API_KEY || "";
const PROTOTYPE_DEVICE_ID = "ASPIRADORA_BASIC_001";

const DATA_FILE = process.env.DATA_FILE || "evetec-timers-data.json";
const REDIRECT_URI = `${PUBLIC_BASE_URL}/oauth/callback`;
const oauthStates = new Map();

function comparacionSegura(a, b) {
  const aa = Buffer.from(String(a || ""));
  const bb = Buffer.from(String(b || ""));
  return aa.length === bb.length && crypto.timingSafeEqual(aa, bb);
}

function requireAdmin(req, res, next) {
  if (!ADMIN_PASSWORD) {
    return res.status(503).send("Panel administrativo deshabilitado: falta ADMIN_PASSWORD.");
  }

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
    preinicioSegundos: 15,
    pruebaReleSegundos: 3,
    monto: 10,
    montoBase: 10,
    descripcion: "Inflador de autos por 4 minutos"
  },

  gachapon: {
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

    stats: statsIniciales()
  };
}

let devices = {
  [PROTOTYPE_DEVICE_ID]: nuevoDevice("basic")
};

let pagosCreados = {};

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

  if (id.includes("GACHAPON") || id.includes("GACHA")) {
    return "gachapon";
  }

  if (id.includes("BASIC") || id.includes("SIMPLE") || id.includes("BASICO") ||
      id.includes("INFLADOR")) {
    return "basic";
  }

  return "premium";
}

function limpiarDevicesMigrados(obj) {
  const actual = obj && obj[PROTOTYPE_DEVICE_ID];
  return {
    [PROTOTYPE_DEVICE_ID]: actual || nuevoDevice("basic")
  };
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
      preinicioSegundos: 15,
      pruebaReleSegundos: 3,
      monto: 10,
      montoBase: 10,
      descripcion: "Inflador de autos por 4 minutos"
    };
  }
  if (!Number.isFinite(Number(configGlobal.basic.preinicioSegundos))) {
    configGlobal.basic.preinicioSegundos = 15;
  }
  if (!Number.isFinite(Number(configGlobal.basic.pruebaReleSegundos))) {
    configGlobal.basic.pruebaReleSegundos = 3;
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
  try {
    fs.writeFileSync(
      DATA_FILE,
      JSON.stringify({ devices, pagosCreados, configGlobal }, null, 2)
    );
  } catch (err) {
    console.error("Error guardando datos:", err.message);
  }
}

function cargarDatos() {
  try {
    if (!fs.existsSync(DATA_FILE)) return;

    const data = JSON.parse(fs.readFileSync(DATA_FILE, "utf8"));

    if (data.configGlobal) {
      configGlobal = { ...configGlobal, ...data.configGlobal };
      asegurarEstructuraConfig();
    }

    if (data.devices) {
      devices = limpiarDevicesMigrados(data.devices);
    }

    if (data.pagosCreados) {
      pagosCreados = data.pagosCreados;
    }

    if (!devices[PROTOTYPE_DEVICE_ID]) {
      devices[PROTOTYPE_DEVICE_ID] = nuevoDevice("basic");
    }

    console.log("Datos EVETEC cargados");
  } catch (err) {
    console.error("Error cargando datos:", err.message);
  }
}

asegurarEstructuraConfig();
cargarDatos();
asegurarEstructuraConfig();
asegurarDevice(PROTOTYPE_DEVICE_ID);

function asegurarDevice(deviceId) {
  const id = String(deviceId || "ASPIRADORA_001").trim().toUpperCase() || "ASPIRADORA_001";

  if (!devices[id]) {
    devices[id] = nuevoDevice(detectarTipoDevice(id));
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
  if (!d.stats) d.stats = statsIniciales();
  if (!Array.isArray(d.stats.ultimosPagos)) d.stats.ultimosPagos = [];
  if (d.tipo === "arcade" && typeof d.arcadeCredits === "undefined") d.arcadeCredits = 0;

  return d;
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

  if (d.tipo === "gachapon" && !configGlobal.gachapon.activo) {
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

  if (
    (d.modoCobro === "owner_direct" || d.modoCobro === "owner_commission") &&
    d.ownerLinked &&
    d.ownerAccessToken
  ) {
    return {
      token: d.ownerAccessToken,
      usandoOwner: true
    };
  }

  return {
    token: EVETEC_MP_TOKEN,
    usandoOwner: false
  };
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

function buscarPlanGachapon(body) {
  const planes = configGlobal.gachapon.planes || [];
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
    const plan = buscarPlanGachapon(body);
    const giroMs = Math.max(500, Math.min(120000, Number(plan.giro_ms || plan.motor_ms || plan.tiempo_giro_ms || 10000)));

    return {
      device_id,
      modoSistema: "gachapon",
      plan_id: plan.id || `G${plan.creditos || 1}`,
      plan_nombre: plan.nombre || `${plan.creditos || 1} CREDITO`,
      origen: "gachapon",
      monto: Number(plan.monto || plan.precio || body.monto || 1000),
      segundos: Math.max(1, Math.ceil(giroMs / 1000)),
      motor_ms: giroMs,
      creditos: Number(plan.creditos || body.creditos || 1),
      etiqueta: plan.etiqueta || ""
    };
  }

  if (d.tipo === "basic") {
    return {
      device_id,
      modoSistema: "basic",
      plan_id: "BASIC",
      plan_nombre: configGlobal.basic.nombre || "Uso básico",
      origen: "basic",
      monto: Number(configGlobal.basic.monto),
      segundos: Number(configGlobal.basic.segundos)
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
    const g = configGlobal.gachapon;
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
      pulso_motor_ms: Number(g.pulso_motor_ms || 10000),
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
      planes: (g.planes || []).slice(0, 3).map(p => ({
        id: p.id,
        creditos: Number(p.creditos || 1),
        nombre: p.nombre,
        etiqueta: p.etiqueta,
        monto: Number(p.monto || 0),
        precio: Number(p.monto || 0),
        giro_ms: Number(p.giro_ms || 10000),
        tiempo_giro_ms: Number(p.giro_ms || 10000),
        motor_ms: Number(p.giro_ms || 10000),
        descripcion: p.descripcion || ""
      })),
      ownerLinked: Boolean(d.ownerLinked && d.ownerAccessToken),
      modoCobro: d.modoCobro,
      comisionEvetecPorcentaje: d.comisionEvetecPorcentaje,
      serverTime: new Date().toISOString()
    });
  }

  if (d.tipo === "basic") {
    return res.json({
      ok: true,
      tipo: "basic",
      activo: operativo.ok,
      motivo: operativo.motivo,
      mensaje: operativo.ok ? configGlobal.mensajeGlobal : operativo.mensaje,
      precio: Number(configGlobal.basic.monto),
      monto: Number(configGlobal.basic.monto),
      segundos: Number(configGlobal.basic.segundos),
      preinicio_segundos: Number(configGlobal.basic.preinicioSegundos || 15),
      prueba_rele_segundos: Number(configGlobal.basic.pruebaReleSegundos || 3),
      nombre: configGlobal.basic.nombre,
      descripcion: configGlobal.basic.descripcion,
      ownerLinked: Boolean(d.ownerLinked && d.ownerAccessToken),
      modoCobro: d.modoCobro,
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
      ownerLinked: Boolean(d.ownerLinked && d.ownerAccessToken),
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
    ownerLinked: Boolean(d.ownerLinked && d.ownerAccessToken),
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

  const { token, usandoOwner } = obtenerTokenParaCobrar(pedido.device_id);

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

  const body = {
    items: [
      {
        title: `${pedido.plan_nombre} - ${pedido.device_id}`,
        quantity: 1,
        currency_id: configGlobal.moneda || "ARS",
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

  const r = await fetch("https://api.mercadopago.com/checkout/preferences", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json"
    },
    body: JSON.stringify(body)
  });

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
    comisionEvetec: comision,
    netoDuenioEstimado,
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
    creditos: pedido.creditos || 0
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

  const { token } = deviceId
    ? obtenerTokenParaCobrar(deviceId)
    : { token: EVETEC_MP_TOKEN };

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

    const r = await fetch(url, {
      headers: {
        Authorization: `Bearer ${token}`
      }
    });

    const data = await r.json();

    if (r.ok && Array.isArray(data.results) && data.results.length > 0) {
      const pago = data.results[0];

      const estado = pago.status || "pending";
      const detalle = pago.status_detail || "";
      const referenciaValida = String(pago.external_reference || "") === String(externalRef);
      const montoEsperado = Number(pagoLocal?.monto || 0);
      const montoValido = montoEsperado > 0 &&
        Math.abs(Number(pago.transaction_amount || 0) - montoEsperado) < 0.001;
      const monedaValida = String(pago.currency_id || "") === String(configGlobal.moneda || "ARS");
      const verificado = referenciaValida && montoValido && monedaValida;
      const estadoSeguro = estado === "approved" && !verificado ? "invalid" : estado;

      if (pagoLocal) {
        pagoLocal.estado = estadoSeguro;
        pagoLocal.payment_id = pago.id;
        pagoLocal.detalle = detalle;
        pagoLocal.verificado = verificado;
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
    registrarPagoVerificado(pagoLocal, estado.payment_id);
    guardarDatos();

    return res.json({
      ok: true,
      activate: true,
      status: "approved",
      payment_id: estado.payment_id,
      monto: Number(pagoLocal.monto || 0),
      segundos: Math.max(1, Math.min(3600, Number(pagoLocal.segundos || 0)))
    });
  } catch (err) {
    console.error("Error /device/claim-payment:", err.message);
    return res.status(500).json({ ok: false, activate: false, status: "server_error" });
  }
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

app.get("/oauth/callback", async (req, res) => {
  const code = req.query.code;
  const stateToken = String(req.query.state || "");
  const stateData = oauthStates.get(stateToken);
  oauthStates.delete(stateToken);
  const deviceId = stateData && stateData.expiresAt >= Date.now()
    ? String(stateData.deviceId || "").toUpperCase()
    : "";

  if (!code || !deviceId) {
    return res.send("<h2>Sistema</h2><p>Faltan datos de autorización.</p>");
  }

  try {
    const d = asegurarDevice(deviceId);

    const r = await fetch("https://api.mercadopago.com/oauth/token", {
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

    d.ownerAccessToken = data.access_token;
    d.ownerRefreshToken = data.refresh_token || null;
    d.ownerUserId = data.user_id || null;
    d.ownerLinked = true;

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
          <p>La máquina <b>${escaparHtml(deviceId)}</b> ya puede cobrar con esta cuenta de Mercado Pago.</p>
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
  const d = asegurarDevice(req.params.deviceId);

  d.ownerLinked = false;
  d.ownerAccessToken = null;
  d.ownerRefreshToken = null;
  d.ownerUserId = null;
  d.ownerEmail = "";

  guardarDatos();

  res.redirect("/admin");
});

app.get("/owner-status/:deviceId", (req, res) => {
  const d = asegurarDevice(req.params.deviceId);

  res.json({
    ok: true,
    linked: Boolean(d.ownerLinked && d.ownerAccessToken),
    ownerUserId: d.ownerUserId || null,
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
// ADMIN
// =====================================================

app.get("/", (req, res) => {
  res.redirect("/admin");
});

app.get("/admin", (req, res) => {
  const id = PROTOTYPE_DEVICE_ID;
  const d = asegurarDevice(id);
  const cfg = configGlobal.basic;
  const stats = d.stats || statsIniciales();
  const ultimoPago = stats.ultimosPagos?.[0] || null;
  const ultimaConexion = d.ultimaConexion
    ? new Date(d.ultimaConexion).toLocaleString("es-AR")
    : "Nunca";
  const pagos = Object.values(pagosCreados)
    .filter((p, index, arr) => p.device_id === id && arr.findIndex(x => x.external_reference === p.external_reference) === index)
    .slice(-15)
    .reverse();

  let pagosHtml = pagos.map(p => `
    <tr>
      <td>${escaparHtml(new Date(p.fecha || p.created_at || Date.now()).toLocaleString("es-AR"))}</td>
      <td>${escaparHtml(p.external_reference || "-")}</td>
      <td>$${formatoDinero(p.monto)}</td>
      <td>${formatoTiempo(p.segundos)}</td>
      <td><span class="pill ${p.estado === "approved" ? "success" : "muted"}">${escaparHtml(p.estado || "pendiente")}</span></td>
    </tr>
  `).join("");

  if (!pagosHtml) pagosHtml = `<tr><td colspan="5" class="empty">Todavía no hay pagos registrados para este equipo.</td></tr>`;

  res.send(`<!doctype html>
  <html lang="es">
  <head>
    <meta charset="utf-8">
    <meta name="viewport" content="width=device-width, initial-scale=1">
    <title>EVETEC | Aspiradora QR</title>
    <style>
      :root{color-scheme:dark;--bg:#07111f;--panel:#101d2d;--panel2:#142438;--line:#263a50;--text:#f4f8fb;--muted:#91a4b7;--cyan:#27d3e2;--green:#38d987;--red:#ff6474;--yellow:#ffc857}
      *{box-sizing:border-box}body{margin:0;background:radial-gradient(circle at 80% 0,#12324a 0,transparent 34%),var(--bg);color:var(--text);font:15px Inter,Segoe UI,Arial,sans-serif}
      main{width:min(1120px,calc(100% - 32px));margin:auto;padding:34px 0 60px}.top{display:flex;justify-content:space-between;gap:24px;align-items:center;margin-bottom:24px}
      .brand{font-size:13px;letter-spacing:.22em;color:var(--cyan);font-weight:800}.top h1{margin:7px 0 5px;font-size:clamp(27px,4vw,42px)}.sub,.hint{color:var(--muted)}
      .status{display:flex;align-items:center;gap:9px;background:var(--panel);border:1px solid var(--line);border-radius:999px;padding:10px 15px;font-weight:700}.dot{width:9px;height:9px;border-radius:50%;background:${d.online ? "var(--green)" : "var(--red)"};box-shadow:0 0 12px currentColor}
      .stats,.columns{display:grid;gap:16px}.stats{grid-template-columns:repeat(4,1fr);margin-bottom:16px}.columns{grid-template-columns:1.25fr .75fr}.card{background:linear-gradient(145deg,var(--panel),#0c1826);border:1px solid var(--line);border-radius:18px;padding:22px;box-shadow:0 16px 45px #0004}.stat b{display:block;font-size:25px;margin-top:8px}.label{font-size:12px;text-transform:uppercase;letter-spacing:.1em;color:var(--muted);font-weight:700}
      h2{margin:0 0 18px;font-size:20px}h3{margin:25px 0 12px;color:var(--cyan);font-size:14px;text-transform:uppercase;letter-spacing:.08em}.form-grid{display:grid;grid-template-columns:repeat(2,1fr);gap:15px}.field{display:flex;flex-direction:column;gap:7px}.wide{grid-column:1/-1}label{font-weight:650}input,select{width:100%;background:#091522;color:var(--text);border:1px solid var(--line);border-radius:10px;padding:11px 12px;font:inherit;outline:none}input:focus,select:focus{border-color:var(--cyan)}
      .switches{display:flex;flex-wrap:wrap;gap:12px;margin-bottom:20px}.check{display:flex;align-items:center;gap:9px;background:var(--panel2);border:1px solid var(--line);border-radius:10px;padding:11px 13px}.check input{width:auto;margin:0}.actions{display:flex;flex-wrap:wrap;gap:9px;margin-top:20px}.btn{display:inline-flex;align-items:center;justify-content:center;border:0;border-radius:10px;padding:11px 15px;text-decoration:none;font-weight:800;cursor:pointer}.primary{background:var(--cyan);color:#03141a}.secondary{background:#20344a;color:var(--text);border:1px solid #34506d}.danger{background:#421d29;color:#ffb3bc;border:1px solid #7b3041}
      .owner{background:var(--panel2);border:1px solid var(--line);border-radius:14px;padding:16px}.owner-line{display:flex;justify-content:space-between;gap:12px;margin:8px 0}.pill{display:inline-block;border-radius:999px;padding:4px 9px;font-size:12px;font-weight:800}.success{background:#123d2d;color:#70f0ad}.muted{background:#293746;color:#b9c7d5}.warning{background:#493b18;color:#ffe08a}
      table{width:100%;border-collapse:collapse}th,td{padding:12px 10px;border-bottom:1px solid var(--line);text-align:left}th{color:var(--muted);font-size:12px;text-transform:uppercase}.table-wrap{overflow:auto}.empty{text-align:center;color:var(--muted);padding:25px}.footer{margin-top:14px;color:var(--muted);font-size:12px}
      @media(max-width:800px){.stats{grid-template-columns:repeat(2,1fr)}.columns{grid-template-columns:1fr}.top{align-items:flex-start;flex-direction:column}}@media(max-width:520px){.form-grid{grid-template-columns:1fr}.wide{grid-column:auto}.stats{grid-template-columns:1fr 1fr}.card{padding:17px}}
    </style>
  </head>
  <body><main>
    <header class="top">
      <div><div class="brand">EVETEC AUTOMOTIVE</div><h1>Aspiradora QR</h1><div class="sub">Administración exclusiva del prototipo <b>${id}</b></div></div>
      <div class="status"><span class="dot"></span>${d.online ? "Equipo online" : "Equipo offline"}</div>
    </header>

    <section class="stats">
      <div class="card stat"><span class="label">Recaudado</span><b>$${formatoDinero(stats.totalRecaudado)}</b></div>
      <div class="card stat"><span class="label">Pagos aprobados</span><b>${stats.pagosAprobados || 0}</b></div>
      <div class="card stat"><span class="label">Tiempo vendido</span><b>${formatoTiempo(stats.segundosVendidos)}</b></div>
      <div class="card stat"><span class="label">Último pago</span><b>${ultimoPago ? `$${formatoDinero(ultimoPago.monto)}` : "—"}</b></div>
    </section>

    <section class="columns">
      <div class="card">
        <h2>Configuración del servicio</h2>
        <form method="POST" action="/admin/prototype/update">
          <div class="switches">
            <label class="check"><input type="checkbox" name="activo" ${d.activo && cfg.activo ? "checked" : ""}> Equipo habilitado</label>
            <label class="check"><input type="checkbox" name="mantenimiento" ${d.modoMantenimiento ? "checked" : ""}> Modo mantenimiento</label>
          </div>
          <div class="form-grid">
            <div class="field wide"><label>Nombre visible</label><input name="nombre" value="${escaparHtml(cfg.nombre)}" maxlength="60" required></div>
            <div class="field"><label>Precio (ARS)</label><input name="monto" type="number" min="1" step="0.01" value="${Number(cfg.monto)}" required></div>
            <div class="field"><label>Duración del servicio (segundos)</label><input name="segundos" type="number" min="1" max="3600" value="${Number(cfg.segundos)}" required></div>
            <div class="field"><label>Espera antes de encender (segundos)</label><input name="preinicioSegundos" type="number" min="0" max="120" value="${Number(cfg.preinicioSegundos)}" required></div>
            <div class="field"><label>Prueba de relé (segundos)</label><input name="pruebaReleSegundos" type="number" min="1" max="10" value="${Number(cfg.pruebaReleSegundos)}" required></div>
            <div class="field"><label>Tipo de cobro</label><select name="modoCobro">
              <option value="owner_commission" ${d.modoCobro === "owner_commission" ? "selected" : ""}>Cuenta del dueño + comisión EVETEC</option>
              <option value="owner_direct" ${d.modoCobro === "owner_direct" ? "selected" : ""}>100% directo al dueño</option>
              <option value="evetec" ${d.modoCobro === "evetec" ? "selected" : ""}>100% a cuenta EVETEC</option>
            </select></div>
            <div class="field"><label>Comisión EVETEC (%)</label><input name="comision" type="number" min="0" max="100" step="0.01" value="${Number(d.comisionEvetecPorcentaje)}" required></div>
            <div class="field wide"><label>Descripción</label><input name="descripcion" value="${escaparHtml(cfg.descripcion)}" maxlength="120"></div>
          </div>
          <div class="actions"><button class="btn primary" type="submit">Guardar cambios</button></div>
        </form>
      </div>

      <aside class="card">
        <h2>Dueño y Mercado Pago</h2>
        <div class="owner">
          <div class="owner-line"><span>Estado</span><span class="pill ${d.ownerLinked ? "success" : "warning"}">${d.ownerLinked ? "Vinculada" : "Sin vincular"}</span></div>
          <div class="owner-line"><span>Usuario MP</span><b>${escaparHtml(d.ownerUserId || "No asignado")}</b></div>
          <div class="owner-line"><span>Correo</span><b>${escaparHtml(d.ownerEmail || "No informado")}</b></div>
        </div>
        <p class="hint">Para asignar o cambiar el dueño, autorizá la cuenta correcta directamente en Mercado Pago.</p>
        <div class="actions">
          <a class="btn primary" href="/oauth/link/${encodeURIComponent(id)}">${d.ownerLinked ? "Cambiar cuenta dueña" : "Vincular cuenta dueña"}</a>
          ${d.ownerLinked ? `<form method="POST" action="/unlink-owner/${encodeURIComponent(id)}"><button class="btn danger" type="submit">Desvincular</button></form>` : ""}
        </div>
        <h3>Estado del equipo</h3>
        <div class="owner-line"><span>Última conexión</span><b>${escaparHtml(ultimaConexion)}</b></div>
        <div class="owner-line"><span>Salida</span><b>GPIO 40</b></div>
        <div class="owner-line"><span>Moneda</span><b>${escaparHtml(configGlobal.moneda || "ARS")}</b></div>
      </aside>
    </section>

    <section class="card" style="margin-top:16px"><h2>Últimos pagos de esta aspiradora</h2><div class="table-wrap"><table><thead><tr><th>Fecha</th><th>Referencia</th><th>Monto</th><th>Tiempo</th><th>Estado</th></tr></thead><tbody>${pagosHtml}</tbody></table></div></section>
    <div class="footer">Los cambios de precio y tiempos son consultados automáticamente por la pantalla. Base: ${escaparHtml(PUBLIC_BASE_URL)}</div>
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
          Prueba de relé:
          <input name="pruebaReleSegundos" value="${configGlobal.basic.pruebaReleSegundos}" size="8"> segundos<br>
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

app.post("/admin/prototype/update", (req, res) => {
  const d = asegurarDevice(PROTOTYPE_DEVICE_ID);
  const cfg = configGlobal.basic;
  const activo = req.body.activo === "on";
  const modo = String(req.body.modoCobro || "owner_commission");
  const monto = Number(req.body.monto);
  const segundos = Number(req.body.segundos);
  const preinicio = Number(req.body.preinicioSegundos);
  const prueba = Number(req.body.pruebaReleSegundos);
  const comision = Number(req.body.comision);

  configGlobal.activo = activo;
  cfg.activo = activo;
  d.activo = activo;
  d.modoMantenimiento = req.body.mantenimiento === "on";
  cfg.nombre = String(req.body.nombre || cfg.nombre).trim().slice(0, 60);
  cfg.descripcion = String(req.body.descripcion || cfg.descripcion).trim().slice(0, 120);

  if (Number.isFinite(monto) && monto > 0) cfg.monto = Math.round(monto * 100) / 100;
  if (Number.isFinite(segundos)) cfg.segundos = Math.max(1, Math.min(3600, Math.round(segundos)));
  if (Number.isFinite(preinicio)) cfg.preinicioSegundos = Math.max(0, Math.min(120, Math.round(preinicio)));
  if (Number.isFinite(prueba)) cfg.pruebaReleSegundos = Math.max(1, Math.min(10, Math.round(prueba)));
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
  configGlobal.basic.activo = req.body.activo === "on";
  configGlobal.basic.nombre = req.body.nombre || configGlobal.basic.nombre;
  configGlobal.basic.monto = Number(req.body.monto) || configGlobal.basic.monto;
  configGlobal.basic.segundos = Math.max(1, Math.min(3600, Number(req.body.segundos) || configGlobal.basic.segundos));
  configGlobal.basic.preinicioSegundos = Math.max(0, Math.min(120, Number(req.body.preinicioSegundos) || 0));
  configGlobal.basic.pruebaReleSegundos = Math.max(1, Math.min(10, Number(req.body.pruebaReleSegundos) || 3));
  configGlobal.basic.descripcion = req.body.descripcion || configGlobal.basic.descripcion;
  configGlobal.basic.montoBase = configGlobal.basic.montoBase || configGlobal.basic.monto;
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
  const id = String(req.body.deviceId || "").trim().toUpperCase();
  const tipo = String(req.body.tipo || detectarTipoDevice(id)).toLowerCase();

  if (id) {
    devices[id] = nuevoDevice(["basic", "premium", "gachapon", "arcade"].includes(tipo) ? tipo : detectarTipoDevice(id));
  }

  guardarDatos();
  res.redirect("/admin");
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
      ownerLinked: Boolean(d.ownerLinked && d.ownerAccessToken),
      ownerUserId: d.ownerUserId || null,
      modoCobro: d.modoCobro,
      comisionEvetecPorcentaje: d.comisionEvetecPorcentaje
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
