const http = require("http");
const crypto = require("crypto");

const PORT = process.env.PORT || 8788;
const NUDGE_TOKEN = process.env.NUDGE_TOKEN || "";
const FB_VERIFY_TOKEN = process.env.FB_VERIFY_TOKEN || "";
const FB_APP_SECRET = process.env.FB_APP_SECRET || "";
const ALLOWED_ORIGIN = process.env.ALLOWED_ORIGIN || "http://localhost:8000";
const MAX_QUEUE = 500;
const MAX_BODY = 200 * 1024;

if (NUDGE_TOKEN.length < 16) {
  console.error("Set NUDGE_TOKEN to a random string of at least 16 characters (it protects your messages).");
  process.exit(1);
}

const epoch = Date.now().toString(36); // changes on restart so clients know to start over
let seq = 0;
const queue = [];
const seenIds = new Set();

function safeEqual(a, b) {
  const x = Buffer.from(String(a)), y = Buffer.from(String(b));
  return x.length === y.length && crypto.timingSafeEqual(x, y);
}
function authorized(req) {
  const h = req.headers["authorization"] || "";
  return h.startsWith("Bearer ") && safeEqual(h.slice(7), NUDGE_TOKEN);
}
function push(source, text, id) {
  const clean = String(text || "").trim().slice(0, 1000);
  if (!clean) return false;
  const key = id ? String(id).slice(0, 200) : crypto.createHash("sha1").update(source + clean).digest("hex");
  if (seenIds.has(key)) return false;
  seenIds.add(key);
  queue.push({ seq: ++seq, id: key, source: String(source).slice(0, 40), text: clean, at: Date.now() });
  while (queue.length > MAX_QUEUE) { seenIds.delete(queue.shift().id); }
  return true;
}
function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on("data", (c) => {
      size += c.length;
      if (size > MAX_BODY) { reject(new Error("Body too large")); req.destroy(); return; }
      chunks.push(c);
    });
    req.on("end", () => resolve(Buffer.concat(chunks)));
    req.on("error", reject);
  });
}
function send(res, code, body, type) {
  res.writeHead(code, { "Content-Type": type || "application/json" });
  res.end(typeof body === "string" ? body : JSON.stringify(body));
}

// Meta signs every webhook body: "sha256=" + HMAC-SHA256(app secret, raw body).
function validSignature(raw, header) {
  if (!FB_APP_SECRET || !header || !header.startsWith("sha256=")) return false;
  const expected = crypto.createHmac("sha256", FB_APP_SECRET).update(raw).digest("hex");
  return safeEqual(header.slice(7), expected);
}

const server = http.createServer(async (req, res) => {
  res.setHeader("Access-Control-Allow-Origin", ALLOWED_ORIGIN);
  res.setHeader("Access-Control-Allow-Headers", "Authorization, Content-Type");
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  res.setHeader("Vary", "Origin");
  if (req.method === "OPTIONS") { res.writeHead(204); return res.end(); }

  const url = new URL(req.url, "http://relay.local");
  try {
    // ---- Meta: webhook verification handshake ----
    if (url.pathname === "/webhook" && req.method === "GET") {
      const ok = FB_VERIFY_TOKEN && url.searchParams.get("hub.mode") === "subscribe" &&
        safeEqual(url.searchParams.get("hub.verify_token") || "", FB_VERIFY_TOKEN);
      return ok ? send(res, 200, url.searchParams.get("hub.challenge") || "", "text/plain") : send(res, 403, { error: "Verification failed" });
    }

    // ---- Meta: incoming Page messages ----
    if (url.pathname === "/webhook" && req.method === "POST") {
      const raw = await readBody(req);
      if (!validSignature(raw, req.headers["x-hub-signature-256"])) return send(res, 403, { error: "Bad signature" });
      send(res, 200, "EVENT_RECEIVED", "text/plain"); // answer fast: Meta expects a reply within seconds
      const body = JSON.parse(raw.toString("utf8"));
      if (body.object !== "page") return;
      (body.entry || []).forEach((entry) => (entry.messaging || []).forEach((ev) => {
        const m = ev.message;
        if (!m || m.is_echo || !m.text) return; // skip our own replies, stickers, attachments
        push("Messenger", m.text, m.mid || "fb-" + ev.timestamp + "-" + (ev.sender && ev.sender.id));
      }));
      return;
    }

    // ---- everything below needs the Nudge token ----
    if (!authorized(req)) return send(res, 401, { error: "Unauthorized" });

    if (url.pathname === "/health" && req.method === "GET") {
      return send(res, 200, { ok: true, epoch, facebook: !!(FB_APP_SECRET && FB_VERIFY_TOKEN), queued: queue.length });
    }

    // ---- Android companion (or anything else you own) posts a signal ----
    if (url.pathname === "/signals" && req.method === "POST") {
      const body = JSON.parse((await readBody(req)).toString("utf8"));
      const added = push(body.source || "Phone", body.text, body.id);
      return send(res, 200, { ok: true, added });
    }

    // ---- the web app polls for new signals ----
    if (url.pathname === "/signals" && req.method === "GET") {
      let after = parseInt(url.searchParams.get("after") || "0", 10) || 0;
      const clientEpoch = url.searchParams.get("epoch");
      if (clientEpoch && clientEpoch !== epoch) after = 0; // relay restarted: send what we have
      return send(res, 200, { epoch, next: seq, signals: queue.filter((s) => s.seq > after) });
    }

    send(res, 404, { error: "Not found" });
  } catch (e) {
    console.error(e.message);
    if (!res.headersSent) send(res, 400, { error: "Bad request" });
  }
});

if (require.main === module) {
  server.listen(PORT, () => console.log("Nudge relay on port " + PORT + (FB_APP_SECRET ? " (Facebook webhook enabled)" : " (Facebook webhook disabled: no FB_APP_SECRET)")));
}
module.exports = { server };
