// ---------------------------------------------------------------------------
// Gmail connection. Uses Google's real sign-in (Google Identity Services) and the
// Gmail API. You create your own Google "Client ID" once (the Gmail card in the
// Signal Feed walks you through it) and paste it in the app.
//
// Only mail that arrives AFTER you connect is scanned, so you don't get a flood
// of old emails. Checks run every 30 seconds while Nudge is open.
// ---------------------------------------------------------------------------

const GMAIL_SCOPE = "https://www.googleapis.com/auth/gmail.readonly";
const GMAIL_POLL_INTERVAL_MS = 30000;
const GMAIL_QUERY_FILTER = "in:inbox -category:promotions -category:social -category:forums";

let gmailTokenClient = null;
let gmailAccessToken = null;
let gmailTokenExpiresAt = 0;
let gmailPollTimer = null;
let gmailPolling = false;
let gmailInitTries = 0;
let gmailNote = ""; // short status message shown under "Gmail"
let gmailLastCheckAt = 0;

function gmailClientId() {
  const id = String((state && state.gmailClientId) || (typeof NUDGE_CONFIG !== "undefined" && NUDGE_CONFIG.googleClientId) || "").trim();
  return id && !id.startsWith("YOUR_CLIENT_ID") ? id : "";
}
function gmailConfigured() { return !!gmailClientId(); }

function initGmail() {
  if (!gmailConfigured()) { renderGmailCard(); return; }
  if (!window.google || !google.accounts || !google.accounts.oauth2) {
    if (++gmailInitTries < 40) setTimeout(initGmail, 300);
    else { gmailNote = "Couldn't load Google sign-in. Check your internet connection and reload."; renderGmailCard(); }
    return;
  }
  gmailTokenClient = google.accounts.oauth2.initTokenClient({
    client_id: gmailClientId(),
    scope: GMAIL_SCOPE,
    callback: onGmailToken,
    error_callback: (err) => {
      gmailNote = err && err.type === "popup_closed" ? "" : "Sign-in was blocked or cancelled. Allow pop-ups for this site and try again.";
      renderGmailCard();
    },
  });
  renderGmailCard();
}

function onGmailToken(response) {
  if (response.error) {
    gmailNote = "Google said: " + (response.error_description || response.error);
    renderGmailCard();
    return;
  }
  gmailAccessToken = response.access_token;
  gmailTokenExpiresAt = Date.now() + (Number(response.expires_in) || 3600) * 1000 - 60000;
  gmailNote = "";
  if (!state.gmailLastPoll) state.gmailLastPoll = Date.now(); // first connect: only look at mail from now on
  state.gmailWasConnected = true;
  persistOnly();
  renderGmailCard();
  startGmailPolling();
  fetchGmailProfile();
}

async function fetchGmailProfile() {
  try {
    const res = await fetch("https://www.googleapis.com/gmail/v1/users/me/profile", { headers: { Authorization: "Bearer " + gmailAccessToken } });
    if (!res.ok) return;
    state.gmailEmail = (await res.json()).emailAddress || "";
    persistOnly();
    renderGmailCard();
  } catch (e) { /* the email is only for display */ }
}

function connectGmail() {
  if (!gmailConfigured()) { openGmailSetup(); return; }
  if (!gmailTokenClient) initGmail();
  if (!gmailTokenClient) { showToast("Google sign-in is still loading. Try again in a moment."); return; }
  gmailTokenClient.requestAccessToken({ prompt: state.gmailWasConnected ? "" : "select_account" });
}

function disconnectGmail() {
  if (gmailAccessToken && window.google && google.accounts && google.accounts.oauth2) google.accounts.oauth2.revoke(gmailAccessToken, () => {});
  gmailAccessToken = null;
  clearInterval(gmailPollTimer);
  state.gmailWasConnected = false;
  gmailNote = "";
  persistOnly();
  renderGmailCard();
}

// Google tokens last about an hour. When one runs out, ask for a new one (may need a tap).
function expireGmail() {
  gmailAccessToken = null;
  clearInterval(gmailPollTimer);
  gmailNote = "Session expired. Tap Reconnect to keep getting Gmail alerts.";
  renderGmailCard();
  if (gmailTokenClient) { try { gmailTokenClient.requestAccessToken({ prompt: "" }); } catch (e) { /* needs a tap */ } }
}

function gmailButtonAction() {
  if (gmailAccessToken) disconnectGmail(); else connectGmail();
}

function renderGmailCard() {
  const statusEl = document.getElementById("gmail-status");
  const btn = document.getElementById("gmail-connect-btn");
  if (!statusEl || !btn) return;
  const connected = !!gmailAccessToken;
  if (!gmailConfigured()) {
    statusEl.textContent = "Not set up yet";
    btn.textContent = "Set up Gmail";
  } else if (connected) {
    statusEl.textContent = "Connected" + (state.gmailEmail ? " as " + state.gmailEmail : "") + (gmailLastCheckAt ? " · last checked " + new Date(gmailLastCheckAt).toLocaleTimeString() : " · checking your inbox");
    btn.textContent = "Disconnect";
  } else {
    statusEl.textContent = gmailNote || (state.gmailWasConnected ? "Disconnected. Tap Reconnect." : "Ready to connect");
    btn.textContent = state.gmailWasConnected ? "Reconnect" : "Connect Gmail";
  }
  if (connected && gmailNote) statusEl.textContent += " · " + gmailNote;
  btn.onclick = gmailButtonAction;
  btn.disabled = false;
}

// ---------- in-app setup ----------
function setupOrigins() {
  const port = location.port ? ":" + location.port : "";
  return typeof isLocalHost === "function" && isLocalHost(location.hostname)
    ? [location.protocol + "//localhost" + port, location.protocol + "//127.0.0.1" + port]
    : [location.origin];
}

function openGmailSetup() {
  const originsHtml = setupOrigins().map((o) => `<div class="code-line"><code>${escapeHtml(o)}</code> <button class="btn-ghost btn-small" data-copy="${escAttr(o)}" onclick="navigator.clipboard.writeText(this.dataset.copy); showToast('Copied')">Copy</button></div>`).join("");
  document.getElementById("modal-root").innerHTML = `
    <div class="modal-overlay" onclick="if(event.target===this) closeModal()">
      <div class="modal" style="max-width:520px;">
        <h2>Connect Google</h2>
        <p class="panel-sub">Google needs a free "Client ID" for this copy of Nudge. You make it once (about 3 minutes). After that, connecting is one click.</p>
        <ol class="steps" style="margin-top:0;">
          <li><a class="link" href="https://console.cloud.google.com/apis/library/gmail.googleapis.com" target="_blank" rel="noopener">Open the Gmail API page</a>, create a project if it asks, and press <strong>Enable</strong>. For sync, also enable the <a class="link" href="https://console.cloud.google.com/apis/library/drive.googleapis.com" target="_blank" rel="noopener">Google Drive API</a>.</li>
          <li><a class="link" href="https://console.cloud.google.com/apis/credentials" target="_blank" rel="noopener">Open Credentials</a> and choose <strong>Create credentials &gt; OAuth client ID &gt; Web application</strong>. Under <strong>Authorized JavaScript origins</strong> add:${originsHtml}
            If Google first asks for a consent screen, choose <strong>External</strong> and add your own Gmail as a <strong>test user</strong>.</li>
          <li>Copy the <strong>Client ID</strong> and paste it below.</li>
        </ol>
        <div class="field"><label>Client ID</label>
          <input id="gmail-client-id" value="${escAttr(state.gmailClientId || "")}" placeholder="123456-abc.apps.googleusercontent.com" />
        </div>
        <p class="panel-note">Google may say "unverified app" because it's your own: choose Advanced, then continue. On Android you can skip all of this, because the Nudge Android app also reads Gmail notifications. To skip this window for everyone who uses your copy, put the Client ID in <code>config.js</code>.</p>
        <div class="modal-actions">
          <button class="btn-ghost" onclick="closeModal()">Cancel</button>
          <button class="btn-primary" onclick="saveGmailClientId()">Save and connect</button>
        </div>
      </div>
    </div>`;
}

function saveGmailClientId() {
  const id = document.getElementById("gmail-client-id").value.trim();
  if (!/^[\w-]+(\.[\w-]+)*\.apps\.googleusercontent\.com$/.test(id)) {
    showToast("That doesn't look like a Client ID. It ends in .apps.googleusercontent.com");
    return;
  }
  state.gmailClientId = id;
  gmailTokenClient = null;
  gmailInitTries = 0;
  persistOnly();
  closeModal();
  initGmail();
  connectGmail();
}

// ---------- checking the inbox ----------
async function pollGmail() {
  if (!gmailAccessToken || gmailPolling) return;
  if (Date.now() > gmailTokenExpiresAt) { expireGmail(); return; }
  gmailPolling = true;
  const startedAt = Date.now();
  const auth = { headers: { Authorization: "Bearer " + gmailAccessToken } };
  try {
    // Only mail since the last check (with 5 minutes of overlap), never older than 2 days.
    const since = Math.max((state.gmailLastPoll || startedAt) - 5 * 60000, startedAt - 2 * DAY_MS);
    const q = `after:${Math.floor(since / 1000)} ${GMAIL_QUERY_FILTER}`;
    const listRes = await fetch(
      "https://www.googleapis.com/gmail/v1/users/me/messages?maxResults=" + gmailMaxResults() + "&q=" + encodeURIComponent(q), auth
    );
    if (listRes.status === 401) { expireGmail(); return; }
    if (listRes.status === 403) { gmailNote = "Gmail refused access. Check that the Gmail API is enabled and you're a test user."; renderGmailCard(); return; }
    if (!listRes.ok) throw new Error("Gmail list request failed: " + listRes.status);
    const messages = (await listRes.json()).messages || [];

    for (const m of messages) {
      if (state.gmailProcessedIds.includes(m.id)) continue;
      const msgRes = await fetch(
        `https://www.googleapis.com/gmail/v1/users/me/messages/${m.id}?format=metadata&metadataHeaders=Subject`, auth
      );
      if (!msgRes.ok) continue;
      const msgData = await msgRes.json();
      const subjectHeader = (msgData.payload?.headers || []).find((h) => h.name === "Subject");
      const subject = subjectHeader?.value || "";
      const text = (subject + (msgData.snippet ? " — " + msgData.snippet : "")).trim();

      state.gmailProcessedIds.push(m.id);
      if (state.gmailProcessedIds.length > 300) state.gmailProcessedIds.shift();

      if (text && looksLikeTask(text)) addDetectedSignal({ id: "gmail-" + m.id, source: "Gmail", raw: text });
    }
    state.gmailLastPoll = startedAt;
    gmailLastCheckAt = Date.now();
    gmailNote = "";
    persistOnly();
    renderGmailCard();
  } catch (e) {
    console.error("Gmail poll error", e);
    gmailNote = "Couldn't reach Gmail. Will retry.";
    renderGmailCard();
  } finally { gmailPolling = false; }
}

function startGmailPolling() {
  clearInterval(gmailPollTimer);
  pollGmail();
  gmailPollTimer = setInterval(pollGmail, GMAIL_POLL_INTERVAL_MS);
}

window.addEventListener("load", () => { setTimeout(initGmail, 300); });
