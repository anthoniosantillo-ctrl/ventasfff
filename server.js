// Servidor de pagos PayPal (sin dependencias). Requiere Node 18 o superior.
// Crea la orden en PayPal, confirma el pago y le dice a la página cuánto saldo acreditar.
const http = require("http");
const fs = require("fs");
const path = require("path");

// ---- Configuración (variables de entorno, ver .env.example) ----
const PORT = process.env.PORT || 3000;
const CLIENT_ID = process.env.PAYPAL_CLIENT_ID || "";
const SECRET = process.env.PAYPAL_SECRET || "";
const MODO = (process.env.PAYPAL_ENV || "sandbox").toLowerCase();          // "sandbox" (pruebas) o "live" (real)
const SITIO = (process.env.SITIO_URL || `http://localhost:${PORT}`).replace(/\/+$/, ""); // dirección pública de tu página
const ORIGEN_PERMITIDO = process.env.ORIGEN_PERMITIDO || "";               // solo si la página está en OTRO dominio
const COMISION = Number(process.env.COMISION_RECARGA || 2.25);
const MIN = 5, MAX = 1000;
const API = process.env.PAYPAL_API_URL || (MODO === "live" ? "https://api-m.paypal.com" : "https://api-m.sandbox.paypal.com");

if (typeof fetch !== "function") { console.error("Necesitas Node 18 o superior (tienes " + process.version + ")."); process.exit(1); }
if (!CLIENT_ID || !SECRET) { console.error("Faltan PAYPAL_CLIENT_ID y PAYPAL_SECRET (mira .env.example)."); process.exit(1); }

// ---- Registro de pagos (archivo JSON) ----
const DATA_DIR = path.join(__dirname, "data");
const DB = path.join(DATA_DIR, "pagos.json");
fs.mkdirSync(DATA_DIR, { recursive: true });
let pagos = {};
try { pagos = JSON.parse(fs.readFileSync(DB, "utf8")); } catch (e) {}
const guardar = () => fs.writeFileSync(DB + ".tmp", JSON.stringify(pagos, null, 2)) || fs.renameSync(DB + ".tmp", DB);
const redondear = n => Math.round(n * 100) / 100;

// ---- PayPal ----
let token = null, tokenExp = 0;
async function accessToken() {
  if (token && Date.now() < tokenExp) return token;
  const r = await fetch(API + "/v1/oauth2/token", {
    method: "POST",
    headers: { Authorization: "Basic " + Buffer.from(CLIENT_ID + ":" + SECRET).toString("base64"), "Content-Type": "application/x-www-form-urlencoded" },
    body: "grant_type=client_credentials"
  });
  const j = await r.json();
  if (!r.ok) { const e = new Error("PayPal rechazó las credenciales (" + MODO + "): " + JSON.stringify(j)); e.publico = "PayPal rechazó las credenciales. Revisa PAYPAL_CLIENT_ID, PAYPAL_SECRET y que PAYPAL_ENV (" + MODO + ") coincida con ellas."; throw e; }
  token = j.access_token; tokenExp = Date.now() + (j.expires_in - 60) * 1000;
  return token;
}
async function paypal(metodo, ruta, cuerpo) {
  const r = await fetch(API + ruta, {
    method: metodo,
    headers: { Authorization: "Bearer " + await accessToken(), "Content-Type": "application/json" },
    body: cuerpo === undefined ? undefined : JSON.stringify(cuerpo)
  });
  const j = await r.json().catch(() => ({}));
  return { ok: r.ok, status: r.status, data: j };
}

// ---- Rutas ----
async function crear(body) {
  const correo = String(body.correo || "").trim().toLowerCase();
  const monto = redondear(Number(body.monto));
  if (!/^\S+@\S+\.\S+$/.test(correo)) return [400, { error: "Correo inválido" }];
  if (!(monto >= MIN && monto <= MAX)) return [400, { error: `El monto debe estar entre $${MIN} y $${MAX}` }];
  const r = await paypal("POST", "/v2/checkout/orders", {
    intent: "CAPTURE",
    purchase_units: [{ amount: { currency_code: "USD", value: monto.toFixed(2) }, description: "Recarga de saldo" }],
    application_context: { brand_name: "Mi página", user_action: "PAY_NOW", shipping_preference: "NO_SHIPPING",
      return_url: SITIO + "/?paypal=ok", cancel_url: SITIO + "/?paypal=cancelado" }
  });
  if (!r.ok) { console.error("crear:", JSON.stringify(r.data)); return [502, { error: "PayPal no pudo crear el pago" }]; }
  const url = (r.data.links.find(l => l.rel === "approve") || r.data.links.find(l => l.rel === "payer-action") || {}).href;
  pagos[r.data.id] = { correo, monto, estado: "creada", entregada: false, creada: Date.now() };
  guardar();
  return [200, { id: r.data.id, url }];
}

async function capturar(body) {
  const id = String(body.id || "");
  const p = pagos[id];
  if (!p) return [404, { error: "Pago desconocido" }];
  if (p.estado !== "completada") {
    let r = await paypal("POST", `/v2/checkout/orders/${encodeURIComponent(id)}/capture`, {});
    if (!r.ok && JSON.stringify(r.data).includes("ORDER_ALREADY_CAPTURED")) r = await paypal("GET", `/v2/checkout/orders/${encodeURIComponent(id)}`);
    if (!r.ok) { console.error("capturar:", JSON.stringify(r.data)); return [502, { error: "No se pudo confirmar el pago" }]; }
    const cap = r.data.purchase_units && r.data.purchase_units[0] && r.data.purchase_units[0].payments && r.data.purchase_units[0].payments.captures && r.data.purchase_units[0].payments.captures[0];
    if (r.data.status !== "COMPLETED" || !cap || cap.status !== "COMPLETED") return [402, { error: "El pago aún no está completado", estado: (cap && cap.status) || r.data.status }];
    if (cap.amount.currency_code !== "USD" || redondear(Number(cap.amount.value)) !== p.monto) { p.estado = "monto_distinto"; guardar(); console.error("Monto distinto en", id); return [409, { error: "El monto pagado no coincide" }]; }
    p.estado = "completada"; p.captura = cap.id; p.pagado = Date.now(); guardar();
  }
  // Solo la primera respuesta manda acreditar; si recargan el enlace no se acredita dos veces.
  const acreditar = !p.entregada;
  if (acreditar) { p.entregada = true; guardar(); }
  return [200, { acreditar, correo: p.correo, monto: p.monto, comision: COMISION, neto: redondear(p.monto - COMISION), ref: p.captura }];
}

// ---- Servidor HTTP ----
function leerBody(req) {
  return new Promise((ok, mal) => {
    let t = ""; req.on("data", c => { t += c; if (t.length > 20000) { mal(new Error("grande")); req.destroy(); } });
    req.on("end", () => { try { ok(t ? JSON.parse(t) : {}); } catch (e) { mal(e); } });
  });
}
const PAGINA = path.join(__dirname, "..", "index.html");
http.createServer(async (req, res) => {
  const ruta = req.url.split("?")[0];
  if (ORIGEN_PERMITIDO) {
    res.setHeader("Access-Control-Allow-Origin", ORIGEN_PERMITIDO);
    res.setHeader("Access-Control-Allow-Headers", "Content-Type");
    res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
  }
  if (req.method === "OPTIONS") { res.writeHead(204); return res.end(); }
  const json = (c, o) => { res.writeHead(c, { "Content-Type": "application/json" }); res.end(JSON.stringify(o)); };
  try {
    if (req.method === "POST" && ruta === "/api/paypal/crear") { const [c, o] = await crear(await leerBody(req)); return json(c, o); }
    if (req.method === "POST" && ruta === "/api/paypal/capturar") { const [c, o] = await capturar(await leerBody(req)); return json(c, o); }
    if (req.method === "GET" && ruta === "/" && fs.existsSync(PAGINA)) { res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" }); return res.end(fs.readFileSync(PAGINA)); }
    if (req.method === "GET" && ruta === "/api/salud") { await accessToken(); return json(200, { ok: true, modo: MODO, sitio: SITIO }); }
    json(404, { error: "No encontrado" });
  } catch (e) { console.error(e); json(500, { error: e.publico || "Error del servidor: " + (e.cause && e.cause.code || e.message) }); }
}).listen(PORT, () => console.log(`Servidor listo en ${SITIO} (PayPal ${MODO.toUpperCase()})`));
