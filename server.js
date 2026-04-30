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

let configGlobal = {
  activo: true,
  mensajeGlobalActivo: true,
  mensajeGlobal: "Sistema EVETEC listo para usar",
  moneda: "ARS",

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
    descripcion: "Promo especial EVETEC"
  }
};

function statsIniciales() {
  return {
    totalRecaudado: 0,
    pagosAprobados: 0,
    segundosVendidos: 0,
    tiempoMotor: 0,
    ultimosPagos: []
  };
}

function nuevoDevice() {
  return {
    tipo: "aspiradora",
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
  ASPIRADORA_001: nuevoDevice(),
  ASPIRADORA_002: nuevoDevice()
};

let pagosCreados = {};

function escaparHtml(v) {
  return String(v ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/\"/g, "&quot;");
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

function unirConfig(base, saved) {
  const result = { ...base, ...saved };

  result.planes = Array.isArray(saved.planes)
    ? saved.planes.slice(0, 3)
    : base.planes;

  result.preciosExtra = Array.isArray(saved.preciosExtra)
    ? saved.preciosExtra.slice(0, 3)
    : base.preciosExtra;

  result.promoGlobal = {
    ...base.promoGlobal,
    ...(saved.promoGlobal || {})
  };

  return result;
}

function guardarDatos() {
  try {
    fs.writeFileSync(
      DATA_FILE,
      JSON.stringify(
        {
          devices,
          pagosCreados,
          configGlobal
        },
        null,
        2
      )
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
      configGlobal = unirConfig(configGlobal, data.configGlobal);
    }

    if (data.devices) {
      devices = limpiarDevicesMigrados(data.devices);
    }

    if (data.pagosCreados) {
      pagosCreados = data.pagosCreados;
    }

    if (!devices.ASPIRADORA_001) {
      devices.ASPIRADORA_001 = nuevoDevice();
    }

    console.log("Datos EVETEC Timers cargados");
  } catch (err) {
    console.error("Error cargando datos:", err.message);
  }
}

cargarDatos();

function asegurarDevice(deviceId) {
  const id = String(deviceId || "ASPIRADORA_001").trim().toUpperCase() || "ASPIRADORA_001";

  if (!devices[id]) {
    devices[id] = nuevoDevice();
  }

  const d = devices[id];

  d.tipo = "aspiradora";

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

  if (!d.modoCobro) {
    d.modoCobro = "owner_commission";
  }

  if (!d.stats) {
    d.stats = statsIniciales();
  }

  if (!Array.isArray(d.stats.ultimosPagos)) {
    d.stats.ultimosPagos = [];
  }

  return d;
}

function aplicarDescuento(monto, descuento) {
  return Math.max(1, Math.round(Number(monto) * (1 - Number(descuento) / 100)));
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

function listaPlanesDisponibles() {
  const lista = [...configGlobal.planes];

  if (configGlobal.promoGlobal && configGlobal.promoGlobal.activa) {
    lista.push(configGlobal.promoGlobal);
  }

  return lista;
}
function buscarPlan(body) {
  const tipo = String(body.tipo || body.modo || "normal").toLowerCase();
  const planId = String(body.plan_id || body.id || "").toUpperCase();
  const segundos = Number(body.segundos || 0);

  let origen = "normal";
  let candidatos = listaPlanesDisponibles();

  if (tipo.includes("extra")) {
    origen = "extra";
    candidatos = configGlobal.preciosExtra;
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
  const device_id = String(body.device_id || "ASPIRADORA_001");
  const plan = buscarPlan(body);

  return {
    device_id,
    plan_id: plan.id,
    plan_nombre: plan.nombre,
    origen: plan.origen,
    monto: Number(plan.monto),
    segundos: Number(plan.segundos)
  };
}

// =====================================================
// API ESP32
// =====================================================

app.get("/config/:deviceId", (req, res) => {
  const deviceId = req.params.deviceId;
  const d = asegurarDevice(deviceId);

  d.online = true;
  d.ultimaConexion = new Date().toISOString();

  guardarDatos();

  const operativo = estadoOperativo(deviceId);

  res.json({
    ok: true,
    activo: operativo.ok,
    mensaje: operativo.ok ? configGlobal.mensajeGlobal : operativo.mensaje,

    planes: configGlobal.planes,
    preciosExtra: configGlobal.preciosExtra,
    promoGlobal: configGlobal.promoGlobal.activa ? configGlobal.promoGlobal : null,

    ownerLinked: d.ownerLinked,
    modoCobro: d.modoCobro,
    mantenimiento: d.modoMantenimiento
  });
});

// =====================================================
// 🔥 NUEVO: LOG DE PAGOS DESDE ESP32
// =====================================================

app.post("/device/payment-log", (req, res) => {
  try {
    const { device_id, monto, segundos, fecha } = req.body;

    const d = asegurarDevice(device_id);

    d.stats.totalRecaudado += Number(monto || 0);
    d.stats.pagosAprobados += 1;
    d.stats.segundosVendidos += Number(segundos || 0);
    d.stats.tiempoMotor += Number(segundos || 0);

    d.stats.ultimosPagos.unshift({
      monto,
      segundos,
      fecha: fecha || new Date().toISOString()
    });

    d.stats.ultimosPagos = d.stats.ultimosPagos.slice(0, 20);

    guardarDatos();

    console.log("PAGO LOG:", device_id, monto);

    res.json({ ok: true });

  } catch (err) {
    console.error("Error payment-log:", err);
    res.json({ ok: false });
  }
});

// =====================================================
// MERCADO PAGO - CREAR PAGO
// =====================================================

async function crearPagoMercadoPago(pedido) {
  const d = asegurarDevice(pedido.device_id);
  const operativo = estadoOperativo(pedido.device_id);

  if (!operativo.ok) throw new Error(operativo.mensaje);

  const { token, usandoOwner } = obtenerTokenParaCobrar(pedido.device_id);

  if (!token) throw new Error("Falta token MP");

  const external_reference = `${pedido.device_id}_${Date.now()}`;

  const comision = calcularComision(pedido.device_id, pedido.monto, usandoOwner);

  const body = {
    items: [
      {
        title: `EVETEC ${pedido.device_id}`,
        quantity: 1,
        currency_id: "ARS",
        unit_price: pedido.monto
      }
    ],
    external_reference
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
    console.error(data);
    throw new Error("Error MP");
  }

  const link = data.init_point || data.sandbox_init_point;

  pagosCreados[external_reference] = {
    device_id: pedido.device_id,
    monto: pedido.monto,
    segundos: pedido.segundos,
    estado: "pending"
  };

  guardarDatos();

  return {
    id: external_reference,
    link
  };
}

app.post("/crear-pago", async (req, res) => {
  try {
    const pedido = normalizarPedidoPago(req.body);

    const pago = await crearPagoMercadoPago(pedido);

    const qr = generarQRMatrix(pago.link);

    res.json({
      ok: true,
      payment_id: pago.id,
      link: pago.link,
      qr_size: qr.qr_size,
      qr_matrix: qr.qr_matrix,
      segundos: pedido.segundos
    });

  } catch (err) {
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
      detalle: "sin_token",
      segundos: pagoLocal?.segundos || 0,
      monto: pagoLocal?.monto || 0
    };
  }

  try {
    const url =
      "https://api.mercadopago.com/v1/payments/search" +
      `?external_reference=${encodeURIComponent(id)}` +
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
        detalle,
        payment_id: pago.id,
        segundos: pagoLocal?.segundos || 0,
        monto: pagoLocal?.monto || 0
      };
    }
  } catch (err) {
    console.error("Error consultando pago:", err.message);
  }

  return {
    estado: pagoLocal?.estado || "pending",
    detalle: pagoLocal ? "esperando_pago" : "no_encontrado",
    segundos: pagoLocal?.segundos || 0,
    monto: pagoLocal?.monto || 0
  };
}

app.get("/estado/:paymentId", async (req, res) => {
  try {
    const estado = await buscarEstadoMercadoPago(req.params.paymentId);
    res.json(estado);
  } catch (err) {
    res.json({
      estado: "pending",
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
    const deviceId = req.params.deviceId;
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
  const deviceId = req.query.state;

  if (!code || !deviceId) {
    return res.send("<h2>EVETEC</h2><p>Faltan datos de autorización.</p>");
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
      return res.send(`
        <h2>EVETEC</h2>
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
    res.send(`
      <h2>EVETEC</h2>
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
    <title>EVETEC Timers Admin</title>
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
      .ok{color:#22c55e;font-weight:bold}
      .bad{color:#ef4444;font-weight:bold}
      table{width:100%;border-collapse:collapse}
      td,th{border-bottom:1px solid #1f2937;padding:8px;text-align:left;vertical-align:middle}
      .grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(280px,1fr));gap:14px}
      .money{font-size:22px;color:#22c55e;font-weight:bold}
    </style>
  </head>
  <body>
    <h1>EVETEC PANEL TIMERS / ASPIRADORAS</h1>
    <p class="small">Base pública: ${escaparHtml(PUBLIC_BASE_URL)}</p>
    <p class="small">Redirect OAuth: ${escaparHtml(REDIRECT_URI)}</p>
    <p class="small">
      MP_CLIENT_ID: <b class="${MP_CLIENT_ID ? "ok" : "bad"}">${MP_CLIENT_ID ? "OK" : "FALTA"}</b> |
      MP_CLIENT_SECRET: <b class="${MP_CLIENT_SECRET ? "ok" : "bad"}">${MP_CLIENT_SECRET ? "OK" : "FALTA"}</b> |
      Token EVETEC: <b class="${EVETEC_MP_TOKEN ? "ok" : "bad"}">${EVETEC_MP_TOKEN ? "OK" : "FALTA"}</b>
    </p>
  `;
  html += `
    <div class="box">
      <h2>Recaudación por equipo</h2>
      <table>
        <tr>
          <th>Equipo</th>
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
    const ultimo = stats.ultimosPagos && stats.ultimosPagos.length
      ? stats.ultimosPagos[0]
      : null;

    html += `
      <tr>
        <td><b>${escaparHtml(id)}</b></td>
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
          <input name="mensajeGlobal" value="${escaparHtml(configGlobal.mensajeGlobal)}" size="45"><br>
          <button class="save" type="submit">Guardar estado general</button>
        </form>
      </div>

      <div class="box">
        <h2>Descuentos rápidos</h2>
        <form method="POST" action="/admin/discount">
          <button class="promo" name="descuento" value="50">50% OFF</button>
          <button class="promo" name="descuento" value="40">40% OFF</button>
          <button class="promo" name="descuento" value="30">30% OFF</button>
          <button class="promo" name="descuento" value="20">20% OFF</button>
          <button class="promo" name="descuento" value="10">10% OFF</button>
          <button class="promo" name="descuento" value="5">5% OFF</button>
        </form>

        <form method="POST" action="/admin/reset-prices">
          <button class="danger" type="submit">Restaurar precios base</button>
        </form>
      </div>
    </div>

    <div class="box">
      <h2>3 precios principales</h2>
      <form method="POST" action="/admin/prices/update">
  `;

  configGlobal.planes.forEach((p, i) => {
    html += `
      <div>
        <b>Plan ${i + 1}</b>
        ID:<input name="id${i}" value="${escaparHtml(p.id || "P" + (i + 1))}" size="5">
        Nombre:<input name="nombre${i}" value="${escaparHtml(p.nombre)}" size="12">
        Seg:<input name="segundos${i}" value="${p.segundos}" size="6">
        Precio:<input name="monto${i}" value="${p.monto}" size="7">
        Desc:<input name="descripcion${i}" value="${escaparHtml(p.descripcion)}" size="28">
      </div>
    `;
  });

  html += `
        <button class="save" type="submit">Guardar precios principales</button>
      </form>
    </div>

    <div class="box">
      <h2>3 precios extra post-tiempo</h2>
      <form method="POST" action="/admin/extra-prices/update">
  `;

  configGlobal.preciosExtra.forEach((p, i) => {
    html += `
      <div>
        <b>Extra ${i + 1}</b>
        ID:<input name="id${i}" value="${escaparHtml(p.id || "E" + (i + 1))}" size="5">
        Nombre:<input name="nombre${i}" value="${escaparHtml(p.nombre)}" size="12">
        Seg:<input name="segundos${i}" value="${p.segundos}" size="6">
        Precio:<input name="monto${i}" value="${p.monto}" size="7">
        Desc:<input name="descripcion${i}" value="${escaparHtml(p.descripcion)}" size="28">
      </div>
    `;
  });

  html += `
        <button class="save" type="submit">Guardar precios extra</button>
      </form>
    </div>

    <div class="box">
      <h2>4° precio / promo opcional</h2>
      <form method="POST" action="/admin/promo/update">
        Activa:<input type="checkbox" name="activa" ${configGlobal.promoGlobal.activa ? "checked" : ""}><br>
        ID:<input name="id" value="${escaparHtml(configGlobal.promoGlobal.id || "PROMO")}" size="8">
        Nombre:<input name="nombre" value="${escaparHtml(configGlobal.promoGlobal.nombre)}" size="20"><br>
        Duración:<input name="segundos" value="${configGlobal.promoGlobal.segundos}" size="8"> segundos
        Precio:<input name="monto" value="${configGlobal.promoGlobal.monto}" size="8"><br>
        Descripción:<input name="descripcion" value="${escaparHtml(configGlobal.promoGlobal.descripcion)}" size="50"><br>
        <button class="save" type="submit">Guardar promo</button>
      </form>
    </div>

    <div class="box">
      <h2>Máquinas / mantenimiento / cobro</h2>
      <table>
        <tr>
          <th>Equipo</th>
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
    const last = d.ultimaConexion
      ? new Date(d.ultimaConexion).toLocaleString("es-AR")
      : "Nunca";

    html += `
      <tr>
        <td><b>${escaparHtml(id)}</b><br><span class="tag">aspiradora</span></td>
        <td class="${d.online ? "online" : "offline"}">${d.online ? "ONLINE" : "OFFLINE"}</td>
        <td>${d.activo ? "SI" : "NO"}</td>
        <td>${d.modoMantenimiento ? "SI" : "NO"}</td>
        <td class="${d.ownerLinked ? "ok" : "bad"}">${d.ownerLinked ? "VINCULADA" : "NO VINCULADA"}</td>

        <td>
          <form method="POST" action="/admin/device/${encodeURIComponent(id)}/billing">
            <select name="modoCobro">
              <option value="owner_commission" ${d.modoCobro === "owner_commission" ? "selected" : ""}>Dueño + comisión</option>
              <option value="owner_direct" ${d.modoCobro === "owner_direct" ? "selected" : ""}>Dueño directo</option>
              <option value="evetec" ${d.modoCobro === "evetec" ? "selected" : ""}>Cuenta EVETEC</option>
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
        <input name="deviceId" value="ASPIRADORA_003" size="24">
        <button class="save" type="submit">Agregar</button>
      </form>
    </div>

    <div class="box">
      <h2>Últimos pagos globales</h2>
      <table>
        <tr>
          <th>Referencia</th>
          <th>Equipo</th>
          <th>Monto</th>
          <th>Segundos</th>
          <th>Estado</th>
        </tr>
  `;

  const pagos = Object.entries(pagosCreados)
    .map(([ref, p]) => ({ ref, ...p }))
    .filter((p, index, arr) => arr.findIndex(x => x.ref === p.ref) === index)
    .slice(-30)
    .reverse();

  for (const p of pagos) {
    html += `
      <tr>
        <td>${escaparHtml(p.ref)}</td>
        <td>${escaparHtml(p.device_id)}</td>
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

app.post("/admin/prices/update", (req, res) => {
  actualizarArrayPlanes(configGlobal.planes, req.body, "P");
  guardarDatos();
  res.redirect("/admin");
});

app.post("/admin/extra-prices/update", (req, res) => {
  actualizarArrayPlanes(configGlobal.preciosExtra, req.body, "E");
  guardarDatos();
  res.redirect("/admin");
});

app.post("/admin/discount", (req, res) => {
  const descuento = Number(req.body.descuento) || 0;

  configGlobal.planes = configGlobal.planes.map(p => ({
    ...p,
    montoBase: p.montoBase || p.monto,
    monto: aplicarDescuento(p.montoBase || p.monto, descuento)
  }));

  configGlobal.preciosExtra = configGlobal.preciosExtra.map(p => ({
    ...p,
    montoBase: p.montoBase || p.monto,
    monto: aplicarDescuento(p.montoBase || p.monto, descuento)
  }));

  configGlobal.mensajeGlobalActivo = true;
  configGlobal.mensajeGlobal = `Promoción global aplicada: ${descuento}% OFF`;

  guardarDatos();
  res.redirect("/admin");
});

app.post("/admin/reset-prices", (req, res) => {
  configGlobal.planes = configGlobal.planes.map(p => ({
    ...p,
    monto: p.montoBase || p.monto
  }));

  configGlobal.preciosExtra = configGlobal.preciosExtra.map(p => ({
    ...p,
    monto: p.montoBase || p.monto
  }));

  configGlobal.promoGlobal.monto =
    configGlobal.promoGlobal.montoBase || configGlobal.promoGlobal.monto;

  configGlobal.mensajeGlobalActivo = true;
  configGlobal.mensajeGlobal = "Precios normales restaurados";

  guardarDatos();
  res.redirect("/admin");
});

app.post("/admin/promo/update", (req, res) => {
  configGlobal.promoGlobal.activa = req.body.activa === "on";
  configGlobal.promoGlobal.id = String(req.body.id || "PROMO").toUpperCase();
  configGlobal.promoGlobal.nombre = req.body.nombre || configGlobal.promoGlobal.nombre;
  configGlobal.promoGlobal.segundos = Number(req.body.segundos) || configGlobal.promoGlobal.segundos;
  configGlobal.promoGlobal.monto = Number(req.body.monto) || configGlobal.promoGlobal.monto;
  configGlobal.promoGlobal.montoBase =
    configGlobal.promoGlobal.montoBase || configGlobal.promoGlobal.monto;
  configGlobal.promoGlobal.descripcion =
    req.body.descripcion || configGlobal.promoGlobal.descripcion;

  guardarDatos();
  res.redirect("/admin");
});

app.post("/admin/device/add", (req, res) => {
  const id = String(req.body.deviceId || "").trim().toUpperCase();

  if (id) {
    asegurarDevice(id);
  }

  guardarDatos();
  res.redirect("/admin");
});

app.post("/admin/device/:deviceId/status", (req, res) => {
  const d = asegurarDevice(req.params.deviceId);

  d.activo = req.body.activo === "1";

  if (d.activo) {
    d.modoMantenimiento = false;
  }

  guardarDatos();
  res.redirect("/admin");
});

app.post("/admin/device/:deviceId/maintenance", (req, res) => {
  const d = asegurarDevice(req.params.deviceId);

  d.modoMantenimiento = req.body.mantenimiento === "1";

  if (d.modoMantenimiento) {
    d.activo = false;
  }

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
    server: "EVETEC_TIMERS_FINAL_STATS",
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
  console.log(" EVETEC SERVER FINAL - TIMERS + STATS");
  console.log("=======================================");
  console.log(`Servidor local: http://localhost:${PORT}`);
  console.log(`URL pública: ${PUBLIC_BASE_URL}`);
  console.log(`Redirect URI: ${REDIRECT_URI}`);
  console.log(`Admin: ${PUBLIC_BASE_URL}/admin`);
  console.log("=======================================");
});