// ---------------------------------------------------------------------------
// "Get the app" page: open Nudge on your phone, install it to the home screen
// (PWA), and download the Android companion. Also the mobile menu toggle.
// ---------------------------------------------------------------------------

// After you build the Android app (README), either upload it to downloads/nudge-companion.apk
// on your site, or paste its public link here (for example a GitHub release link).
const APK_URL = "";
const APK_LOCAL_PATH = "downloads/nudge-companion.apk";

let deferredInstall = null;
let apkInfo = { checked: false, available: false, size: null };

function currentHost() { return location.hostname; }
function isLocalHost(h) {
  return h === "localhost" || h === "127.0.0.1" || h === "::1" || h === "[::1]" || /\.local$/.test(h) ||
    /^10\./.test(h) || /^192\.168\./.test(h) || /^172\.(1[6-9]|2\d|3[01])\./.test(h);
}
function isStandalone() {
  return (window.matchMedia && window.matchMedia("(display-mode: standalone)").matches) || navigator.standalone === true;
}
function devicePlatform() {
  const ua = navigator.userAgent || "";
  if (/android/i.test(ua)) return "android";
  if (/iphone|ipad|ipod/i.test(ua)) return "ios";
  return "desktop";
}

window.addEventListener("beforeinstallprompt", (e) => { e.preventDefault(); deferredInstall = e; renderPremium(); });
window.addEventListener("appinstalled", () => { deferredInstall = null; showToast("Nudge is installed. Open it from your home screen."); renderPremium(); });

async function installPwa() {
  if (!deferredInstall) { showToast("Use your browser's menu: Install app (Chrome) or Add to Home Screen."); return; }
  deferredInstall.prompt();
  try { await deferredInstall.userChoice; } catch (e) { /* dismissed */ }
  deferredInstall = null;
  renderPremium();
}

async function checkApk() {
  if (APK_URL) { apkInfo = { checked: true, available: true, size: null }; return; }
  try {
    const res = await fetch(APK_LOCAL_PATH, { method: "HEAD", cache: "no-store" });
    const type = res.headers.get("content-type") || "";
    apkInfo = { checked: true, available: res.ok && !/text\/html/i.test(type), size: parseInt(res.headers.get("content-length") || "0", 10) || null };
  } catch (e) {
    apkInfo = { checked: true, available: false, size: null };
  }
  renderPremium();
}

// ---- desktop menu: hide / show the sidebar, fold the "Plans and tools" group (remembered) ----
const MENU_KEY = "nudge.menu";
function menuPrefs() { try { return JSON.parse(localStorage.getItem(MENU_KEY)) || {}; } catch (e) { return {}; } }
function saveMenuPrefs(p) { try { localStorage.setItem(MENU_KEY, JSON.stringify(p)); } catch (e) { /* private mode */ } }
function toggleSidebar(force) {
  const hide = typeof force === "boolean" ? force : !document.body.classList.contains("sidebar-collapsed");
  document.body.classList.toggle("sidebar-collapsed", hide);
  saveMenuPrefs({ ...menuPrefs(), sidebarHidden: hide });
}
function toggleGroup(name, force) {
  const group = document.getElementById("nav-" + name), btn = document.getElementById("nav-" + name + "-toggle");
  if (!group) return;
  const fold = typeof force === "boolean" ? force : !group.classList.contains("collapsed");
  group.classList.toggle("collapsed", fold);
  if (btn) btn.classList.toggle("collapsed", fold);
  const p = menuPrefs(); p.groups = { ...(p.groups || {}), [name]: fold }; saveMenuPrefs(p);
}

// ---- Admin has no menu item. Open it by tapping the logo 5 times, or with #admin on the address. ----
let logoTaps = [];
function logoTap() {
  const now = Date.now();
  logoTaps = logoTaps.filter((t) => now - t < 3000);
  logoTaps.push(now);
  if (logoTaps.length >= 5) { logoTaps = []; openAdmin(); }
}
function openAdmin() { setView("admin"); }
function checkAdminHash() {
  if (location.hash.toLowerCase() === "#admin") {
    history.replaceState(null, "", location.pathname + location.search);   // don't leave it in the address bar
    openAdmin();
  }
}
// The Android app's "Open Nudge and connect" button opens Nudge with #pair=<token>. Connect without any copy and paste.
function checkPairHash() {
  const m = /^#pair=([0-9a-f]{16,128})$/i.exec(location.hash);
  if (!m) return;
  history.replaceState(null, "", location.pathname + location.search);   // remove the token from the address bar
  if (!hasFeature("integrations")) { openUpgradePrompt("integrations"); return; }
  const r = state.relay;
  r.url = "http://127.0.0.1:8765"; r.token = m[1]; r.enabled = true; r.lastSeq = 0; r.epoch = null; r.seen = [];
  persistOnly();
  setView("integrations");
  showToast("Connected to the Nudge Android app on this phone.");
  pollRelay(false);
}
function checkHash() { checkAdminHash(); checkPairHash(); }
function initMenu() {
  const p = menuPrefs();
  if (p.sidebarHidden) document.body.classList.add("sidebar-collapsed");
  Object.entries(p.groups || {}).forEach(([name, fold]) => toggleGroup(name, !!fold));
  checkHash();
  window.addEventListener("hashchange", checkHash);
}

function toggleMenu(force) {
  const sb = document.getElementById("sidebar");
  if (!sb) return;
  const open = typeof force === "boolean" ? force : !sb.classList.contains("open");
  sb.classList.toggle("open", open);
  document.body.classList.toggle("menu-open", open);
}

function qrSvg(text) {
  if (typeof qrcode !== "function") return "";
  try {
    qrcode.stringToBytes = qrcode.stringToBytesFuncs["UTF-8"];
    const qr = qrcode(0, "M");
    qr.addData(text);
    qr.make();
    return qr.createSvgTag({ cellSize: 4, margin: 0, scalable: true });
  } catch (e) { return ""; }
}
function copyText(text) {
  navigator.clipboard.writeText(text).then(() => showToast("Copied"), () => showToast("Couldn't copy. Select it and copy manually."));
}

function renderInstall() {
  const el = document.getElementById("install-body");
  if (!el) return;
  if (!apkInfo.checked) checkApk();

  const plat = devicePlatform();
  const host = currentHost();
  const local = isLocalHost(host);
  const onPhone = plat !== "desktop";
  const url = location.origin + location.pathname.replace(/[^/]*$/, "");

  // ---- block 1: getting Nudge onto the phone ----
  let main;
  if (isStandalone()) {
    main = `<h2 class="font-display">Nudge is installed</h2><p class="panel-sub" style="margin:0;">You're using the installed app.</p>`;
  } else if (local) {
    const port = location.port || "80";
    main = `
      <h2 class="font-display">Run Nudge on your phone</h2>
      <p class="panel-sub">Your phone can't open <code>${escapeHtml(location.host)}</code> (that means "this computer"). A USB cable connects them, and no website is needed:</p>
      <ol class="steps" style="margin-top:0;">
        <li>On the phone: <strong>Settings &gt; About phone</strong>, tap <strong>Build number</strong> 7 times, then open <strong>Developer options</strong> and turn on <strong>USB debugging</strong>. Plug the phone into this computer and tap Allow.</li>
        <li>On this computer, open Chrome and go to <code>chrome://inspect/#devices</code>. Tick <strong>Discover USB devices</strong>, click <strong>Port forwarding…</strong>, add port <code>${escapeHtml(port)}</code> with address <code>localhost:${escapeHtml(port)}</code>, tick <strong>Enable port forwarding</strong> and press Done.</li>
        <li>On the phone, open Chrome and go to <code>http://localhost:${escapeHtml(port)}</code>. Open the menu (⋮) and choose <strong>Install app</strong>.</li>
      </ol>
      <p class="panel-note" style="margin-top:10px;">After installing, Nudge opens from your home screen with the cable unplugged and this computer off. It keeps its own copy and your tasks stay on the phone. To pick up changes you make here, plug in and open it once with forwarding on. Google sign-in on the phone needs <code>http://localhost:${escapeHtml(port)}</code> in your Google client's origins (the Gmail setup shows it). iPhone can't do this; see the README to put the site online instead.</p>`;
  } else if (!onPhone) {
    const svg = qrSvg(url);
    main = `
      <h2 class="font-display">Open Nudge on your phone</h2>
      <div class="install-row" style="margin-top:12px;">
        ${svg ? `<div class="qr-box">${svg}</div>` : ""}
        <div>
          <p class="panel-sub" style="margin:0 0 8px;">Scan this with your phone's camera, then tap <strong>Install Nudge</strong> on this page.</p>
          <div class="install-url">${escapeHtml(url)}</div>
          <div class="panel-actions" style="margin-top:8px;">
            <button class="btn-ghost btn-small" data-copy="${escAttr(url)}" onclick="copyText(this.dataset.copy)">Copy link</button>
            ${deferredInstall ? `<button class="btn-ghost btn-small" onclick="installPwa()">Install on this computer</button>` : ""}
          </div>
        </div>
      </div>`;
  } else if (deferredInstall) {
    main = `<h2 class="font-display">Install Nudge</h2>
      <p class="panel-sub">Adds Nudge to your home screen. It opens full screen and works offline.</p>
      <div class="panel-actions" style="margin-top:0;"><button class="btn-primary" onclick="installPwa()">Install Nudge</button></div>`;
  } else if (plat === "ios") {
    main = `<h2 class="font-display">Install Nudge</h2>
      <p class="panel-sub" style="margin:0;">In Safari, tap the Share button, then <strong>Add to Home Screen</strong>.</p>`;
  } else {
    main = `<h2 class="font-display">Install Nudge</h2>
      <p class="panel-sub" style="margin:0;">Open your browser menu and choose <strong>Install app</strong> or <strong>Add to Home Screen</strong>. If you don't see it, reload the page once.</p>`;
  }

  // ---- block 2: the Android app (reads other apps' notifications) ----
  const apkHref = APK_URL || APK_LOCAL_PATH;
  const sizeMb = apkInfo.size ? ` (${(apkInfo.size / 1048576).toFixed(1)} MB)` : "";
  let android;
  if (apkInfo.available) {
    android = `
      <div class="panel">
        <h2 class="font-display">Android app <span class="tag">Pro</span></h2>
        <p class="panel-sub">Passes on notifications from all your apps, including Messenger, so Nudge can turn them into tasks. Everything stays on your phone.</p>
        <div class="demo-note">If you open the downloaded file on the phone, Android may say <strong>"App blocked to protect your device"</strong>. That is Google Play Protect's rule for any app that reads notifications, not a problem with the file, and it has no "Install anyway". Install it from your computer over USB instead:</div>
        <ol class="steps" style="margin-top:0;">
          <li>On the phone turn on <strong>USB debugging</strong> (Settings &gt; About phone &gt; tap Build number 7 times &gt; Developer options) and plug it into your computer.</li>
          <li>In the Nudge folder on your computer, double-click <code>install-on-phone.bat</code> (Mac or Linux: run <code>install-on-phone.sh</code>). It fetches Google's installer tool and installs the app. Tap <strong>Allow</strong> on the phone if it asks.</li>
          <li>Open <strong>Nudge Companion</strong>. Tap <strong>A. Open App info</strong>, then the three dots (top right) and <strong>Allow restricted settings</strong>. Press Back and tap <strong>B. Turn on notification access</strong> and switch it on. (Android needs both because the app didn't come from the Play Store.)</li>
          <li>Tap <strong>Open Nudge and connect</strong>. That's it: Nudge connects itself. No token to copy.</li>
        </ol>
        <div class="panel-actions"><a class="btn-ghost btn-small" style="text-decoration:none;" href="${escAttr(apkHref)}" download>Download the app file${sizeMb}</a><span class="panel-note">for the computer installer, or for phones that allow it</span></div>
      </div>`;
  } else {
    android = `
      <div class="panel">
        <h2 class="font-display">Android app <span class="tag">Pro</span></h2>
        <p class="panel-sub" style="margin:0;">Not available on this site yet.${local ? " Build it with the GitHub workflow or Android Studio (see the README), then set <code>APK_URL</code> in <code>install.js</code>." : ""}</p>
      </div>`;
  }

  el.innerHTML = `<div class="panel">${main}</div>${android}`;
}

if ("serviceWorker" in navigator) {
  window.addEventListener("load", () => { navigator.serviceWorker.register("sw.js").catch(() => {}); });
}
