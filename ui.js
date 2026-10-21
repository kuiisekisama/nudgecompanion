const APP_VERSION = "2026.10.13";
let dialogResolve = null;

// askDialog("Delete it?", ["Cancel", "Delete"]) -> index of the pressed button, or -1 if dismissed.
// The last button is the main (highlighted) one.
function askDialog(message, buttons, opts = {}) {
  return new Promise((resolve) => {
    if (dialogResolve) dialogResolve(-1);
    dialogResolve = resolve;
    const root = document.getElementById("dialog-root");
    const last = buttons.length - 1;
    root.innerHTML = `
      <div class="modal-overlay" onclick="if(event.target===this) answerDialog(-1)">
        <div class="modal dialog" role="dialog" aria-modal="true">
          ${opts.title ? `<h2>${escapeHtml(opts.title)}</h2>` : ""}
          <p class="dialog-text">${escapeHtml(message).replace(/\n/g, "<br>")}</p>
          <div class="modal-actions">
            ${buttons.map((b, i) => `<button class="${i === last ? (opts.danger ? "btn-primary btn-danger" : "btn-primary") : "btn-ghost"}" onclick="answerDialog(${i})">${escapeHtml(b)}</button>`).join("")}
          </div>
        </div>
      </div>`;
    const main = root.querySelector(".btn-primary");
    if (main) main.focus();
  });
}

function answerDialog(index) {
  const root = document.getElementById("dialog-root");
  if (root) root.innerHTML = "";
  const resolve = dialogResolve;
  dialogResolve = null;
  if (resolve) resolve(index);
}

async function confirmDialog(message, okLabel = "OK", opts = {}) {
  return (await askDialog(message, ["Cancel", okLabel], opts)) === 1;
}

document.addEventListener("keydown", (e) => { if (e.key === "Escape" && dialogResolve) answerDialog(-1); });


// ---------------------------------------------------------------------------
// Theme: Auto (follows the phone/computer), Light, or Dark. Saved on this device only.
// The first paint is handled by a tiny script in index.html so the page never flashes the wrong colours.
// ---------------------------------------------------------------------------
function themeMode() {
  try { return localStorage.getItem("nudge-theme") || "auto"; } catch (e) { return "auto"; }
}
function applyTheme() {
  const mode = themeMode();
  const light = mode === "light" || (mode === "auto" && window.matchMedia && matchMedia("(prefers-color-scheme: light)").matches);
  if (light) document.documentElement.setAttribute("data-theme", "light");
  else document.documentElement.removeAttribute("data-theme");
  const tc = document.querySelector('meta[name="theme-color"]');
  if (tc) tc.setAttribute("content", light ? "#F4F5F9" : "#191C24");
  document.querySelectorAll("[data-theme-mode]").forEach((b) => b.classList.toggle("active", b.dataset.themeMode === mode));
}
function setTheme(mode) {
  try { localStorage.setItem("nudge-theme", mode); } catch (e) { /* private mode: it still applies until reload */ }
  applyTheme();
}
if (window.matchMedia) {
  const mq = matchMedia("(prefers-color-scheme: light)");
  const onChange = () => { if (themeMode() === "auto") applyTheme(); };
  if (mq.addEventListener) mq.addEventListener("change", onChange); else if (mq.addListener) mq.addListener(onChange);
}
document.addEventListener("DOMContentLoaded", applyTheme);
