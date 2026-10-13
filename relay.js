// ---------------------------------------------------------------------------
// Messenger + phone notifications, via your own relay server (nudge-relay.js).
// The web app polls the relay; anything task-like goes into the Signal Feed
// through the same pipeline as Gmail. Pro feature ("integrations").
// ---------------------------------------------------------------------------

let relayBusy = false;
let relayStatus = { ok: null, msg: "Not connected", at: null };

async function relayFetch(path) {
  const r = state.relay;
  const res = await fetch(r.url.replace(/\/+$/, "") + path, { headers: { Authorization: "Bearer " + r.token } });
  if (res.status === 401) throw new Error("The token doesn't match the relay's NUDGE_TOKEN");
  if (!res.ok) throw new Error("Relay answered HTTP " + res.status);
  return res.json();
}

async function pollRelay(manual) {
  if (!hasFeature("integrations")) return;
  const r = state.relay;
  if (!r.enabled || !r.url || !r.token) {
    if (manual) showToast("Turn the relay on and fill in its URL and token first.");
    return;
  }
  if (relayBusy) return;
  relayBusy = true;
  try {
    const q = "/signals?after=" + (r.lastSeq || 0) + (r.epoch ? "&epoch=" + encodeURIComponent(r.epoch) : "");
    const data = await relayFetch(q);
    r.epoch = data.epoch;
    let fresh = 0;
    for (const s of data.signals || []) {
      r.lastSeq = Math.max(r.lastSeq || 0, s.seq);
      if (r.seen.includes(s.id)) continue;
      r.seen.push(s.id);
      if (r.seen.length > 400) r.seen.shift();
      if (s.text && (r.all || looksLikeTask(s.text))) { fresh++; addDetectedSignal({ id: "relay-" + s.id, source: s.source || "Phone", raw: s.text, at: s.at }); }
    }
    relayStatus = { ok: true, msg: fresh ? `Received ${fresh} new task-like message${fresh > 1 ? "s" : ""}` : "Connected, nothing new", at: Date.now() };
    if (manual) showToast(relayStatus.msg + ".");
  } catch (e) {
    relayStatus = { ok: false, msg: e.message || "Couldn't reach the relay", at: Date.now() };
    if (manual) showToast("Relay: " + relayStatus.msg);
  } finally {
    relayBusy = false;
    persistOnly();
    renderPremium();
  }
}

async function testRelay() {
  if (!requireFeature("integrations")) return;
  const r = state.relay;
  if (!r.url || !r.token) { showToast("Fill in the relay URL and token first."); return; }
  try {
    const h = await relayFetch("/health");
    relayStatus = { ok: true, msg: "Connected" + (typeof h.queued === "number" ? ` (${h.queued} waiting)` : "") + ".", at: Date.now() };
  } catch (e) {
    relayStatus = { ok: false, msg: e.message || "Couldn't reach the relay", at: Date.now() };
  }
  showToast(relayStatus.msg);
  renderPremium();
}

function setRelay(field, value) {
  const r = state.relay;
  r[field] = typeof value === "string" ? value.trim() : value;
  if (field === "url" || field === "token") { r.lastSeq = 0; r.epoch = null; }
  persistOnly();
  renderPremium();
  if (field === "enabled" && value) pollRelay(true);
}

function relayPanelHtml() {
  const r = state.relay;
  const color = relayStatus.ok === null ? "var(--text-faint)" : relayStatus.ok ? "var(--success)" : "var(--danger)";
  const onAndroid = typeof devicePlatform === "function" && devicePlatform() === "android";
  return `
    <div class="panel">
      <h2 class="font-display">Phone notifications</h2>
      <p class="panel-sub">The Nudge Android app passes on notifications from every app on this phone (Messenger, WhatsApp, SMS, email…). Nudge picks out the tasks and the time. Easiest: in the Android app tap <strong>Open Nudge and connect</strong>.</p>
      <div class="field"><label>Address</label><input value="${escAttr(r.url)}" placeholder="http://127.0.0.1:8765" onchange="setRelay('url', this.value)" /></div>
      <div class="field"><label>Token (shown in the Android app)</label><input type="password" value="${escAttr(r.token)}" placeholder="Paste the token from the Android app" onchange="setRelay('token', this.value)" /></div>
      <label class="checkbox-row"><input type="checkbox" ${r.enabled ? "checked" : ""} onchange="setRelay('enabled', this.checked)" /> Check for new notifications</label>
      <label class="checkbox-row" style="margin-top:6px;"><input type="checkbox" ${r.all ? "checked" : ""} onchange="setRelay('all', this.checked)" /> Show every message, not only ones that look like tasks</label>
      <div class="panel-actions">
        ${onAndroid ? `<button class="btn-ghost btn-small" onclick="setRelay('url', 'http://127.0.0.1:8765')">Use this phone's Android app</button>` : ""}
        <button class="btn-ghost btn-small" onclick="testRelay()">Check connection</button>
        <span class="panel-note" style="color:${color}">${escapeHtml(relayStatus.msg)}${relayStatus.at ? " · " + new Date(relayStatus.at).toLocaleTimeString() : ""}</span>
      </div>
    </div>`;
}

setInterval(() => pollRelay(false), 15000);
