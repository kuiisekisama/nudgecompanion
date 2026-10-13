// ---------- persistence ----------
const STORE_KEY = "nudge_state_v2";

function defaultState() {
  const now = Date.now();
  return {
    tasks: [],
    categories: [
      { id: "c1", name: "Work", color: "#7B9BD1" },
      { id: "c2", name: "School", color: "#A78BDB" },
      { id: "c3", name: "Personal", color: "#7FBF8F" },
    ],
    signals: [],
    gmailProcessedIds: [],
    ttsEnabled: true,
    sourceStats: {}, // { [source]: { ignored, added, muted } }
    ...defaultPremiumState(),
  };
}

function loadState() {
  try {
    const raw = localStorage.getItem(STORE_KEY);
    if (raw) {
      const parsed = JSON.parse(raw);
      if (!parsed.gmailProcessedIds) parsed.gmailProcessedIds = [];
      if (parsed.ttsEnabled === undefined) parsed.ttsEnabled = true;
      if (!parsed.sourceStats) parsed.sourceStats = {};
      fillDefaults(parsed, defaultPremiumState());
      // Retire the old demo content: the sample queue, and the two sample tasks if still untouched.
      delete parsed.signalQueue;
      if (parsed.sync) { delete parsed.sync.url; delete parsed.sync.anonKey; delete parsed.sync.key; }
      if (parsed.integrations && parsed.integrations.chat) {   // old combined chat box: keep a Discord link only
        const old = parsed.integrations.chat;
        if (/discord(app)?\.com\/api\/webhooks/.test(old.url || "")) parsed.integrations.discord = { url: old.url, enabled: !!old.enabled };
        delete parsed.integrations.chat;
      }
      const SAMPLES = { t1: "Submit tax documents", t2: "Review pull request" };
      parsed.tasks = parsed.tasks.filter((t) => SAMPLES[t.id] !== t.title);
      parsed.tasks.forEach((t) => { if (!t.createdAt) t.createdAt = Date.now(); if (!t.originSource) t.originSource = t.source === "manual" ? "Manual" : "Detected"; });
      return parsed;
    }
  } catch (e) { console.warn("Could not load saved state", e); }
  return defaultState();
}

function saveState() {
  state.localUpdatedAt = Date.now();
  localStorage.setItem(STORE_KEY, JSON.stringify(state));
  render();
}

let state = loadState();
let currentView = "tasks";
let currentFilter = "all";

// ---------- date helpers ----------
function todayMidnight() {
  const d = new Date();
  d.setHours(0, 0, 0, 0);
  return d.getTime();
}
function addDays(ms, days) { return ms + days * 24 * 60 * 60 * 1000; }
function daysSince(ms) { return Math.floor((Date.now() - ms) / (24 * 60 * 60 * 1000)); }
function fmtDate(ms) {
  if (!ms) return "No date";
  const diff = Math.round((ms - todayMidnight()) / (24 * 60 * 60 * 1000));
  if (diff === 0) return "Today";
  if (diff === 1) return "Tomorrow";
  if (diff === -1) return "Yesterday";
  return new Date(ms).toLocaleDateString(undefined, { month: "short", day: "numeric" });
}
function dueTimestamp(task) {
  if (!task.due) return null;
  if (!task.time) return task.due + 9 * 60 * 60 * 1000;
  const match = task.time.match(/(\d{1,2}):?(\d{2})?\s?(AM|PM)/i);
  if (!match) return task.due + 9 * 60 * 60 * 1000;
  let hours = parseInt(match[1], 10);
  const minutes = match[2] ? parseInt(match[2], 10) : 0;
  const ampm = match[3].toUpperCase();
  if (ampm === "PM" && hours !== 12) hours += 12;
  if (ampm === "AM" && hours === 12) hours = 0;
  return task.due + hours * 60 * 60 * 1000 + minutes * 60 * 1000;
}

// ---------- parsing ----------
const DAYS = ["sunday", "monday", "tuesday", "wednesday", "thursday", "friday", "saturday"];

const TASK_SIGNAL_WORDS = [
  // reminders and deadlines
  "don't forget", "dont forget", "remind", "reminder", "due", "deadline", "expires", "expiring", "renew",
  "overdue", "last day", "action required", "follow up", "follow-up", "asap", "urgent",
  // work and school
  "submit", "assignment", "homework", "quiz", "exam", "meeting", "interview", "invite", "rsvp", "agenda",
  "lecture", "presentation", "approve", "review",
  // appointments and plans
  "appointment", "schedule", "scheduled", "reschedule", "booking", "reservation", "flight", "check-in", "birthday",
  // money and errands
  "pay", "payment", "invoice", "balance due", "delivery", "delivered", "arriving", "pick up", "pickup",
  // asking you to do something
  "call", "reply", "respond", "confirm", "please send", "can you", "could you", "let me know", "need you to", "need to",
  // when
  "tomorrow", "today", "tonight"
];
// Whole-word matching ("exam" must not fire on "example", "call" not on "recall"). Short words also allow
// -s / -ed / -ing; longer words match as a prefix (remind -> reminders).
const TASK_SIGNAL_MATCHERS = TASK_SIGNAL_WORDS.map((w) => new RegExp("\\b" + w.replace(/[.*+?^${}()|[\]\\]/g, "\\$&") + (w.length <= 5 ? "(?:s|es|ed|ing)?\\b" : ""), "i"));

// Gate that decides whether text looks task-like at all, and (for feature 1)
// records WHICH words/patterns triggered the match so we can show our work.
function detectTaskSignals(text) {
  const lower = text.toLowerCase();
  const triggers = [];
  TASK_SIGNAL_MATCHERS.forEach((re) => { const m = lower.match(re); if (m) triggers.push(m[0]); });
  DAYS.forEach((d) => { if (lower.includes(d)) triggers.push(d); });
  const timeMatch = lower.match(/\b(\d{1,2})(:\d{2})?\s?(am|pm)\b/i) || lower.match(/\b([01]?\d|2[0-3]):[0-5]\d\b/);
  if (timeMatch) triggers.push(timeMatch[0].trim());
  if (hasFeature("smartDeadline")) {
    const smart = smartDeadline(text, false);
    if (smart) smart.phrases.forEach((p) => triggers.push(p));
  }
  return triggers;
}
function looksLikeTask(text) { return detectTaskSignals(text).length > 0; }

const URGENT_WORDS = ["asap", "urgent", "immediately", "right away", "as soon as possible", "critical", "emergency"];
const CASUAL_WORDS = ["whenever", "no rush", "no hurry", "when you get a chance", "eventually", "sometime", "no pressure"];

function detectUrgency(text) {
  const lower = text.toLowerCase();
  const urgentHit = URGENT_WORDS.find((w) => lower.includes(w));
  if (urgentHit) return { level: "high", trigger: urgentHit };
  const casualHit = CASUAL_WORDS.find((w) => lower.includes(w));
  if (casualHit) return { level: "low", trigger: casualHit };
  return { level: "medium", trigger: null };
}

function detectDelegation(text) {
  const match = text.match(/\b(?:ask|tell|have)\s+([A-Za-z]+)\s+to\b/i);
  return match ? { name: capitalize(match[1]), trigger: match[0] } : null;
}
function capitalize(word) { return word.charAt(0).toUpperCase() + word.slice(1).toLowerCase(); }

const FOLLOWUP_PHRASES = [
  "did you", "have you", "any update", "any progress", "still waiting",
  "following up", "haven't heard back", "reminder about", "checking on", "any news on"
];
const STOPWORDS = new Set([
  "the", "a", "an", "to", "for", "of", "on", "in", "did", "you", "have", "any", "update",
  "progress", "still", "waiting", "following", "up", "about", "checking", "news", "your",
  "my", "please", "can", "send", "submit", "with", "and", "yet"
]);

function detectFollowUp(text) {
  const lower = text.toLowerCase();
  const hit = FOLLOWUP_PHRASES.find((p) => lower.includes(p));
  return hit || null;
}
function significantWords(text) {
  return text.toLowerCase().replace(/[^a-z0-9\s]/g, "").split(/\s+/).filter((w) => w.length > 2 && !STOPWORDS.has(w));
}
function wordOverlapScore(wordsA, wordsB) {
  if (wordsA.length === 0 || wordsB.length === 0) return 0;
  const setB = new Set(wordsB);
  const overlap = wordsA.filter((w) => setB.has(w)).length;
  return overlap / wordsA.length;
}
function findMatchingTask(text) {
  const words = significantWords(text);
  let best = null, bestScore = 0;
  state.tasks.forEach((t) => {
    if (t.status !== "active") return;
    const score = wordOverlapScore(significantWords(t.title), words);
    if (score > bestScore) { bestScore = score; best = t; }
  });
  return bestScore >= 0.34 ? best : null;
}
function bumpPriority(priority) {
  if (priority === "low") return "medium";
  if (priority === "medium") return "high";
  return "high";
}

function parseFreeText(text, opts = {}) {
  const lower = text.toLowerCase();
  const today = todayMidnight();
  let due = null, matched = null;

  if (lower.includes("tomorrow")) { due = addDays(today, 1); matched = "tomorrow"; }
  else if (lower.includes("today")) { due = today; matched = "today"; }
  else {
    const now = new Date();
    for (let i = 0; i < DAYS.length; i++) {
      if (lower.includes(DAYS[i])) {
        const delta = (i - now.getDay() + 7) % 7 || 7;
        due = addDays(today, delta);
        matched = DAYS[i];
        break;
      }
    }
  }

  let timeRaw = null, time = null;
  const m12 = lower.match(/\b(\d{1,2})(:\d{2})?\s?(am|pm)\b/);
  const m24 = m12 ? null : lower.match(/\b([01]?\d|2[0-3]):([0-5]\d)\b/);
  if (m12) { timeRaw = m12[0]; time = m12[0].replace(/\s+/g, "").toUpperCase().replace(/(AM|PM)/, " $1").trim(); }
  else if (m24) {
    timeRaw = m24[0];
    const h = parseInt(m24[1], 10);
    time = (h % 12 || 12) + ":" + m24[2] + " " + (h >= 12 ? "PM" : "AM");
  }
  const smart = hasFeature("smartDeadline") ? smartDeadline(text, due !== null) : null;
  if (smart) {
    if (smart.due !== null) due = smart.due;
    else if (smart.eod && due === null) due = today;
    if (!time && smart.time) time = smart.time;
  }

  let title = text.trim();
  title = title.replace(/^(don'?t forget( to)?|please don'?t forget( to)?|reminder:?|hey,?)\s*/i, "");
  if (smart) {
    smart.phrases.forEach((ph) => { title = title.replace(new RegExp("(?:\\b(?:by|on|before|at|in|for|until)\\s+)?" + escapeRegex(ph), "i"), ""); });
    title = title.replace(/\b(by|on|before|at|in|for|until)\s*$/i, "").trim();
  }
  if (matched) title = title.replace(new RegExp("\\b" + matched + "\\b", "i"), "");
  if (timeRaw) title = title.replace(new RegExp(escapeRegex(timeRaw), "i"), "").replace(/\bat\b\s*$/i, "");
  title = title.replace(/[.,]\s*$/, "").replace(/\s+/g, " ").trim();
  title = title.charAt(0).toUpperCase() + title.slice(1);

  // "database at 10pm" with no date = 10 PM today. For text you type (opts.next), if that time has already
  // passed today it means the next one, tomorrow, like an alarm clock.
  const hadDate = due !== null; // a date was written in the text (not guessed from a bare time)
  if (time && due === null) {
    due = today;
    if (opts.next && dueTimestamp({ due, time }) <= Date.now()) due = addDays(today, 1);
  }
  return { title: title || text.trim(), due, time, hadDate };
}

// Unique across reloads and devices (a counter restarted at 1000 every page load).
const nextId = () => "t" + Date.now().toString(36) + Math.random().toString(36).slice(2, 8);

// ---------- notifications (real, via Service Worker) ----------
let swRegistration = null;

async function initNotifications() {
  if (!("Notification" in window)) {
    document.getElementById("perm-text").textContent = "Notifications not supported here (sound and voice alerts still work)";
    startReminderLoop();
    return;
  }
  if ("serviceWorker" in navigator) {
    try { swRegistration = await navigator.serviceWorker.register("sw.js"); }
    catch (e) { console.warn("Service worker registration failed (needs http/https, not file://)", e); }
  }
  updatePermissionUI();
  startReminderLoop();
}
function updatePermissionUI() {
  const box = document.getElementById("permission-box");
  const dot = document.getElementById("perm-dot");
  const text = document.getElementById("perm-text");
  const perm = ("Notification" in window) ? Notification.permission : "unsupported";
  if (perm === "granted") {
    box.className = "permission-box on"; dot.className = "status-dot on";
    text.textContent = "Real notifications enabled";
    box.querySelector("button").style.display = "none";
  } else if (perm === "denied") {
    box.className = "permission-box off"; dot.className = "status-dot off";
    text.textContent = "Notifications blocked — enable in browser site settings";
    box.querySelector("button").style.display = "none";
  } else {
    box.className = "permission-box off"; dot.className = "status-dot off";
    text.textContent = "Notifications not enabled yet";
    const btn = box.querySelector("button");
    if (btn) btn.style.display = "block";
  }
}
async function requestNotificationPermission() {
  if (!("Notification" in window)) return;
  await Notification.requestPermission();
  updatePermissionUI();
  if (Notification.permission === "granted") fireNotification("Nudge notifications are on", "You'll get a real alert when a task's reminder time arrives.");
}
function fireNotification(title, body, opts = {}) {
  if (!("Notification" in window) || Notification.permission !== "granted") return;
  const options = { body, tag: "nudge-" + Date.now(), icon: "icons/icon-192.png", silent: !!opts.silent };
  if (swRegistration) swRegistration.showNotification(title, options);
  else new Notification(title, options);
}

// ---------- 1-minute warning: notification + sound, then the voice ----------
const ALERT_SOUND_URL = "sounds/ayame-yo-dayo.mp3";
const WARN_LEAD_MS = 60 * 1000;
const warnTimers = {};
let alertAudio = null, audioUnlocked = false;

function getAlertAudio() {
  if (!alertAudio) { alertAudio = new Audio(ALERT_SOUND_URL); alertAudio.preload = "auto"; }
  return alertAudio;
}
// Browsers only allow sound after you've touched the page once, so do a silent play on the first tap.
function unlockAudio() {
  if (audioUnlocked) return;
  audioUnlocked = true;
  try {
    const a = getAlertAudio();
    a.muted = true;
    const p = a.play();
    if (p && p.then) p.then(() => { a.pause(); a.currentTime = 0; a.muted = false; }).catch(() => { a.muted = false; });
    else a.muted = false;
  } catch (e) { /* no audio support */ }
}
["pointerdown", "keydown"].forEach((ev) => document.addEventListener(ev, unlockAudio, { once: true, passive: true }));

// Resolves when the sound has finished (or can't play), so the voice always comes after it.
function playAlertSound() {
  return new Promise((resolve) => {
    let done = false;
    const finish = () => { if (!done) { done = true; resolve(); } };
    try {
      const a = getAlertAudio();
      a.currentTime = 0; a.muted = false;
      a.onended = finish; a.onerror = finish;
      const p = a.play();
      if (p && p.catch) p.catch(finish);
      setTimeout(finish, 9000);
    } catch (e) { finish(); }
  });
}
function speak(text) {
  if ("speechSynthesis" in window) speechSynthesis.speak(new SpeechSynthesisUtterance(text));
}

async function runOverdueSoonAlert(title) {
  const loud = state.ttsEnabled;
  fireNotification("Soon the task will be overdue", title, { silent: loud });   // our own sound plays instead
  showToast("⏳ Soon the task will be overdue: " + title);
  if (!loud) return;
  await playAlertSound();
  speak("Task overdue soon. " + title);
}
function testAlert() { runOverdueSoonAlert("Sample task"); }

function warnTask(id) {
  const task = state.tasks.find((t) => t.id === id);
  if (!task || task.status !== "active" || !task.reminder || task.warned) return;
  const due = dueTimestamp(task), left = due === null ? null : due - Date.now();
  if (left === null || left <= 0 || left > WARN_LEAD_MS + 5000) return;
  task.warned = true;
  saveState();
  runOverdueSoonAlert(task.title);
}
function clearWarn(id) { if (warnTimers[id]) { clearTimeout(warnTimers[id]); delete warnTimers[id]; } }
// Warn right away if a minute or less is left; otherwise set an exact timer when it's about to be.
function scheduleWarnings(now) {
  state.tasks.forEach((task) => {
    if (task.status !== "active" || !task.reminder || task.warned) { clearWarn(task.id); return; }
    const due = dueTimestamp(task);
    if (due === null || now >= due) return;
    const warnAt = due - WARN_LEAD_MS;
    if (now >= warnAt) { warnTask(task.id); return; }
    if (warnAt - now <= 90000 && !warnTimers[task.id]) {
      warnTimers[task.id] = setTimeout(() => { delete warnTimers[task.id]; warnTask(task.id); }, warnAt - now);
    }
  });
}
function startReminderLoop() { checkReminders(); setInterval(checkReminders, 20000); }
function checkReminders() {
  const now = Date.now();
  scheduleWarnings(now);
  let changed = false;
  state.tasks.forEach((task) => {
    if (task.status !== "active" || !task.reminder || task.notified) return;
    const due = dueTimestamp(task);
    const lead = (task.remindBefore || 0) * 60000;
    if (due !== null && due - lead <= now) {
      const early = lead > 0 && now < due;
      fireNotification((early ? "Coming up: " : "Task due: ") + task.title, early ? `Due in ${task.remindBefore} min` : (task.time ? `Due ${fmtDate(task.due)} at ${task.time}` : `Due ${fmtDate(task.due)}`));
      task.notified = true;
      changed = true;
      emitEvent("task.due", task);
    }
  });
  if (changed) saveState();
  onReminderTick();
}

// ---------- task CRUD ----------
function addTask(data) {
  const task = {
    id: nextId(), description: "", status: "active", source: "manual", originSource: "Manual",
    reminder: false, notified: false, createdAt: Date.now(), ...data,
  };
  state.tasks.push(task);
  saveState();
  emitEvent("task.created", task);
}
function updateTask(id, updates) {
  const task = state.tasks.find((t) => t.id === id);
  if (!task) return;
  Object.assign(task, updates);
  if (updates.due !== undefined || updates.time !== undefined || updates.reminder !== undefined) task.notified = false;
  saveState();
}
function deleteTask(id) { state.tasks = state.tasks.filter((t) => t.id !== id); saveState(); }
function toggleComplete(id) {
  const task = state.tasks.find((t) => t.id === id);
  if (!task) return;
  task.status = task.status === "completed" ? "active" : "completed";
  task.completedAt = task.status === "completed" ? Date.now() : null;
  saveState();
  if (task.status === "completed") emitEvent("task.completed", task);
}
function quickAdd(origin) {
  const input = document.getElementById("quick-add-input");
  const text = input.value.trim();
  if (!text) return;
  const { title, due, time } = parseFreeText(text, { next: true });
  const priority = hasFeature("priorityDetection") ? smartPriority(text, due).level : "medium";
  const category = guessCategory(text) || state.categories[0]?.name || "Personal";
  addTask({ title, due, time, priority, category, reminder: !!due, originSource: origin || "Manual" });
  input.value = "";
}

// ---------- categories ----------
const PALETTE = ["#7B9BD1", "#A78BDB", "#7FBF8F", "#D9A363", "#D98080", "#6EC2B8"];
function addCategory() {
  const input = document.getElementById("new-category-input");
  const name = input.value.trim();
  if (!name) return;
  state.categories.push({ id: "c" + Date.now(), name, color: PALETTE[state.categories.length % PALETTE.length] });
  input.value = "";
  saveState();
}
function deleteCategory(id) { state.categories = state.categories.filter((c) => c.id !== id); saveState(); }

// ---------- Feature: sender-specific learning ----------
function getSourceStat(source) {
  if (!state.sourceStats[source]) state.sourceStats[source] = { ignored: 0, added: 0, muted: false };
  return state.sourceStats[source];
}
function isSourceMuted(source) { return !!state.sourceStats[source]?.muted; }
function unmuteSource(source) {
  if (state.sourceStats[source]) state.sourceStats[source].muted = false;
  saveState();
}

// ---------- Feature: cross-source merging ----------
// Looks for an existing PENDING signal from a DIFFERENT source that's talking
// about the same thing, so two channels mentioning one task become one card.
function findMergeCandidate(text, source) {
  const words = significantWords(text);
  let best = null, bestScore = 0;
  state.signals.forEach((s) => {
    if (s.resolved) return;
    if (s.sources.includes(source)) return; // only merge across DIFFERENT sources
    const score = Math.max(
      wordOverlapScore(significantWords(s.title), words),
      wordOverlapScore(significantWords(s.rawTexts[s.rawTexts.length - 1]), words)
    );
    if (score > bestScore) { bestScore = score; best = s; }
  });
  return bestScore >= 0.4 ? best : null;
}

// ---------- signal feed ----------
function addDetectedSignal({ id, source, raw, at }) {
  if (state.signals.some((s) => s.id === id)) return;

  // Sender-specific learning: muted sources get auto-ignored quietly.
  if (isSourceMuted(source)) {
    state.signals.unshift({
      id: id || "n" + Date.now(), sources: [source], rawTexts: [raw],
      title: parseFreeText(raw).title, due: null, time: null,
      urgency: "medium", urgencyTrigger: null, delegateTo: null,
      followUpTaskId: null, followUpTaskTitle: null, triggers: [],
      resolved: "ignored", autoMuted: true,
    });
    saveState();
    return;
  }

  // Plan limit: free/premium have a daily cap on automatic detections.
  if (!withinDetectionLimit()) { holdSignal({ id, source, raw, at }); return; }

  const parsed = parseFreeText(raw);
  const triggers = detectTaskSignals(raw);
  const urgency = detectUrgency(raw);
  let priorityReasons = [];
  if (hasFeature("priorityDetection")) {
    const sp = smartPriority(raw, parsed.due);
    urgency.level = sp.level;
    priorityReasons = sp.reasons;
  }
  const delegation = detectDelegation(raw);
  const followUpPhrase = detectFollowUp(raw);

  let followUpTaskId = null, followUpTaskTitle = null;
  if (followUpPhrase) {
    const match = findMatchingTask(raw);
    if (match) { followUpTaskId = match.id; followUpTaskTitle = match.title; triggers.push(followUpPhrase); }
  }

  let title = parsed.title;
  if (delegation) { title = `Follow up with ${delegation.name}`; triggers.push(delegation.trigger); }
  if (urgency.trigger) triggers.push(urgency.trigger);

  // Cross-source merging: does an existing pending signal from another
  // source already describe this same thing?
  const mergeTarget = findMergeCandidate(raw, source);
  if (mergeTarget) {
    mergeTarget.sources.push(source);
    mergeTarget.rawTexts.push(raw);
    mergeTarget.triggers = Array.from(new Set([...mergeTarget.triggers, ...triggers]));
    saveState();
    announceDetection(mergeTarget, true);
    return;
  }

  const signal = {
    id: id || "n" + Date.now(),
    sources: [source],
    rawTexts: [raw],
    title, due: parsed.due, time: parsed.time,
    urgency: urgency.level, urgencyTrigger: urgency.trigger,
    delegateTo: delegation ? delegation.name : null,
    followUpTaskId, followUpTaskTitle,
    triggers: Array.from(new Set(triggers)),
    priorityReasons, category: null, autoRule: null, receivedAt: at || Date.now(), remindBefore: 0,
    confidence: hasFeature("personalized") ? personalConfidence(triggers) : null,
    resolved: null,
  };

  // Personalized detection: quietly filter things that look like what you always ignore.
  if (signal.confidence !== null && signal.confidence <= PERSONAL_FILTER_THRESHOLD) {
    signal.resolved = "ignored";
    signal.autoRule = "Personalized filter";
    state.signals.unshift(signal);
    saveState();
    return;
  }

  state.signals.unshift(signal);
  countDetection();
  const handled = applyAutomations(signal);
  saveState();
  if (!handled) announceDetection(signal, false);
}

function announceDetection(signal, merged) {
  let summary = signal.smart ? signal.title : signal.followUpTaskTitle ? `Follow-up on "${signal.followUpTaskTitle}"` : signal.title;
  const sourceLabel = signal.sources.join(" + ");
  fireNotification((merged ? "Merged into existing signal — " : "Possible task detected — ") + sourceLabel, summary);
  showToast("📡 " + sourceLabel + (merged ? " (merged): " : ": ") + summary);
  emitEvent("signal.detected", { title: summary, sources: signal.sources });

  if (state.ttsEnabled && "speechSynthesis" in window) {
    let spoken = merged
      ? `${sourceLabel} both mentioned the same thing. Merged into one signal: ${summary}.`
      : `Possible task detected from ${sourceLabel}. ${summary}.`;
    if (signal.delegateTo) spoken += ` Assigned to ${signal.delegateTo}.`;
    if (signal.urgency === "high") spoken += " This sounds urgent.";
    speechSynthesis.speak(new SpeechSynthesisUtterance(spoken));
  }
}

function acceptSignal(id, opts = {}) {
  const sig = state.signals.find((s) => s.id === id);
  if (!sig) return;
  const primarySource = sig.sources.join(" + ");

  if (sig.followUpTaskId) {
    const task = state.tasks.find((t) => t.id === sig.followUpTaskId);
    if (task) { task.priority = bumpPriority(task.priority); task.reminder = true; task.notified = false; }
  } else {
    addTask({
      title: sig.title, due: sig.due, time: sig.time,
      priority: sig.urgency || "medium",
      category: signalCategory(sig),
      source: "detected", originSource: primarySource,
      reminder: !!sig.due, assignedTo: sig.delegateTo || null, remindBefore: sig.remindBefore || 0,
    });
  }
  sig.resolved = "added";
  if (!opts.auto) {
    sig.sources.forEach((s) => { getSourceStat(s).added++; });
    learnFromSignal(sig, 1);
  }
  saveState();
}

function ignoreSignal(id) {
  const sig = state.signals.find((s) => s.id === id);
  if (!sig) return;
  sig.resolved = "ignored";
  learnFromSignal(sig, -1);
  sig.sources.forEach((s) => {
    const stat = getSourceStat(s);
    stat.ignored++;
    // Feature: sender-specific learning — mute a source once it's been
    // ignored repeatedly and rarely acted on.
    if (!stat.muted && stat.ignored >= 3 && stat.ignored >= stat.added * 2) {
      stat.muted = true;
      showToast(`🔇 Nudge will quiet down "${s}" — you've ignored it ${stat.ignored} times.`);
    }
  });
  saveState();
}

function toggleTts(checked) { state.ttsEnabled = checked; saveState(); }
function showToast(message) {
  const root = document.getElementById("toast-root");
  if (!root) return;
  const el = document.createElement("div");
  el.className = "toast";
  el.textContent = message;
  root.appendChild(el);
  requestAnimationFrame(() => el.classList.add("show"));
  setTimeout(() => { el.classList.remove("show"); setTimeout(() => el.remove(), 300); }, 4500);
}

// ---------- view/filter switching ----------
function setView(view) {
  currentView = view;
  if (typeof toggleMenu === "function") toggleMenu(false);
  document.querySelectorAll(".nav-btn").forEach((b) => b.classList.toggle("active", b.dataset.view === view));
  document.querySelectorAll(".main > section").forEach((sec) => { sec.style.display = sec.id === "view-" + view ? "block" : "none"; });
  render();
}
function setFilter(filter) {
  currentFilter = filter; currentView = "tasks"; setView("tasks");
  document.querySelectorAll(".filter-btn").forEach((b) => b.classList.toggle("active", b.dataset.filter === filter));
}

// ---------- rendering ----------
function render() {
  const titleMap = { all: "All tasks", upcoming: "Upcoming", overdue: "Overdue", completed: "Completed" };
  document.getElementById("tasks-title").textContent = titleMap[currentFilter];

  const today = todayMidnight();
  const counts = { all: 0, upcoming: 0, overdue: 0, completed: 0 };
  state.tasks.forEach((t) => {
    if (t.status === "completed") counts.completed++;
    else if (t.due !== null && t.due < today) counts.overdue++;
    else counts.upcoming++;
  });
  counts.all = state.tasks.length;
  document.getElementById("count-all").textContent = state.tasks.length;
  document.getElementById("count-signals").textContent = state.signals.filter((s) => !s.resolved).length;
  document.getElementById("count-cats").textContent = state.categories.length;
  document.getElementById("f-all").textContent = counts.all;
  document.getElementById("f-upcoming").textContent = counts.upcoming;
  document.getElementById("f-overdue").textContent = counts.overdue;
  document.getElementById("f-completed").textContent = counts.completed;

  renderTasks(today);
  renderSignals();
  renderLearningPanel();
  renderInsights();
  renderCategories();
  renderPremium();
}

// Feature: task decay — vague, no-deadline tasks visually fade with age.
function decayOpacity(task) {
  if (task.due || task.status === "completed") return 1;
  const age = daysSince(task.createdAt || Date.now());
  if (age >= 21) return 0.4;
  if (age >= 10) return 0.6;
  if (age >= 4) return 0.8;
  return 1;
}

function renderTasks(today) {
  const list = document.getElementById("task-list");
  let tasks = state.tasks.filter((t) => {
    if (currentFilter === "completed") return t.status === "completed";
    if (t.status === "completed") return false;
    if (currentFilter === "overdue") return t.due !== null && t.due < today;
    if (currentFilter === "upcoming") return t.due === null || t.due >= today;
    return true;
  });
  tasks = tasks.slice().sort((a, b) => (a.due ?? Infinity) - (b.due ?? Infinity));

  if (tasks.length === 0) { list.innerHTML = `<div class="empty-state">Nothing here yet.</div>`; return; }

  list.innerHTML = tasks.map((task) => {
    const cat = state.categories.find((c) => c.name === task.category);
    const isOverdue = task.status !== "completed" && task.due !== null && task.due < today;
    const opacity = decayOpacity(task);
    const age = daysSince(task.createdAt || Date.now());
    return `
      <div class="task-card" style="opacity:${opacity}">
        <button class="checkbox ${task.status === "completed" ? "done" : ""}" onclick="toggleComplete('${task.id}')">
          ${task.status === "completed" ? "✓" : ""}
        </button>
        <div class="task-info">
          <div class="task-title ${task.status === "completed" ? "done" : ""}">
            ${escapeHtml(task.title)} ${task.source === "detected" ? '<span class="badge-detected">◎</span>' : ""}
          </div>
          <div class="task-meta">
            <span class="${isOverdue ? "overdue" : ""}">${fmtDate(task.due)}</span>
            ${task.time ? `<span>${task.time}</span>` : ""}
            ${cat ? `<span><span class="cat-dot" style="background:${cat.color}"></span> ${escapeHtml(cat.name)}</span>` : ""}
            ${task.reminder ? `<span title="Reminder on">🔔</span>` : ""}
            ${task.assignedTo ? `<span style="color:var(--purple)">→ ${escapeHtml(task.assignedTo)}</span>` : ""}
            ${!task.due && task.status !== "completed" && age >= 4 ? `<span title="No deadline — fading with age">🕓 idle ${age}d</span>` : ""}
          </div>
        </div>
        <div class="task-actions">
          ${calendarButton(task)}
          <button class="icon-btn" onclick="openEditModal('${task.id}')">✎</button>
          <button class="icon-btn danger" onclick="deleteTask('${task.id}')">🗑</button>
        </div>
      </div>
    `;
  }).join("");
}

// Feature: why-I-flagged-this — highlight trigger substrings inside the quoted raw text.
function highlightTriggers(raw, triggers) {
  let html = escapeHtml(raw);
  triggers
    .slice()
    .sort((a, b) => b.length - a.length)
    .forEach((trig) => {
      const escapedTrig = escapeHtml(trig);
      const re = new RegExp("(" + escapedTrig.replace(/[.*+?^${}()|[\]\\]/g, "\\$&") + ")", "ig");
      html = html.replace(re, "<mark class='trigger-hl'>$1</mark>");
    });
  return html;
}

function renderSignals() {
  const list = document.getElementById("signal-list");
  if (state.signals.length === 0) {
    list.innerHTML = `<div class="empty-state">Nothing detected yet. Tasks found in your messages will show up here.</div>`;
    return;
  }
  list.innerHTML = state.signals.map((sig) => {
    const urgencyColor = sig.urgency === "high" ? "var(--danger)" : sig.urgency === "low" ? "var(--text-faint)" : "var(--amber)";
    const displayTitle = sig.smart ? escapeHtml(sig.title) : sig.followUpTaskTitle ? `Follow-up on "${escapeHtml(sig.followUpTaskTitle)}"` : escapeHtml(sig.title);
    const sourceLabel = sig.sources.join(" + ");
    const mergedBadge = sig.sources.length > 1 ? `<span style="color:var(--success)">⚭ merged from ${sig.sources.length} sources</span>` : "";
    const whyFlagged = (!sig.resolved || sig.resolved === "added") && sig.triggers && sig.triggers.length
      ? `<details class="why-flagged">
           <summary>Why flagged?</summary>
           ${sig.triggers.map((t) => `<span class="trigger-chip">${escapeHtml(t)}</span>`).join("")}
         </details>`
      : "";
    const quotedTexts = sig.rawTexts.map((raw) => `"${highlightTriggers(raw, sig.triggers || [])}"`).join("<br/>");

    return `
    <div class="task-card" style="align-items:flex-start; flex-direction:column; gap:6px;">
      <div class="task-meta">
        <span>${escapeHtml(sourceLabel)}</span>
        ${sig.receivedAt ? `<span title="When it arrived">🕒 ${fmtClock(new Date(sig.receivedAt))}</span>` : ""}
        ${sig.autoMuted ? '<span style="color:var(--text-faint)">🔇 auto-ignored (muted source)</span>' :
          sig.resolved === "added" ? '<span style="color:var(--success)">Added to tasks</span>' :
          sig.resolved === "ignored" ? '<span>Ignored</span>' :
          '<span class="badge-detected">◎ Possible task detected</span>'}
        ${!sig.resolved ? `<span style="color:${urgencyColor}">● ${sig.urgency}</span>` : ""}
        ${mergedBadge}
        ${signalBadges(sig)}
      </div>
      <div style="font-size:12px; color:var(--text-muted); font-style:italic;">${quotedTexts}</div>
      <div style="font-size:14px;">${displayTitle}</div>
      <div class="task-meta">
        ${sig.due ? `<span>${fmtDate(sig.due)}</span>` : ""}
        ${sig.time ? `<span>${sig.time}</span>` : ""}
        ${sig.delegateTo ? `<span style="color:var(--purple)">→ ${escapeHtml(sig.delegateTo)}</span>` : ""}
      </div>
      ${whyFlagged}
      ${!sig.resolved ? `
        <div style="display:flex; gap:8px; align-self:flex-end;">
          <button class="btn-ghost" onclick="ignoreSignal('${sig.id}')">Ignore</button>
          <button class="btn-primary" onclick="acceptSignal('${sig.id}')">${sig.followUpTaskId ? "Bump priority" : "Add Task"}</button>
        </div>` : ""}
      ${sig.resolved === "ignored" && (sig.autoMuted || sig.autoRule) ? `<button class="btn-ghost btn-small" style="align-self:flex-end;" onclick="restoreSignal('${sig.id}')">Restore</button>` : ""}
    </div>
  `;
  }).join("");
}

// Feature: sender-specific learning panel
function renderLearningPanel() {
  const panel = document.getElementById("learning-panel");
  if (!panel) return;
  const entries = Object.entries(state.sourceStats).filter(([, stat]) => stat.ignored > 0 || stat.added > 0);
  if (entries.length === 0) {
    panel.innerHTML = "";
    return;
  }
  panel.innerHTML = entries.map(([source, stat]) => `
    <div class="source-pill ${stat.muted ? "muted" : ""}">
      <span>${stat.muted ? "🔇" : "📡"} ${escapeHtml(source)}</span>
      <span style="color:var(--text-faint)">${stat.added}✓ / ${stat.ignored}✗</span>
      ${stat.muted ? `<button onclick="unmuteSource('${source}')">Unmute</button>` : ""}
    </div>
  `).join("");
}

// Feature: Nudge Score insight panel
function renderInsights() {
  const list = document.getElementById("insight-list");
  if (!list) return;
  const bySource = {};
  state.tasks.forEach((t) => {
    const key = t.originSource || "Manual";
    if (!bySource[key]) bySource[key] = { total: 0, done: 0 };
    bySource[key].total++;
    if (t.status === "completed") bySource[key].done++;
  });
  const keys = Object.keys(bySource);
  if (keys.length === 0) { list.innerHTML = `<div class="empty-state">Add a few tasks to see your Nudge Score.</div>`; return; }

  list.innerHTML = keys.map((key) => {
    const { total, done } = bySource[key];
    const pct = total ? Math.round((done / total) * 100) : 0;
    return `
      <div class="insight-row">
        <div style="display:flex; justify-content:space-between; font-size:14px;">
          <span>${escapeHtml(key)}</span>
          <span style="color:var(--text-faint); font-family:'JetBrains Mono',monospace; font-size:12px;">${done}/${total} completed</span>
        </div>
        <div class="insight-bar-track"><div class="insight-bar-fill" style="width:${pct}%"></div></div>
        <div style="font-size:12px; color:var(--text-faint); margin-top:4px;">${pct}% follow-through</div>
      </div>
    `;
  }).join("");
}

function renderCategories() {
  const list = document.getElementById("category-list");
  if (state.categories.length === 0) { list.innerHTML = `<div class="empty-state">No categories yet.</div>`; return; }
  list.innerHTML = state.categories.map((cat) => {
    const count = state.tasks.filter((t) => t.category === cat.name && t.status !== "completed").length;
    return `
      <div class="task-card">
        <span class="cat-dot" style="background:${cat.color}"></span>
        <div class="task-info">${escapeHtml(cat.name)}</div>
        <span class="count">${count} active</span>
        <button class="icon-btn danger" onclick="deleteCategory('${cat.id}')">🗑</button>
      </div>
    `;
  }).join("");
}

function escapeHtml(str) {
  const div = document.createElement("div");
  div.textContent = str;
  return div.innerHTML;
}

// ---------- edit modal ----------
// ---------- edit task (fields fill themselves from the title) ----------
// A field is "touched" once you change it yourself (or it already had a value); touched fields are
// never overwritten. Everything else follows what you type in the title.
let editTouched = {};

function timeTo24(t) {
  const m = /(\d{1,2})(?::(\d{2}))?\s?(AM|PM)/i.exec(t || "");
  if (!m) return "";
  const h = (parseInt(m[1], 10) % 12) + (m[3].toUpperCase() === "PM" ? 12 : 0);
  return String(h).padStart(2, "0") + ":" + (m[2] || "00");
}
function setAutoTag(key, on) { const el = document.getElementById("auto-" + key); if (el) el.style.display = on ? "inline" : "none"; }
function markTouched(key) {
  editTouched[key] = true;
  setAutoTag(key, false);
  if (key === "due") syncReminderAuto();
}
function syncReminderAuto() {
  if (editTouched.reminder) return;
  const box = document.getElementById("m-reminder");
  box.checked = !!document.getElementById("m-date").value;
  setAutoTag("reminder", box.checked);
}
function autoFillFromTitle() {
  const text = document.getElementById("m-title").value;
  const parsed = parseFreeText(text, { next: true });
  if (!editTouched.due) {
    const v = parsed.due ? localDateKey(parsed.due) : "";
    document.getElementById("m-date").value = v; setAutoTag("due", !!v);
  }
  if (!editTouched.time) {
    const v = parsed.time ? timeTo24(parsed.time) : "";
    document.getElementById("m-time").value = v; setAutoTag("time", !!v);
  }
  if (!editTouched.priority) {
    const level = hasFeature("priorityDetection") ? smartPriority(text, parsed.due).level : detectUrgency(text).level;
    document.getElementById("m-priority").value = level; setAutoTag("priority", level !== "medium");
  }
  if (!editTouched.category) {
    const guess = guessCategory(text);
    if (guess) { document.getElementById("m-category").value = guess; setAutoTag("category", true); }
  }
  syncReminderAuto();
}

function openEditModal(id) {
  const task = state.tasks.find((t) => t.id === id);
  if (!task) return;
  const dueStr = task.due ? localDateKey(task.due) : "";
  const catOptions = state.categories.map((c) => `<option value="${escapeHtml(c.name)}" ${c.name === task.category ? "selected" : ""}>${escapeHtml(c.name)}</option>`).join("");
  editTouched = {
    due: !!task.due, time: !!task.time,
    priority: task.priority !== "medium",
    category: state.categories.length > 0 && task.category !== state.categories[0].name,
    reminder: !!task.reminder !== !!task.due,
  };
  const tag = (k) => `<span class="auto-tag" id="auto-${k}">auto</span>`;

  document.getElementById("modal-root").innerHTML = `
    <div class="modal-overlay" onclick="if(event.target===this) closeModal()">
      <div class="modal">
        <h2>Edit task</h2>
        <div class="field"><label>Title</label><input id="m-title" value="${escapeHtml(task.title)}" oninput="autoFillFromTitle()" placeholder="e.g. Submit report tomorrow at 10 AM" /></div>
        <div class="field"><label>Description</label><textarea id="m-desc" rows="2">${escapeHtml(task.description || "")}</textarea></div>
        <div class="row-2">
          <div class="field"><label>Due date ${tag("due")}</label><input id="m-date" type="date" value="${dueStr}" onchange="markTouched('due')" /></div>
          <div class="field"><label>Time ${tag("time")}</label><input id="m-time" type="time" value="${timeTo24(task.time)}" onchange="markTouched('time')" /></div>
        </div>
        <div class="row-2">
          <div class="field"><label>Priority ${tag("priority")}</label>
            <select id="m-priority" onchange="markTouched('priority')">
              <option value="high" ${task.priority === "high" ? "selected" : ""}>High</option>
              <option value="medium" ${task.priority === "medium" ? "selected" : ""}>Medium</option>
              <option value="low" ${task.priority === "low" ? "selected" : ""}>Low</option>
            </select>
          </div>
          <div class="field"><label>Category ${tag("category")}</label><select id="m-category" onchange="markTouched('category')">${catOptions}</select></div>
        </div>
        <div class="checkbox-row">
          <input type="checkbox" id="m-reminder" ${task.reminder ? "checked" : ""} onchange="markTouched('reminder')" />
          <label for="m-reminder">Send a real notification when this is due ${tag("reminder")}</label>
        </div>
        <div class="modal-actions">
          <button class="btn-ghost" onclick="closeModal()">Cancel</button>
          <button class="btn-primary" onclick="saveEditModal('${id}')">Save changes</button>
        </div>
      </div>
    </div>
  `;
  autoFillFromTitle();
}
function saveEditModal(id) {
  const dateVal = document.getElementById("m-date").value;
  const timeVal = document.getElementById("m-time").value;
  const before = state.tasks.find((t) => t.id === id);
  const newCategory = document.getElementById("m-category").value;
  if (before && before.category !== newCategory) learnCategory(before, newCategory);
  updateTask(id, {
    title: document.getElementById("m-title").value.trim() || "Untitled task",
    description: document.getElementById("m-desc").value,
    due: dateVal ? new Date(dateVal + "T00:00:00").getTime() : null,
    time: timeVal ? hhmmTo12(timeVal) : null,
    priority: document.getElementById("m-priority").value,
    category: newCategory,
    reminder: document.getElementById("m-reminder").checked,
    notified: false, warned: false,
  });
  clearWarn(id);
  closeModal();
}
function closeModal() { document.getElementById("modal-root").innerHTML = ""; }

// ---------- boot ----------
render();
const ttsToggle = document.getElementById("tts-toggle");
if (ttsToggle) ttsToggle.checked = state.ttsEnabled;
initNotifications();
initPremium();
