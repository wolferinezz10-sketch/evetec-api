const express = require("express");
const cors = require("cors");
const QRCode = require("qrcode");

const app = express();

app.use(cors());
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

const PORT = Number(process.env.PORT || 3000);

const PUBLIC_BASE_URL =
  process.env.PUBLIC_BASE_URL || "https://juiciness-felt-tip-backward.ngrok-free.dev";

const MP_CLIENT_ID = process.env.MP_CLIENT_ID;
const MP_CLIENT_SECRET = process.env.MP_CLIENT_SECRET;
const EVETEC_MP_TOKEN = process.env.MERCADO_PAGO_ACCESS_TOKEN;

const COMISION_EVETEC_PORCENTAJE = Number(process.env.COMISION_EVETEC || 15);

const REDIRECT_URI = `${PUBLIC_BASE_URL}/oauth/callback`;

// =====================================================
// CONFIG GLOBAL PARA TODAS LAS ASPIRADORAS
// =====================================================

let configGlobal = {
  activo: true,

  mensajeGlobalActivo: true,
  mensajeGlobal: "Sistema EVETEC listo para usar",

  planes: [
    {
      nombre: "1m 30s",
      segundos: 90,
      monto: 100,
      montoBase: 100,
      descripcion: "Limpieza rápida"
    },
    {
      nombre: "3m",
      segundos: 180,
      monto: 250,
      montoBase: 250,
      descripcion: "Auto chico / retoque"
    },
    {
      nombre: "5m",
      segundos: 300,
      monto: 400,
      montoBase: 400,
      descripcion: "Limpieza completa"
    }
  ],

  promoGlobal: {
    activa: false,
    nombre: "PROMO GLOBAL",
    segundos: 240,
    monto: 300,
    descripcion: "Promo especial EVETEC"
  }
};

// =====================================================
// MÁQUINAS
// =====================================================

let devices = {
  ASPIRADORA_001: {
    tipo: "aspiradora",
    activo: true,
    online: false,
    ultimaConexion: null,

    ownerLinked: false,
    ownerAccessToken: null,
    ownerRefreshToken: null,
    ownerUserId: null,
    ownerEmail: "",

    comisionEvetecPorcentaje: COMISION_EVETEC_PORCENTAJE
  },

  ASPIRADORA_002: {
    tipo: "aspiradora",
    activo: true,
    online: false,
    ultimaConexion: null,

    ownerLinked: false,
    ownerAccessToken: null,
    ownerRefreshToken: null,
    ownerUserId: null,
    ownerEmail: "",

    comisionEvetecPorcentaje: COMISION_EVETEC_PORCENTAJE
  }
};

let pagosCreados = {};

// =====================================================
// UTILIDADES
// =====================================================

function asegurarDevice(deviceId) {
  if (!devices[deviceId]) {
    devices[deviceId] = {
      tipo: "aspiradora",
      activo: true,
      online: false,
      ultimaConexion: null,

      ownerLinked: false,
      ownerAccessToken: null,
      ownerRefreshToken: null,
      ownerUserId: null,
      ownerEmail: "",

      comisionEvetecPorcentaje: COMISION_EVETEC_PORCENTAJE
    };
  }

  return devices[deviceId];
}

function escaparHtml(v) {
  return String(v ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function aplicarDescuento(monto, descuento) {
  return Math.max(1, Math.round(Number(monto) * (1 - Number(descuento) / 100)));
}

function calcularComision(deviceId, monto) {
  const d = asegurarDevice(deviceId);
  const porcentaje = Number(d.comisionEvetecPorcentaje || COMISION_EVETEC_PORCENTAJE);
  return Math.max(0, Math.round(Number(monto) * porcentaje / 100));
}

function normalizarPedidoPago(body) {
  const device_id = String(body.device_id || body.deviceId || "ASPIRADORA_001");
  const monto = Number(body.monto || body.amount || body.precio);
  const segundos = Number(body.segundos || body.seconds || body.creditos || 0);

  return { device_id, monto, segundos };
}

async function generarQRMatrix(texto) {
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

function obtenerTokenParaCobrar(deviceId) {
  const d = asegurarDevice(deviceId);

  if (d.ownerLinked && d.ownerAccessToken) {
    return d.ownerAccessToken;
  }

  return EVETEC_MP_TOKEN;
}

// =====================================================
// CONFIG PARA ESP32
// =====================================================

app.get("/config/:deviceId", (req, res) => {
  const deviceId = req.params.deviceId;
  const d = asegurarDevice(deviceId);

  d.online = true;
  d.ultimaConexion = new Date().toISOString();

  res.json({
    activo: Boolean(configGlobal.activo && d.activo),
    tipo: "aspiradora",

    mensaje: configGlobal.mensajeGlobalActivo ? configGlobal.mensajeGlobal : "",

    mensajeGlobal: {
      activo: configGlobal.mensajeGlobalActivo,
      texto: configGlobal.mensajeGlobal
    },

    planes: configGlobal.planes,

    promoGlobal: configGlobal.promoGlobal.activa ? configGlobal.promoGlobal : null,
    promoGlobalEspecial: configGlobal.promoGlobal.activa ? configGlobal.promoGlobal : null,

    ownerLinked: Boolean(d.ownerLinked && d.ownerAccessToken),
    comisionEvetecPorcentaje: d.comisionEvetecPorcentaje
  });
});

// =====================================================
// OAUTH MERCADO PAGO
// =====================================================

app.get("/oauth/link/:deviceId", async (req, res) => {
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

    const qr = await generarQRMatrix(url);

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
    return res.send(`
      <h2>EVETEC</h2>
      <p>Faltan datos de autorización.</p>
    `);
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
        <h2>EVETEC</h2>
        <p>Error vinculando cuenta Mercado Pago.</p>
        <pre>${escaparHtml(JSON.stringify(data, null, 2))}</pre>
      `);
    }

    d.ownerAccessToken = data.access_token;
    d.ownerRefreshToken = data.refresh_token || null;
    d.ownerUserId = data.user_id || null;
    d.ownerLinked = true;

    console.log("Cuenta MP vinculada:", deviceId, "user:", data.user_id);

    res.send(`
      <html>
      <head>
        <meta name="viewport" content="width=device-width, initial-scale=1">
        <style>
          body { font-family: Arial; background:#050816; color:white; padding:30px; }
          .box { max-width:520px; margin:auto; background:#111827; border:1px solid #22d3ee; border-radius:16px; padding:22px; }
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
      <h2>EVETEC</h2>
      <p>Error interno vinculando cuenta.</p>
      <pre>${escaparHtml(err.message)}</pre>
    `);
  }
});

app.get("/owner-status/:deviceId", (req, res) => {
  const d = asegurarDevice(req.params.deviceId);

  res.json({
    ok: true,
    linked: Boolean(d.ownerLinked && d.ownerAccessToken),
    ownerUserId: d.ownerUserId || null,
    comisionEvetecPorcentaje: d.comisionEvetecPorcentaje
  });
});

app.post("/unlink-owner/:deviceId", (req, res) => {
  const d = asegurarDevice(req.params.deviceId);

  d.ownerLinked = false;
  d.ownerAccessToken = null;
  d.ownerRefreshToken = null;
  d.ownerUserId = null;
  d.ownerEmail = "";

  res.redirect("/admin");
});

// =====================================================
// MERCADO PAGO - CREAR PAGO
// =====================================================

async function crearPagoMercadoPago({ device_id, monto, segundos }) {
  const d = asegurarDevice(device_id);
  const token = obtenerTokenParaCobrar(device_id);

  if (!token) {
    throw new Error("Falta token Mercado Pago. Vincule una cuenta o configure token EVETEC.");
  }

  if (!monto || monto <= 0) {
    throw new Error("Monto inválido");
  }

  if (!segundos || segundos <= 0) {
    throw new Error("Tiempo inválido");
  }

  if (!configGlobal.activo || !d.activo) {
    throw new Error("Equipo desactivado");
  }

  const external_reference = `${device_id}_${Date.now()}`;
  const comisionEvetec = calcularComision(device_id, monto);
  const netoDuenioEstimado = Math.max(0, Number(monto) - comisionEvetec);

  const body = {
    items: [
      {
        title: `EVETEC ${device_id} - ${segundos} segundos`,
        quantity: 1,
        currency_id: "ARS",
        unit_price: Number(monto)
      }
    ],

    marketplace_fee: comisionEvetec,

    external_reference,

    metadata: {
      device_id,
      tipo: "aspiradora",
      segundos,
      monto_total: Number(monto),
      comision_evetec: comisionEvetec,
      neto_duenio_estimado: netoDuenioEstimado,
      owner_linked: Boolean(d.ownerLinked)
    }
  };

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
    device_id,
    monto,
    segundos,
    comisionEvetec,
    netoDuenioEstimado,
    estado: "pending",
    link,
    creado: new Date().toISOString()
  };

  if (data.id) {
    pagosCreados[data.id] = pagosCreados[external_reference];
  }

  return {
    id: external_reference,
    preference_id: data.id,
    external_reference,
    link
  };
}

app.post("/crear-pago", async (req, res) => {
  try {
    const pedido = normalizarPedidoPago(req.body);

    if (!pedido.monto || !pedido.segundos) {
      return res.json({
        ok: false,
        error: "Faltan monto o segundos",
        qr_size: 0,
        qr_matrix: ""
      });
    }

    const pago = await crearPagoMercadoPago(pedido);
    const qr = await generarQRMatrix(pago.link);

    console.log("Pago creado:", pedido.device_id, "$" + pedido.monto, pedido.segundos + "s");

    res.json({
      ok: true,
      id: pago.id,
      payment_id: pago.id,
      preference_id: pago.preference_id,
      external_reference: pago.external_reference,
      link: pago.link,
      qr_size: qr.qr_size,
      qr_matrix: qr.qr_matrix
    });
  } catch (err) {
    console.error("Error /crear-pago:", err.message);

    res.json({
      ok: false,
      error: err.message,
      qr_size: 0,
      qr_matrix: ""
    });
  }
});

// =====================================================
// MERCADO PAGO - ESTADO DEL PAGO
// =====================================================

async function buscarEstadoMercadoPago(id) {
  const pagoLocal = pagosCreados[id];
  const deviceId = pagoLocal?.device_id;
  const token = deviceId ? obtenerTokenParaCobrar(deviceId) : EVETEC_MP_TOKEN;

  if (!token) {
    return {
      estado: "pending",
      detalle: "sin_token"
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
      }

      return {
        estado,
        detalle,
        payment_id: pago.id,
        segundos: pagoLocal?.segundos || pago.metadata?.segundos || 0
      };
    }
  } catch (err) {
    console.error("Error consultando pago:", err.message);
  }

  return {
    estado: pagoLocal?.estado || "pending",
    detalle: pagoLocal ? "esperando_pago" : "no_encontrado",
    segundos: pagoLocal?.segundos || 0
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
      detalle: "error_server"
    });
  }
});

// =====================================================
// PANEL ADMIN
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
    <title>EVETEC Admin</title>
    <style>
      body { font-family: Arial; background:#050816; color:white; padding:20px; }
      h1 { color:#22d3ee; margin-bottom:4px; }
      h2 { color:#facc15; }
      .box { background:#111827; border:1px solid #22d3ee; border-radius:14px; padding:16px; margin-bottom:20px; }
      input, select { padding:8px; margin:4px; border-radius:8px; border:0; }
      button { padding:10px 14px; border:0; border-radius:10px; font-weight:bold; cursor:pointer; margin:4px; }
      .save { background:#22c55e; color:#001b08; }
      .danger { background:#ef4444; color:white; }
      .promo { background:#facc15; color:#111; }
      .online { color:#22c55e; }
      .offline { color:#ef4444; }
      .small { color:#94a3b8; font-size:13px; }
      .tag { display:inline-block; background:#0f172a; color:#67e8f9; border:1px solid #155e75; border-radius:999px; padding:4px 10px; font-size:12px; }
      .ok { color:#22c55e; }
      .bad { color:#ef4444; }
      table { width:100%; border-collapse: collapse; }
      td, th { border-bottom:1px solid #1f2937; padding:8px; text-align:left; vertical-align:middle; }
    </style>
  </head>
  <body>
    <h1>EVETEC PANEL MAESTRO</h1>
    <p class="small">Base pública: ${escaparHtml(PUBLIC_BASE_URL)}</p>
    <p class="small">Redirect OAuth: ${escaparHtml(REDIRECT_URI)}</p>
    <p class="small">
      MP_CLIENT_ID: <b class="${MP_CLIENT_ID ? "ok" : "bad"}">${MP_CLIENT_ID ? "OK" : "FALTA"}</b> |
      MP_CLIENT_SECRET: <b class="${MP_CLIENT_SECRET ? "ok" : "bad"}">${MP_CLIENT_SECRET ? "OK" : "FALTA"}</b> |
      Token fallback EVETEC: <b class="${EVETEC_MP_TOKEN ? "ok" : "bad"}">${EVETEC_MP_TOKEN ? "OK" : "FALTA"}</b>
    </p>

    <div class="box">
      <h2>Estado general</h2>
      <form method="POST" action="/admin/global/update">
        Sistema activo:
        <input type="checkbox" name="activo" ${configGlobal.activo ? "checked" : ""}><br>

        Mensaje global activo:
        <input type="checkbox" name="mensajeGlobalActivo" ${configGlobal.mensajeGlobalActivo ? "checked" : ""}><br>

        Mensaje global:
        <input name="mensajeGlobal" value="${escaparHtml(configGlobal.mensajeGlobal)}" size="50"><br>

        <button class="save" type="submit">Guardar estado general</button>
      </form>
    </div>

    <div class="box">
      <h2>Precios globales para todas las aspiradoras</h2>
      <form method="POST" action="/admin/prices/update">
  `;

  configGlobal.planes.forEach((p, i) => {
    html += `
      <div>
        Nombre:
        <input name="nombre${i}" value="${escaparHtml(p.nombre)}" size="10">
        Seg:
        <input name="segundos${i}" value="${p.segundos}" size="6">
        Precio:
        <input name="monto${i}" value="${p.monto}" size="6">
        Desc:
        <input name="descripcion${i}" value="${escaparHtml(p.descripcion)}" size="24">
      </div>
    `;
  });

  html += `
        <button class="save" type="submit">Guardar precios globales</button>
      </form>

      <h3>Aplicar descuento global</h3>
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

    <div class="box">
      <h2>Promo global opcional</h2>
      <form method="POST" action="/admin/promo/update">
        Activa:
        <input type="checkbox" name="activa" ${configGlobal.promoGlobal.activa ? "checked" : ""}><br>
        Nombre:
        <input name="nombre" value="${escaparHtml(configGlobal.promoGlobal.nombre)}" size="20"><br>
        Duración:
        <input name="segundos" value="${configGlobal.promoGlobal.segundos}" size="8"> segundos<br>
        Precio:
        <input name="monto" value="${configGlobal.promoGlobal.monto}" size="8"><br>
        Descripción:
        <input name="descripcion" value="${escaparHtml(configGlobal.promoGlobal.descripcion)}" size="50"><br>

        <button class="save" type="submit">Guardar promo global</button>
      </form>
    </div>

    <div class="box">
      <h2>Máquinas vinculadas</h2>
      <table>
        <tr>
          <th>Equipo</th>
          <th>Online</th>
          <th>Cuenta MP</th>
          <th>Comisión</th>
          <th>Última conexión</th>
          <th>Acciones</th>
        </tr>
  `;

  for (const id of Object.keys(devices)) {
    const d = devices[id];
    const last = d.ultimaConexion ? new Date(d.ultimaConexion).toLocaleString("es-AR") : "Nunca";

    html += `
      <tr>
        <td>${escaparHtml(id)}</td>
        <td class="${d.online ? "online" : "offline"}">${d.online ? "ONLINE" : "OFFLINE"}</td>
        <td class="${d.ownerLinked ? "ok" : "bad"}">${d.ownerLinked ? "VINCULADA" : "NO VINCULADA"}</td>
        <td>
          <form method="POST" action="/admin/device/${encodeURIComponent(id)}/commission">
            <input name="comision" value="${d.comisionEvetecPorcentaje}" size="4"> %
            <button class="save" type="submit">OK</button>
          </form>
        </td>
        <td>${escaparHtml(last)}</td>
        <td>
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
      <h2>Últimos pagos</h2>
      <table>
        <tr>
          <th>Referencia</th>
          <th>Equipo</th>
          <th>Monto</th>
          <th>Comisión EVETEC</th>
          <th>Estado</th>
          <th>Fecha</th>
        </tr>
  `;

  const pagos = Object.values(pagosCreados)
    .filter((p, index, arr) => arr.findIndex(x => x.external_reference === p.external_reference) === index)
    .slice(-20)
    .reverse();

  for (const p of pagos) {
    html += `
      <tr>
        <td>${escaparHtml(p.external_reference)}</td>
        <td>${escaparHtml(p.device_id)}</td>
        <td>$${p.monto}</td>
        <td>$${p.comisionEvetec}</td>
        <td>${escaparHtml(p.estado)}</td>
        <td>${escaparHtml(new Date(p.creado).toLocaleString("es-AR"))}</td>
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
  res.redirect("/admin");
});

app.post("/admin/prices/update", (req, res) => {
  configGlobal.planes.forEach((p, i) => {
    p.nombre = req.body[`nombre${i}`] || p.nombre;
    p.segundos = Number(req.body[`segundos${i}`]) || p.segundos;
    p.monto = Number(req.body[`monto${i}`]) || p.monto;
    p.montoBase = p.monto;
    p.descripcion = req.body[`descripcion${i}`] || p.descripcion;
  });

  res.redirect("/admin");
});

app.post("/admin/discount", (req, res) => {
  const descuento = Number(req.body.descuento) || 0;

  configGlobal.planes = configGlobal.planes.map(p => ({
    ...p,
    montoBase: p.montoBase || p.monto,
    monto: aplicarDescuento(p.montoBase || p.monto, descuento)
  }));

  configGlobal.mensajeGlobalActivo = true;
  configGlobal.mensajeGlobal = `Promoción global aplicada: ${descuento}% OFF`;

  res.redirect("/admin");
});

app.post("/admin/reset-prices", (req, res) => {
  configGlobal.planes = configGlobal.planes.map(p => ({
    ...p,
    monto: p.montoBase || p.monto
  }));

  configGlobal.mensajeGlobalActivo = true;
  configGlobal.mensajeGlobal = "Precios normales restaurados";

  res.redirect("/admin");
});

app.post("/admin/promo/update", (req, res) => {
  configGlobal.promoGlobal.activa = req.body.activa === "on";
  configGlobal.promoGlobal.nombre = req.body.nombre || configGlobal.promoGlobal.nombre;
  configGlobal.promoGlobal.segundos = Number(req.body.segundos) || configGlobal.promoGlobal.segundos;
  configGlobal.promoGlobal.monto = Number(req.body.monto) || configGlobal.promoGlobal.monto;
  configGlobal.promoGlobal.descripcion = req.body.descripcion || configGlobal.promoGlobal.descripcion;

  res.redirect("/admin");
});

app.post("/admin/device/:deviceId/commission", (req, res) => {
  const d = asegurarDevice(req.params.deviceId);
  d.comisionEvetecPorcentaje = Number(req.body.comision) || d.comisionEvetecPorcentaje;
  res.redirect("/admin");
});

// =====================================================
// STATUS / HEALTH
// =====================================================

app.get("/health", (req, res) => {
  res.json({
    ok: true,
    server: "EVETEC_GLOBAL_OAUTH",
    publicBaseUrl: PUBLIC_BASE_URL,
    redirectUri: REDIRECT_URI,
    mpClientId: Boolean(MP_CLIENT_ID),
    mpClientSecret: Boolean(MP_CLIENT_SECRET),
    fallbackToken: Boolean(EVETEC_MP_TOKEN),
    devices
  });
});

setInterval(() => {
  const ahora = Date.now();

  for (const id of Object.keys(devices)) {
    const d = devices[id];

    if (!d.ultimaConexion) {
      d.online = false;
      continue;
    }

    const diff = ahora - new Date(d.ultimaConexion).getTime();
    d.online = diff < 15000;
  }
}, 5000);

// =====================================================
// START
// =====================================================

app.listen(PORT, "0.0.0.0", () => {
  console.log("=======================================");
  console.log(" EVETEC SERVER GLOBAL + OAUTH");
  console.log("=======================================");
  console.log(`Servidor local: http://localhost:${PORT}`);
  console.log(`URL pública: ${PUBLIC_BASE_URL}`);
  console.log(`Redirect URI: ${REDIRECT_URI}`);
  console.log(`Admin: ${PUBLIC_BASE_URL}/admin`);
  console.log("=======================================");
});