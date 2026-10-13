// ---------------------------------------------------------------------------
// In-app dialogs. Replaces the browser's built-in confirm boxes, which show the
// page address ("127.0.0.1:5500 says") and look out of place, especially on phones.
// ---------------------------------------------------------------------------

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
