// ---------------------------------------------------------------------------
// Subscription plans, feature gating and billing for Nudge.
//
// IMPORTANT: a browser-only app cannot safely take payments or prove that
// someone paid. Out of the box this runs in DEMO mode (no money moves, the plan
// is stored in localStorage). To charge real money, fill in BILLING.checkoutUrls
// (e.g. Stripe / PayMongo / Lemon Squeezy payment links) and BILLING.verifyEndpoint
// (a tiny server of yours that confirms who has paid). See README.md > "Billing".
// ---------------------------------------------------------------------------

const BILLING = {
  currency: "₱",                       // change to "$", "€", ... as needed
  checkoutUrls: { premium: "", pro: "" }, // payment-link URLs. Empty = demo checkout
  manageUrl: "",                       // customer-portal URL for cancel / switch plan
  verifyEndpoint: "",                  // GET <url>?uid=<id> -> { plan, renewsAt, cancelAtPeriodEnd }
  demoPeriodDays: 30,
};

const DAY_MS = 24 * 60 * 60 * 1000;
const PLAN_ORDER = ["free", "premium", "pro"];

const PLANS = {
  free: {
    id: "free", name: "Free", price: 0, tagline: "The essentials",
    perks: [
      "Tasks, categories and real notifications",
      "Signal Feed with basic detection",
      "Follow-up, delegation and tone detection",
      "Gmail connection",
      "5 automatic detections per day",
    ],
  },
  premium: {
    id: "premium", name: "Premium", price: 99, tagline: "Smarter capture",
    perks: [
      "More automatic detections (50 per day)",
      "AI task extraction",
      "Smart deadline detection",
      "Priority detection",
      "Smart follow-ups",
      "Calendar integration",
      "Voice-to-task",
    ],
  },
  pro: {
    id: "pro", name: "Pro", price: 159, tagline: "Everything, everywhere",
    perks: [
      "Everything in Premium",
      "Unlimited automatic detections",
      "Advanced AI",
      "Cross-device synchronization",
      "Multiple integrations",
      "Advanced automation",
      "Personalized task detection",
    ],
  },
};

// plan = the lowest plan that includes the feature.
const FEATURES = {
  moreDetections: { plan: "premium", label: "More automatic detections", desc: "Raise the daily detection limit from 5 to 50 and scan deeper into your inbox." },
  aiExtraction: { plan: "premium", label: "AI task extraction", desc: "Paste an email, chat or meeting notes and Nudge pulls out every task, with dates and priorities." },
  smartDeadline: { plan: "premium", label: "Smart deadline detection", desc: "Understands “next Friday”, “end of the month”, “in 3 days”, “the 15th” and “tomorrow afternoon”." },
  priorityDetection: { plan: "premium", label: "Priority detection", desc: "Scores every task by wording, topic and how close the deadline is, and tells you why." },
  smartFollowUps: { plan: "premium", label: "Smart follow-ups", desc: "Nudges you to check in on delegated tasks and to reschedule overdue ones." },
  calendar: { plan: "premium", label: "Calendar integration", desc: "Agenda view, .ics export and one-click Add to Google Calendar." },
  voiceToTask: { plan: "premium", label: "Voice-to-task", desc: "Say a task out loud and it lands in your list, parsed like typed text." },
  advancedAI: { plan: "pro", label: "Advanced AI", desc: "Connect your own AI endpoint for deeper extraction, plus smarter categories and assignees." },
  sync: { plan: "pro", label: "Cross-device synchronization", desc: "Keep tasks, rules and learning in step across your phone, laptop and tablet." },
  integrations: { plan: "pro", label: "Multiple integrations", desc: "Send task events to webhooks (Zapier, Make), Discord and Telegram, and bring in your phone's notifications, including Messenger." },
  automation: { plan: "pro", label: "Advanced automation", desc: "If-this-then-that rules that auto-add, ignore, re-prioritize or forward detections." },
  personalized: { plan: "pro", label: "Personalized task detection", desc: "Nudge learns which words you act on and which you ignore, and filters to match." },
};

const DETECTION_LIMITS = { free: 5, premium: 50, pro: Infinity };

// ---------- plan helpers ----------
function currentPlan() {
  const p = state && state.sub && state.sub.plan;
  return PLANS[p] ? p : "free";
}
function planRank(id) { return PLAN_ORDER.indexOf(id); }
function hasFeature(key) {
  const f = FEATURES[key];
  return !!f && planRank(currentPlan()) >= planRank(f.plan);
}
function requireFeature(key) {
  if (hasFeature(key)) return true;
  openUpgradePrompt(key);
  return false;
}
function fmtPrice(price) { return price === 0 ? "Free" : BILLING.currency + price + "/month"; }
function isDemoBilling() { return !BILLING.checkoutUrls.premium && !BILLING.checkoutUrls.pro; }
function fmtLongDate(ms) { return new Date(ms).toLocaleDateString(undefined, { year: "numeric", month: "short", day: "numeric" }); }

// Shown in place of a premium view when the plan doesn't include it.
function lockCardHtml(keys) {
  const list = Array.isArray(keys) ? keys : [keys];
  const plan = PLANS[FEATURES[list[0]].plan];
  const items = list.map((k) => `<li><strong>${FEATURES[k].label}</strong> — ${FEATURES[k].desc}</li>`).join("");
  return `
    <div class="lock-card">
      <div class="lock-icon">🔒</div>
      <h2 class="font-display">Included with ${plan.name}</h2>
      <ul class="lock-list">${items}</ul>
      <p class="lock-plan">${plan.name} is ${fmtPrice(plan.price)}.</p>
      <div style="display:flex; gap:8px; justify-content:center; flex-wrap:wrap;">
        <button class="btn-primary" onclick="startCheckout('${plan.id}')">Get ${plan.name}</button>
        <button class="btn-ghost" onclick="setView('plans')">Compare plans</button>
      </div>
    </div>`;
}

function openUpgradePrompt(key) {
  const f = FEATURES[key];
  const plan = PLANS[f.plan];
  document.getElementById("modal-root").innerHTML = `
    <div class="modal-overlay" onclick="if(event.target===this) closeModal()">
      <div class="modal">
        <h2>🔒 ${f.label}</h2>
        <p style="font-size:13px; color:var(--text-muted); line-height:1.5; margin:0 0 6px;">${f.desc}</p>
        <p style="font-size:13px; margin:0;">Included with <strong>${plan.name}</strong> (${fmtPrice(plan.price)}).</p>
        <div class="modal-actions">
          <button class="btn-ghost" onclick="closeModal()">Not now</button>
          <button class="btn-ghost" onclick="closeModal(); setView('plans')">Compare plans</button>
          <button class="btn-primary" onclick="startCheckout('${plan.id}')">Get ${plan.name}</button>
        </div>
      </div>
    </div>`;
}

// ---------- checkout / activation ----------
function startCheckout(planId) {
  closeModal();
  if (!PLANS[planId] || planId === "free") return;
  const url = BILLING.checkoutUrls[planId];
  if (url) {
    const sep = url.includes("?") ? "&" : "?";
    window.open(url + sep + "client_reference_id=" + encodeURIComponent(state.sub.userId), "_blank", "noopener");
    showToast("Finish paying in the new tab, then press “Refresh plan status” on the Plans page.");
    setView("plans");
    return;
  }
  openDemoCheckout(planId);
}

function openDemoCheckout(planId) {
  const plan = PLANS[planId];
  const verb = planRank(planId) > planRank(currentPlan()) ? "Start" : "Switch to";
  document.getElementById("modal-root").innerHTML = `
    <div class="modal-overlay" onclick="if(event.target===this) closeModal()">
      <div class="modal">
        <h2>${verb} ${plan.name}</h2>
        <div class="checkout-line"><span>${plan.name} plan</span><strong>${fmtPrice(plan.price)}</strong></div>
        <ul class="plan-perks" style="margin:10px 0;">${plan.perks.map((p) => `<li>${p}</li>`).join("")}</ul>
        <div class="demo-note">Demo mode: no payment is taken and nothing is sent anywhere. Connect a payment provider in subscription.js to charge for real.</div>
        <div class="modal-actions">
          <button class="btn-ghost" onclick="closeModal()">Cancel</button>
          <button class="btn-primary" onclick="activatePlan('${plan.id}')">${verb} ${plan.name} (demo)</button>
        </div>
      </div>
    </div>`;
}

function activatePlan(planId, opts = {}) {
  if (!PLANS[planId]) return;
  const s = state.sub;
  const wasRank = planRank(s.plan);
  s.plan = planId;
  s.since = s.since || Date.now();
  s.renewsAt = opts.renewsAt || Date.now() + BILLING.demoPeriodDays * DAY_MS;
  s.cancelAtPeriodEnd = false;
  closeModal();
  saveState();
  if (planRank(planId) > wasRank) releaseHeld();
  showToast(`You're on ${PLANS[planId].name}.`);
}

async function cancelSubscription() {
  if (!isDemoBilling()) {
    if (BILLING.manageUrl) window.open(BILLING.manageUrl, "_blank", "noopener");
    else showToast("Cancel from your payment provider's billing page.");
    return;
  }
  if (!(await confirmDialog("You keep your " + PLANS[currentPlan()].name + " plan until " + fmtLongDate(state.sub.renewsAt) + ".", "Cancel subscription", { title: "Cancel your subscription?", danger: true }))) return;
  state.sub.cancelAtPeriodEnd = true;
  saveState();
  showToast("Cancelled. Your plan stays active until " + fmtLongDate(state.sub.renewsAt) + ".");
}

function resumeSubscription() {
  if (!isDemoBilling()) {
    if (BILLING.manageUrl) window.open(BILLING.manageUrl, "_blank", "noopener");
    return;
  }
  state.sub.cancelAtPeriodEnd = false;
  saveState();
  showToast("Subscription resumed.");
}

function switchPlan(planId) {
  if (!isDemoBilling()) {
    if (BILLING.manageUrl) window.open(BILLING.manageUrl, "_blank", "noopener");
    else showToast("Change plans from your payment provider's billing page.");
    return;
  }
  openDemoCheckout(planId);
}

// Asks your server which plan this user has paid for.
async function refreshPlanStatus(silent) {
  if (!BILLING.verifyEndpoint) {
    if (!silent) showToast("No verify endpoint is configured in subscription.js.");
    return;
  }
  try {
    const res = await fetch(BILLING.verifyEndpoint + "?uid=" + encodeURIComponent(state.sub.userId));
    if (!res.ok) throw new Error("HTTP " + res.status);
    const data = await res.json();
    const plan = PLANS[data.plan] ? data.plan : "free";
    const renews = data.renewsAt ? new Date(data.renewsAt).getTime() : null;
    state.sub.plan = plan;
    state.sub.renewsAt = plan === "free" ? null : renews;
    state.sub.cancelAtPeriodEnd = !!data.cancelAtPeriodEnd;
    saveState();
    if (planRank(plan) > 0) releaseHeld();
    if (!silent) showToast("Plan status: " + PLANS[plan].name);
  } catch (e) {
    console.warn("Plan verification failed", e);
    if (!silent) showToast("Couldn't check your plan status. Try again in a moment.");
  }
}

// Called on a timer: ends cancelled plans, renews demo plans, re-verifies real ones.
function checkSubscription() {
  const s = state.sub;
  if (!s || s.plan === "free" || !s.renewsAt || Date.now() < s.renewsAt) return;
  if (s.cancelAtPeriodEnd) {
    s.plan = "free"; s.renewsAt = null; s.cancelAtPeriodEnd = false;
    saveState();
    showToast("Your subscription ended. You're back on Free.");
    return;
  }
  if (!isDemoBilling()) { refreshPlanStatus(true); return; }
  while (s.renewsAt <= Date.now()) s.renewsAt += BILLING.demoPeriodDays * DAY_MS;
  saveState();
}

// ---------- rendering ----------
function renderPlanBox() {
  const el = document.getElementById("plan-box");
  if (!el) return;
  const cur = currentPlan();
  const plan = PLANS[cur];
  const limit = DETECTION_LIMITS[cur];
  const usage = limit === Infinity ? "Unlimited detections" : `${Math.min(state.usage.detections, limit)}/${limit} detections today`;
  el.className = "plan-box plan-" + cur;
  el.innerHTML = `
    <div class="plan-box-top"><span class="plan-box-name">${plan.name}</span><span class="plan-box-usage">${usage}</span></div>
    <button onclick="setView('plans')">${cur === "pro" ? "Manage plan" : "See upgrades"}</button>`;
}

function renderPlans() {
  const el = document.getElementById("plans-body");
  if (!el) return;
  const cur = currentPlan();
  const s = state.sub;
  const cards = PLAN_ORDER.map((id) => {
    const p = PLANS[id];
    let action;
    if (id === cur) action = `<button class="btn-ghost plan-btn" disabled>Your plan</button>`;
    else if (id === "free") action = cur === "free" ? "" : `<button class="btn-ghost plan-btn" onclick="cancelSubscription()">${s.cancelAtPeriodEnd ? "Cancellation scheduled" : "Downgrade to Free"}</button>`;
    else if (planRank(id) > planRank(cur)) action = `<button class="btn-primary plan-btn" onclick="startCheckout('${id}')">Get ${p.name} · ${fmtPrice(p.price)}</button>`;
    else action = `<button class="btn-ghost plan-btn" onclick="switchPlan('${id}')">Switch to ${p.name}</button>`;
    return `
      <div class="plan-card ${id === cur ? "current" : ""} ${id === "pro" ? "featured" : ""}">
        <div class="plan-card-head">
          <h2 class="font-display">${p.name}</h2>
          ${id === cur ? '<span class="tag">Current</span>' : ""}
        </div>
        <div class="plan-price font-display">${p.price === 0 ? "Free" : `${BILLING.currency}${p.price}<span>/month</span>`}</div>
        <div class="plan-tagline">${p.tagline}</div>
        <ul class="plan-perks">${p.perks.map((x) => `<li>${x}</li>`).join("")}</ul>
        ${action}
      </div>`;
  }).join("");

  let status = "";
  if (cur !== "free" && s.renewsAt) {
    status = s.cancelAtPeriodEnd
      ? `<div class="plan-status">Your ${PLANS[cur].name} plan ends on ${fmtLongDate(s.renewsAt)}. <button class="btn-ghost btn-small" onclick="resumeSubscription()">Keep my plan</button></div>`
      : `<div class="plan-status">Your ${PLANS[cur].name} plan renews on ${fmtLongDate(s.renewsAt)}. <button class="btn-ghost btn-small" onclick="cancelSubscription()">Cancel subscription</button></div>`;
  }
  const verify = BILLING.verifyEndpoint ? `<button class="btn-ghost btn-small" onclick="refreshPlanStatus()">Refresh plan status</button>` : "";
  const demo = isDemoBilling() ? `<div class="demo-note">Demo mode: no payment is taken.</div>` : "";

  el.innerHTML = `${demo}<div class="plan-grid">${cards}</div>${status}${verify ? `<div style="margin-top:10px;">${verify}</div>` : ""}`;
}
