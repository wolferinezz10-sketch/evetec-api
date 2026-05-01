const express = require("express");
const cors = require("cors");
const QRCode = require("qrcode");
const fs = require("fs");

const app = express();

app.use(cors());
app.use(express.json({ limit: "2mb" }));
app.use(express.urlencoded({ extended: true }));

const PORT = Number(process.env.PORT || 3000);
const PUBLIC_BASE_URL = process.env.PUBLIC_BASE_URL || "https://evetec-api.onrender.com";

const MP_CLIENT_ID = process.env.MP_CLIENT_ID || "";
const MP_CLIENT_SECRET = process.env.MP_CLIENT_SECRET || "";
const EVETEC_MP_TOKEN = process.env.MERCADO_PAGO_ACCESS_TOKEN || "";
const COMISION_EVETEC_PORCENTAJE = Number(process.env.COMISION_EVETEC || 15);

const DATA_FILE = process.env.DATA_FILE || "evetec-timers-data.json";
const REDIRECT_URI = `${PUBLIC_BASE_URL}/oauth/callback`;

function statsIniciales() {
  return {
    totalRecaudado: 0,
    pagosAprobados: 0,
    segundosVendidos: 0,
    tiempoMotor: 0,
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
    nombre: "Uso básico",
    segundos: 30,
    monto: 100,
    montoBase: 100,
    descripcion: "Sistema básico QR fijo"
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
  ASPIRADORA_001: nuevoDevice("premium"),
  ASPIRADORA_002: nuevoDevice("premium"),
  ASPIRADORA_BASIC_001: nuevoDevice("basic")
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

function detectarTipoDevice(deviceId) {
  const id = String(deviceId || "").toUpperCase();

  if (id.includes("BASIC") || id.includes("SIMPLE") || id.includes("BASICO")) {
    return "basic";
  }

  return "premium";
}

function limpiarDevicesMigrados(obj) {
  const limpio = {};

  for (const id of Object.keys(obj || {})) {
    const upper = String(id).toUpperCase();

    if (upper.includes("GALAGA")) continue;
    if (upper.includes("GAME")) continue;
    if (upper.includes("ARCADE")) continue;

    limpio[id] = obj[id];
  }

  return limpio;
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
      nombre: "Uso básico",
      segundos: 30,
      monto: 100,
      montoBase: 100,
      descripcion: "Sistema básico QR fijo"
    };
  }

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

    if (!devices.ASPIRADORA_001) devices.ASPIRADORA_001 = nuevoDevice("premium");
    if (!devices.ASPIRADORA_BASIC_001) devices.ASPIRADORA_BASIC_001 = nuevoDevice("basic");

    console.log("Datos EVETEC cargados");
  } catch (err) {
    console.error("Error cargando datos:", err.message);
  }
}

asegurarEstructuraConfig();
cargarDatos();
asegurarEstructuraConfig();

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

  return Math.max(0, Math.round(Number(monto) * porcentaje / 100));
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

function normalizarPedidoPago(body) {
  const device_id = String(body.device_id || body.deviceId || "ASPIRADORA_001").toUpperCase();
  const d = asegurarDevice(device_id);

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
      nombre: configGlobal.basic.nombre,
      descripcion: configGlobal.basic.descripcion,
      ownerLinked: Boolean(d.ownerLinked && d.ownerAccessToken),
      modoCobro: d.modoCobro,
      mantenimiento: d.modoMantenimiento,
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

app.post("/device/payment-log", (req, res) => {
  try {
    const device_id = String(req.body.device_id || req.body.deviceId || "ASPIRADORA_001").toUpperCase();
    const monto = Number(req.body.monto || 0);
    const segundos = Number(req.body.segundos || 0);
    const fecha = req.body.fecha || new Date().toISOString();

    const d = asegurarDevice(device_id);

    d.stats.totalRecaudado += monto;
    d.stats.pagosAprobados += 1;
    d.stats.segundosVendidos += segundos;
    d.stats.tiempoMotor += segundos;

    d.stats.ultimosPagos.unshift({
      monto,
      segundos,
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

  if (!pedido.segundos || pedido.segundos <= 0) {
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
      monto_total: pedido.monto,
      comision_evetec: comision,
      neto_duenio_estimado: netoDuenioEstimado,
      modo_cobro: d.modoCobro,
      owner_linked: Boolean(d.ownerLinked)
    }
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
    segundos: pedido.segundos
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

      if (pagoLocal) {
        pagoLocal.estado = estado;
        pagoLocal.payment_id = pago.id;
        pagoLocal.detalle = detalle;
        pagoLocal.actualizado = new Date().toISOString();
        guardarDatos();
      }

      return {
        estado,
        status: estado,
        detalle,
        payment_id: pago.id,
        segundos: pagoLocal?.segundos || pago.metadata?.segundos || 0,
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

    const url =
      "https://auth.mercadopago.com.ar/authorization" +
      `?response_type=code` +
      `&client_id=${encodeURIComponent(MP_CLIENT_ID)}` +
      `&redirect_uri=${encodeURIComponent(REDIRECT_URI)}` +
      `&state=${encodeURIComponent(deviceId)}`;

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
  const deviceId = String(req.query.state || "").toUpperCase();

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

app.post("/unlink-owner/:deviceId", (req, res) => {
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
// =====================================================
// ADMIN
// =====================================================

app.get("/", (req, res) => {
  res.redirect("/admin");
});

app.get("/admin", (req, res) => {
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
        <td class="${d.tipo === "basic" ? "basic" : "premium"}">${d.tipo === "basic" ? "BÁSICO" : "PREMIUM"}</td>
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
        <h2>Sistema básico QR fijo</h2>
        <form method="POST" action="/admin/basic/update">
          Activo:
          <input type="checkbox" name="activo" ${configGlobal.basic.activo ? "checked" : ""}><br>
          Nombre:
          <input name="nombre" value="${escaparHtml(configGlobal.basic.nombre)}" size="18"><br>
          Precio:
          <input name="monto" value="${configGlobal.basic.monto}" size="8">
          Segundos:
          <input name="segundos" value="${configGlobal.basic.segundos}" size="8"><br>
          Descripción:
          <input name="descripcion" value="${escaparHtml(configGlobal.basic.descripcion)}" size="42"><br>
          <button class="save" type="submit">Guardar básico</button>
        </form>
      </div>
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
        <td class="${d.tipo === "basic" ? "basic" : "premium"}">${d.tipo === "basic" ? "BÁSICO" : "PREMIUM"}</td>
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
        <input name="deviceId" value="ASPIRADORA_BASIC_002" size="24">
        Tipo:
        <select name="tipo">
          <option value="basic">Básico</option>
          <option value="premium">Premium</option>
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
});

// =====================================================
// ACCIONES ADMIN
// =====================================================

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
  configGlobal.basic.segundos = Number(req.body.segundos) || configGlobal.basic.segundos;
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
    devices[id] = nuevoDevice(tipo === "basic" ? "basic" : "premium");
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
  res.json({
    ok: true,
    server: "DUAL_TIMERS_PREMIUM_BASIC",
    publicBaseUrl: PUBLIC_BASE_URL,
    redirectUri: REDIRECT_URI,
    mpClientId: Boolean(MP_CLIENT_ID),
    mpClientSecret: Boolean(MP_CLIENT_SECRET),
    fallbackToken: Boolean(EVETEC_MP_TOKEN),
    configGlobal,
    devices
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