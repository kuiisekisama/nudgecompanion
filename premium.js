// ---------------------------------------------------------------------------
// Premium + Pro features. Everything here is gated through hasFeature() /
// requireFeature() from subscription.js. This file is loaded BEFORE app.js, so
// it only defines functions and constants; nothing touches `state` until the
// app calls into it.
// ---------------------------------------------------------------------------

// ---------- shared helpers ----------
function genId() {
  return (window.crypto && crypto.randomUUID) ? crypto.randomUUID() : "u" + Date.now().toString(36) + Math.random().toString(36).slice(2);
}
function escapeRegex(s) { return String(s).replace(/[.*+?^${}()|[\]\\]/g, "\\$&"); }
function escAttr(s) { return escapeHtml(s).replace(/"/g, "&quot;"); }
function pad2(n) { return String(n).padStart(2, "0"); }
function startOfDay(ms) { const d = new Date(ms); d.setHours(0, 0, 0, 0); return d.getTime(); }
function localDateKey(ms) { const d = new Date(ms); return d.getFullYear() + "-" + pad2(d.getMonth() + 1) + "-" + pad2(d.getDate()); }
function fmtClock(date) {
  let h = date.getHours();
  const ap = h >= 12 ? "PM" : "AM";
  h = h % 12 || 12;
  return h + ":" + pad2(date.getMinutes()) + " " + ap;
}
function persistOnly() { localStorage.setItem(STORE_KEY, JSON.stringify(state)); }
function isPlainObject(v) { return v && typeof v === "object" && !Array.isArray(v); }
function fillDefaults(target, defaults) {
  Object.keys(defaults).forEach((k) => {
    if (target[k] === undefined) target[k] = defaults[k];
    else if (isPlainObject(defaults[k]) && isPlainObject(target[k])) fillDefaults(target[k], defaults[k]);
  });
}

function defaultPremiumState() {
  return {
    sub: { plan: "free", userId: genId(), since: null, renewsAt: null, cancelAtPeriodEnd: false },
    usage: { date: "", detections: 0 },
    held: [],
    followUpsSent: {},
    automations: [],
    learning: { keywords: {}, sourceCategory: {} },
    ai: { endpoint: "" },
    relay: { url: "", token: "", enabled: false, all: false, lastSeq: 0, epoch: null, seen: [] },
    sync: { connected: false, auto: false, lastRemoteTime: 0, lastPushTime: 0, lastSyncedAt: null },
    integrations: {
      events: { created: true, completed: true, due: true, detected: false },
      webhook: { url: "", enabled: false },
      discord: { url: "", enabled: false },
      telegram: { token: "", chatId: "", enabled: false },
    },
    gmailClientId: "", gmailLastPoll: 0, gmailWasConnected: false,
    admin: { salt: "", hash: "" },
    localUpdatedAt: 0,
  };
}

// ===========================================================================
// MORE AUTOMATIC DETECTIONS (daily cap per plan)
// ===========================================================================
let limitToastShown = false;

function detectionLimit() { return DETECTION_LIMITS[currentPlan()]; }
function rolloverUsage() {
  const key = localDateKey(Date.now());
  if (state.usage.date !== key) state.usage = { date: key, detections: 0 };
}
function withinDetectionLimit() { rolloverUsage(); return state.usage.detections < detectionLimit(); }
function countDetection() { rolloverUsage(); state.usage.detections++; }

function holdSignal(item) {
  state.held.push(item);
  if (state.held.length > 100) state.held.shift();
  if (!limitToastShown) {
    limitToastShown = true;
    showToast(`Daily detection limit reached (${detectionLimit()}).` + (currentPlan() === "pro" ? "" : " Upgrade to keep detecting."));
  }
  saveState();
}
function releaseHeld() {
  let guard = 0;
  while (state.held.length && withinDetectionLimit() && guard++ < 200) addDetectedSignal(state.held.shift());
}

// How many new emails each Gmail check looks at grows with the plan.
function gmailMaxResults() { return { free: 10, premium: 25, pro: 50 }[currentPlan()]; }

// ===========================================================================
// SMART DEADLINE DETECTION
// ===========================================================================
const MONTH_RE = "(jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|june?|july?|aug(?:ust)?|sep(?:t(?:ember)?)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?)";
const MONTH_PREFIXES = ["jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec"];
const DAYPART_TIMES = { morning: "9:00 AM", noon: "12:00 PM", afternoon: "2:00 PM", evening: "6:00 PM", night: "8:00 PM", tonight: "8:00 PM" };

// Returns { due, time, eod, phrases } or null. `knownDate` means the caller
// already found a date (e.g. "tomorrow"), so a bare "morning" is meaningful.
function smartDeadline(text, knownDate) {
  const lower = text.toLowerCase();
  const today = todayMidnight();
  const now = new Date();
  const phrases = [];
  let due = null, time = null, eod = false, m;
  const daysToMonday = ((1 - now.getDay() + 7) % 7) || 7;

  if ((m = lower.match(/\bin (\d+|an?) ?(hours?|hrs?|minutes?|mins?)\b/))) {
    const n = /^\d+$/.test(m[1]) ? parseInt(m[1], 10) : 1;
    const t = new Date(Date.now() + n * (m[2][0] === "h" ? 3600000 : 60000));
    due = startOfDay(t.getTime()); time = fmtClock(t); phrases.push(m[0]);
  } else if ((m = lower.match(/\bin (\d+) ?(days?|weeks?)\b/))) {
    due = addDays(today, parseInt(m[1], 10) * (m[2][0] === "w" ? 7 : 1)); phrases.push(m[0]);
  } else if ((m = lower.match(new RegExp("\\bnext (" + DAYS.join("|") + ")\\b")))) {
    due = addDays(today, daysToMonday + ((DAYS.indexOf(m[1]) + 6) % 7)); phrases.push(m[0]);
  } else if ((m = lower.match(/\bnext week\b/))) {
    due = addDays(today, daysToMonday); phrases.push(m[0]);
  } else if ((m = lower.match(/\bnext month\b/))) {
    due = new Date(now.getFullYear(), now.getMonth() + 1, 1).getTime(); phrases.push(m[0]);
  } else if ((m = lower.match(/\b(end of (?:the )?month|eom)\b/))) {
    due = new Date(now.getFullYear(), now.getMonth() + 1, 0).getTime(); phrases.push(m[0]);
  } else if ((m = lower.match(/\b(end of (?:the )?week|eow)\b/))) {
    due = addDays(today, (5 - now.getDay() + 7) % 7); phrases.push(m[0]);
  } else if ((m = lower.match(new RegExp("\\b" + MONTH_RE + "\\.? (\\d{1,2})(?:st|nd|rd|th)?\\b")))) {
    due = resolveMonthDay(MONTH_PREFIXES.indexOf(m[1].slice(0, 3)), parseInt(m[2], 10)); phrases.push(m[0]);
  } else if ((m = lower.match(new RegExp("\\b(\\d{1,2})(?:st|nd|rd|th)? (?:of )?" + MONTH_RE + "\\b")))) {
    due = resolveMonthDay(MONTH_PREFIXES.indexOf(m[2].slice(0, 3)), parseInt(m[1], 10)); phrases.push(m[0]);
  } else if ((m = lower.match(/\b(?:by|on|before|until) (?:the )?(\d{1,2})(?:st|nd|rd|th)\b/))) {
    const day = parseInt(m[1], 10);
    if (day >= 1 && day <= 31) {
      let cand = new Date(now.getFullYear(), now.getMonth(), day).getTime();
      if (cand < today) cand = new Date(now.getFullYear(), now.getMonth() + 1, day).getTime();
      due = cand; phrases.push(m[0]);
    }
  }

  const hasClock = /\b\d{1,2}(:\d{2})?\s?(am|pm)\b/.test(lower);
  if (!hasClock) {
    if ((m = lower.match(/\b(this )?(morning|noon|afternoon|evening|night|tonight)\b/))) {
      time = DAYPART_TIMES[m[2]];
      phrases.push(m[0]);
      if (due === null && (m[1] || m[2] === "tonight")) due = todayMidnight();
    } else if ((m = lower.match(/\b(eod|end of (?:the )?day)\b/))) {
      time = "5:00 PM"; eod = true; phrases.push(m[0]);
    }
  }

  if (due === null && !eod && !(knownDate && time !== null)) return null;
  return { due, time, eod, phrases };
}
function resolveMonthDay(monthIdx, day) {
  if (monthIdx < 0 || day < 1 || day > 31) return null;
  const now = new Date();
  let y = now.getFullYear();
  let cand = new Date(y, monthIdx, day).getTime();
  if (cand < todayMidnight()) cand = new Date(y + 1, monthIdx, day).getTime();
  return cand;
}

// ===========================================================================
// PRIORITY DETECTION
// ===========================================================================
const PRIORITY_HIGH_WORDS = ["invoice", "payment", "deadline", "exam", "boss", "manager", "client", "contract", "legal", "tax", "overdue", "final", "important", "expires", "expiring", "interview"];
const PRIORITY_LOW_WORDS = ["maybe", "optional", "someday", "fyi", "nice to have", "when free", "if you can"];

function smartPriority(text, due) {
  const lower = text.toLowerCase();
  let score = 0;
  const reasons = [];
  const urg = detectUrgency(text);
  if (urg.level === "high") { score += 3; reasons.push(`urgent wording (“${urg.trigger}”)`); }
  else if (urg.level === "low") { score -= 2; reasons.push(`relaxed wording (“${urg.trigger}”)`); }

  const hi = PRIORITY_HIGH_WORDS.filter((w) => lower.includes(w));
  if (hi.length) { score += Math.min(hi.length, 2); reasons.push("important topic: " + hi.slice(0, 2).join(", ")); }
  const lo = PRIORITY_LOW_WORDS.filter((w) => lower.includes(w));
  if (lo.length) { score -= 1; reasons.push("optional wording: " + lo[0]); }

  if (/!{2,}/.test(text)) { score += 1; reasons.push("emphatic punctuation"); }
  if (/\b[A-Z]{4,}\b/.test(text.replace(/\bASAP\b/g, ""))) { score += 1; reasons.push("capitalised emphasis"); }

  if (due !== null && due !== undefined) {
    const days = Math.round((due - todayMidnight()) / DAY_MS);
    if (days < 0) { score += 2; reasons.push("already overdue"); }
    else if (days <= 1) { score += 2; reasons.push("due within a day"); }
    else if (days <= 3) { score += 1; reasons.push("due within 3 days"); }
  }
  return { level: score >= 3 ? "high" : score <= -1 ? "low" : "medium", score, reasons };
}

// ===========================================================================
// SMART FOLLOW-UPS
// ===========================================================================
function runSmartFollowUps() {
  if (!hasFeature("smartFollowUps")) return;
  const now = Date.now();
  const today = todayMidnight();
  let made = 0;
  state.tasks.forEach((t) => {
    if (made >= 3 || t.status !== "active") return;
    const candidates = [];
    if (t.assignedTo && now - t.createdAt >= DAY_MS) {
      const bucket = Math.floor((now - t.createdAt) / (2 * DAY_MS));
      candidates.push({ id: `fu-deleg-${t.id}-${bucket}`, text: `Check in with ${t.assignedTo} about “${t.title}”`, urgency: "medium", label: "delegated task still open" });
    }
    if (t.due !== null && t.due < today) {
      const late = Math.floor((today - t.due) / DAY_MS);
      candidates.push({ id: `fu-late-${t.id}-${Math.floor(late / 2)}`, text: `“${t.title}” is ${late} day${late > 1 ? "s" : ""} overdue. Finish it or reschedule?`, urgency: "high", label: "overdue task" });
    }
    candidates.forEach((c) => {
      if (made >= 3 || state.followUpsSent[c.id]) return;
      state.followUpsSent[c.id] = true;
      const sig = {
        id: c.id, sources: ["Nudge"], rawTexts: [c.text], title: c.text, due: null, time: null,
        urgency: c.urgency, urgencyTrigger: null, delegateTo: null,
        followUpTaskId: t.id, followUpTaskTitle: t.title, triggers: [c.label],
        priorityReasons: [], category: null, autoRule: null, confidence: null, smart: true, resolved: null,
      };
      state.signals.unshift(sig);
      made++;
      announceDetection(sig, false);
    });
  });
  if (made) saveState();
}

// ===========================================================================
// AI TASK EXTRACTION (+ Advanced AI for Pro)
// ===========================================================================
const ACTION_VERBS = ["send", "email", "call", "text", "message", "buy", "pay", "book", "schedule", "submit", "finish", "complete", "review", "prepare", "write", "draft", "update", "fix", "check", "order", "pick up", "renew", "cancel", "confirm", "follow up", "ask", "tell", "remind", "clean", "organize", "plan", "reply", "respond", "upload", "print", "sign", "register", "apply", "bring", "return", "set up", "arrange", "contact", "meet", "attend", "visit", "read", "study", "practice"];
const ACTION_START_RE = new RegExp("^(?:" + ACTION_VERBS.map(escapeRegex).join("|") + ")\\b", "i");
const REQUEST_RE = /\b(please|need to|needs to|have to|has to|must|should|remember to|don'?t forget|make sure|can you|could you|would you|let'?s|todo|to-do|action item)\b/i;
const HARD_DEADLINE_RE = /\b(due|deadline|submit|exam|meeting|appointment|renew|expires)\b/i;
const PLEASANTRY_RE = /^(?:thanks|thank you|thx|cheers|regards|best|sincerely|great|good|glad|sorry|hope|looking forward)\b/i;
const PAST_RE = /\b(yesterday|last (?:week|month|night)|went|was|were|had)\b/i;

function stripLeadIns(s) {
  let out = s.trim();
  out = out.replace(/^(?:hi|hey|hello|dear)\b[^,.:!?]{0,30}[,:]\s*/i, "");
  let prev;
  do {
    prev = out;
    out = out
      .replace(/^(?:also|and|then|so|ok|okay)[, ]+\s*/i, "")
      .replace(/^(?:please|kindly)[, ]+\s*/i, "")
      .replace(/^(?:can|could|would) you (?:please )?/i, "")
      .replace(/^(?:i|we|you) (?:need|have|want) to /i, "")
      .replace(/^(?:don'?t forget to|remember to|make sure (?:to|you))\s+/i, "")
      .replace(/^let'?s\s+/i, "");
  } while (out !== prev);
  return out.trim();
}

function guessCategory(text) {
  const lower = text.toLowerCase();
  const hints = {
    work: ["report", "meeting", "client", "invoice", "email", "project", "presentation", "review", "pull request", "deploy", "budget", "manager", "boss", "proposal"],
    school: ["exam", "homework", "assignment", "class", "quiz", "thesis", "study", "professor", "lecture", "essay", "school"],
    personal: ["groceries", "doctor", "dentist", "birthday", "gym", "mom", "dad", "family", "rent", "bill", "pay"],
  };
  for (const cat of state.categories) {
    const key = cat.name.toLowerCase();
    if (hints[key] && hints[key].some((h) => lower.includes(h))) return cat.name;
    if (key.length > 2 && lower.includes(key)) return cat.name;
  }
  return null;
}

function localExtractTasks(text) {
  const advanced = hasFeature("advancedAI");
  const pieces = [];
  text.split(/\n+/).forEach((line) => {
    const clean = line.replace(/^\s*(?:[-*•☐□]|\[\s?\]|\d+[.)])\s*/, "").trim();
    if (!clean) return;
    (clean.match(/[^.!?;]+[.!?;]?/g) || [clean]).forEach((sentence) => {
      const s = sentence.trim();
      if (s.length < 4) return;
      // "email Sam and book the venue" -> two tasks when both halves start with a verb.
      const parts = s.split(/\s+and\s+(?=(?:please\s+)?(?:will\s+)?[a-z])/i);
      if (parts.length > 1 && parts.every((p) => ACTION_START_RE.test(stripLeadIns(p)))) parts.forEach((p) => pieces.push(p));
      else pieces.push(s);
    });
  });

  const tasks = [];
  pieces.forEach((raw) => {
    const stripped = stripLeadIns(raw);
    if (PLEASANTRY_RE.test(stripped) || PAST_RE.test(raw)) return;
    const isAction = ACTION_START_RE.test(stripped) || REQUEST_RE.test(raw) || (detectTaskSignals(raw).length > 0 && HARD_DEADLINE_RE.test(raw));
    if (!isAction || stripped.length < 4) return;
    const parsed = parseFreeText(stripped, { next: true });
    const del = detectDelegation(stripped);
    const title = parsed.title.replace(/[?!]+$/, "").trim();
    tasks.push({
      title: title.charAt(0).toUpperCase() + title.slice(1),
      due: parsed.due, time: parsed.time,
      priority: smartPriority(raw, parsed.due).level,
      category: advanced ? guessCategory(raw) : null,
      assignedTo: del ? del.name : null,
      selected: true,
    });
  });
  return tasks;
}

function normalizeAiTask(t) {
  const ms = t.due ? Date.parse(String(t.due).length === 10 ? t.due + "T00:00:00" : t.due) : NaN;
  const names = state.categories.map((c) => c.name);
  return {
    title: String(t.title || "Untitled task").slice(0, 200),
    due: isNaN(ms) ? null : startOfDay(ms),
    time: /^\d{1,2}:\d{2}\s?(AM|PM)$/i.test(t.time || "") ? t.time.toUpperCase().replace(/\s?(AM|PM)/, " $1") : null,
    priority: ["high", "medium", "low"].includes(t.priority) ? t.priority : "medium",
    category: names.includes(t.category) ? t.category : null,
    assignedTo: t.assignedTo ? String(t.assignedTo).slice(0, 40) : null,
    selected: true,
  };
}

async function aiExtract(text) {
  const endpoint = state.ai.endpoint;
  if (hasFeature("advancedAI") && endpoint) {
    try {
      const res = await fetch(endpoint, {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ text, now: new Date().toISOString(), timezone: Intl.DateTimeFormat().resolvedOptions().timeZone, categories: state.categories.map((c) => c.name) }),
      });
      if (!res.ok) throw new Error("HTTP " + res.status);
      const data = await res.json();
      if (!Array.isArray(data.tasks)) throw new Error("Response has no tasks array");
      return { engine: "Advanced AI", tasks: data.tasks.map(normalizeAiTask) };
    } catch (e) {
      console.warn("Advanced AI endpoint failed", e);
      showToast("Your AI endpoint didn't answer. Used the built-in extractor instead.");
    }
  }
  return { engine: hasFeature("advancedAI") ? "Built-in AI (enhanced)" : "Built-in AI", tasks: localExtractTasks(text) };
}

let extractDraft = [];
function openExtractModal() {
  if (!requireFeature("aiExtraction")) return;
  extractDraft = [];
  document.getElementById("modal-root").innerHTML = `
    <div class="modal-overlay" onclick="if(event.target===this) closeModal()">
      <div class="modal" style="max-width:560px;">
        <h2>✨ Extract tasks</h2>
        <div class="field"><label>Paste an email, chat or notes</label>
          <textarea id="x-text" rows="6" placeholder="Hi team, please send the invoice to Acme by next Friday. Also book the venue for the 15th and ask Priya to review the slides tomorrow afternoon."></textarea>
        </div>
        <div id="x-results"></div>
        <div class="modal-actions">
          <button class="btn-ghost" onclick="closeModal()">Close</button>
          <button class="btn-primary" id="x-run" onclick="runExtraction()">Extract</button>
          <button class="btn-primary" id="x-add" style="display:none" onclick="addExtracted()">Add selected</button>
        </div>
      </div>
    </div>`;
  setTimeout(() => { const t = document.getElementById("x-text"); if (t) t.focus(); }, 0);
}
async function runExtraction() {
  const text = document.getElementById("x-text").value.trim();
  const out = document.getElementById("x-results");
  if (!text) { out.innerHTML = `<div class="demo-note">Paste some text first.</div>`; return; }
  const btn = document.getElementById("x-run");
  btn.disabled = true; btn.textContent = "Extracting…";
  const result = await aiExtract(text);
  btn.disabled = false; btn.textContent = "Extract again";
  extractDraft = result.tasks;
  renderExtractResults(result.engine);
}
function renderExtractResults(engine) {
  const out = document.getElementById("x-results");
  const addBtn = document.getElementById("x-add");
  if (!out) return;
  if (!extractDraft.length) {
    out.innerHTML = `<div class="demo-note">No tasks found. Try text with action words like “send”, “book” or “please review”.</div>`;
    addBtn.style.display = "none";
    return;
  }
  out.innerHTML = `
    <div class="subtitle" style="margin:8px 0;">${extractDraft.length} task${extractDraft.length > 1 ? "s" : ""} found · ${engine}</div>
    <div class="x-list">${extractDraft.map((t, i) => `
      <div class="x-row">
        <input type="checkbox" ${t.selected ? "checked" : ""} onchange="extractDraft[${i}].selected=this.checked" />
        <div style="flex:1; min-width:0;">
          <input class="x-title" value="${escAttr(t.title)}" oninput="extractDraft[${i}].title=this.value" />
          <div class="task-meta">
            <span>${fmtDate(t.due)}</span>${t.time ? `<span>${t.time}</span>` : ""}
            <span>● ${t.priority}</span>
            ${t.category ? `<span>${escapeHtml(t.category)}</span>` : ""}
            ${t.assignedTo ? `<span style="color:var(--purple)">→ ${escapeHtml(t.assignedTo)}</span>` : ""}
          </div>
        </div>
      </div>`).join("")}</div>`;
  addBtn.style.display = "inline-block";
}
function addExtracted() {
  const chosen = extractDraft.filter((t) => t.selected && t.title.trim());
  if (!chosen.length) { showToast("Pick at least one task to add."); return; }
  chosen.forEach((t) => {
    state.tasks.push({
      id: nextId(), title: t.title.trim(), description: "", due: t.due, time: t.time, priority: t.priority,
      category: t.category || state.categories[0]?.name || "Personal", status: "active",
      source: "detected", originSource: "AI extraction", reminder: !!t.due, notified: false,
      createdAt: Date.now(), assignedTo: t.assignedTo || null,
    });
    emitEvent("task.created", state.tasks[state.tasks.length - 1]);
  });
  closeModal();
  saveState();
  showToast(`Added ${chosen.length} task${chosen.length > 1 ? "s" : ""}.`);
}

// ===========================================================================
// CALENDAR INTEGRATION
// ===========================================================================
function nextDayMs(ms) { const d = new Date(ms); d.setDate(d.getDate() + 1); return d.getTime(); }
function taskEventTimes(task) {
  if (task.time) { const s = dueTimestamp(task); return { allDay: false, start: s, end: s + 30 * 60000 }; }
  return { allDay: true, start: task.due, end: nextDayMs(task.due) };
}
function icsUtc(ms) {
  const d = new Date(ms);
  return d.getUTCFullYear() + pad2(d.getUTCMonth() + 1) + pad2(d.getUTCDate()) + "T" + pad2(d.getUTCHours()) + pad2(d.getUTCMinutes()) + pad2(d.getUTCSeconds()) + "Z";
}
function icsLocalDate(ms) { const d = new Date(ms); return "" + d.getFullYear() + pad2(d.getMonth() + 1) + pad2(d.getDate()); }
function icsEscape(s) { return String(s || "").replace(/\\/g, "\\\\").replace(/;/g, "\\;").replace(/,/g, "\\,").replace(/\r?\n/g, "\\n"); }
function icsFold(line) {
  const out = [];
  while (line.length > 73) { out.push(line.slice(0, 73)); line = " " + line.slice(73); }
  out.push(line);
  return out.join("\r\n");
}
function buildIcs(tasks) {
  const lines = ["BEGIN:VCALENDAR", "VERSION:2.0", "PRODID:-//Nudge//Tasks//EN", "CALSCALE:GREGORIAN", "METHOD:PUBLISH"];
  tasks.forEach((t) => {
    if (t.due === null || t.due === undefined) return;
    const ev = taskEventTimes(t);
    lines.push("BEGIN:VEVENT", "UID:" + t.id + "@nudge.local", "DTSTAMP:" + icsUtc(Date.now()));
    if (ev.allDay) lines.push("DTSTART;VALUE=DATE:" + icsLocalDate(ev.start), "DTEND;VALUE=DATE:" + icsLocalDate(ev.end));
    else lines.push("DTSTART:" + icsUtc(ev.start), "DTEND:" + icsUtc(ev.end));
    lines.push("SUMMARY:" + icsEscape(t.title));
    if (t.description) lines.push("DESCRIPTION:" + icsEscape(t.description));
    lines.push("PRIORITY:" + (t.priority === "high" ? 1 : t.priority === "low" ? 9 : 5));
    if (!ev.allDay) lines.push("BEGIN:VALARM", "TRIGGER:-PT10M", "ACTION:DISPLAY", "DESCRIPTION:Reminder", "END:VALARM");
    lines.push("END:VEVENT");
  });
  lines.push("END:VCALENDAR");
  return lines.map(icsFold).join("\r\n") + "\r\n";
}
function downloadFile(name, text, mime) {
  const url = URL.createObjectURL(new Blob([text], { type: mime }));
  const a = document.createElement("a");
  a.href = url; a.download = name;
  document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
function exportIcs() {
  if (!requireFeature("calendar")) return;
  const tasks = state.tasks.filter((t) => t.status === "active" && t.due !== null);
  if (!tasks.length) { showToast("No dated tasks to export yet."); return; }
  downloadFile("nudge-tasks.ics", buildIcs(tasks), "text/calendar");
}
function downloadTaskIcs(id) {
  if (!requireFeature("calendar")) return;
  const t = state.tasks.find((x) => x.id === id);
  if (t && t.due !== null) downloadFile("nudge-task.ics", buildIcs([t]), "text/calendar");
}
function googleCalendarUrl(task) {
  const ev = taskEventTimes(task);
  const dates = ev.allDay ? icsLocalDate(ev.start) + "/" + icsLocalDate(ev.end) : icsUtc(ev.start) + "/" + icsUtc(ev.end);
  return "https://calendar.google.com/calendar/render?action=TEMPLATE&text=" + encodeURIComponent(task.title) +
    "&dates=" + dates + "&details=" + encodeURIComponent(task.description || "Added from Nudge");
}
function addToGoogleCalendar(id) {
  if (!requireFeature("calendar")) return;
  const t = state.tasks.find((x) => x.id === id);
  if (t && t.due !== null) window.open(googleCalendarUrl(t), "_blank", "noopener");
}
function calendarButton(task) {
  if (task.due === null || task.due === undefined || !hasFeature("calendar")) return "";
  return `<button class="icon-btn" title="Add to Google Calendar" onclick="addToGoogleCalendar('${task.id}')">📅</button>`;
}
let calMonth = null, calSelected = null;
function calInit() {
  if (calMonth !== null) return;
  const n = new Date();
  calMonth = new Date(n.getFullYear(), n.getMonth(), 1).getTime();
  calSelected = todayMidnight();
}
function calNav(delta) { calInit(); const d = new Date(calMonth); calMonth = new Date(d.getFullYear(), d.getMonth() + delta, 1).getTime(); renderCalendar(); }
function calToday() { calMonth = null; calInit(); renderCalendar(); }
function calSelect(ms) {
  calInit();
  calSelected = ms;
  const d = new Date(ms);
  calMonth = new Date(d.getFullYear(), d.getMonth(), 1).getTime();
  renderCalendar();
}
function calAddTask() {
  const input = document.getElementById("cal-add");
  const text = input ? input.value.trim() : "";
  if (!text) return;
  calInit();
  const parsed = parseFreeText(text);
  const due = parsed.hadDate ? parsed.due : calSelected;  // no date typed: use the day you picked
  const priority = hasFeature("priorityDetection") ? smartPriority(text, due).level : detectUrgency(text).level;
  addTask({ title: parsed.title || text, due, time: parsed.time, priority, category: guessCategory(text) || state.categories[0]?.name || "Personal", reminder: true, originSource: "Calendar" });
}

function renderCalendar() {
  const el = document.getElementById("calendar-body");
  if (!el) return;
  if (!hasFeature("calendar")) { el.innerHTML = lockCardHtml("calendar"); return; }
  calInit();
  const today = todayMidnight();
  const first = new Date(calMonth);
  const gridStart = new Date(first.getFullYear(), first.getMonth(), 1 - first.getDay());

  // tasks grouped by local calendar day
  const byDay = {};
  state.tasks.filter((t) => t.due !== null && t.due !== undefined).forEach((t) => { (byDay[localDateKey(t.due)] = byDay[localDateKey(t.due)] || []).push(t); });
  const dotClass = (t) => t.status === "completed" ? "done" : t.priority || "medium";

  let cells = "";
  for (let i = 0; i < 42; i++) {
    const d = new Date(gridStart.getFullYear(), gridStart.getMonth(), gridStart.getDate() + i);
    const ms = d.getTime(), key = localDateKey(ms);
    const list = byDay[key] || [];
    const dots = list.slice(0, 3).map((t) => `<span class="cal-dot ${dotClass(t)}"></span>`).join("") + (list.length > 3 ? `<span class="cal-more">+${list.length - 3}</span>` : "");
    const cls = ["cal-cell", d.getMonth() !== first.getMonth() ? "other" : "", key === localDateKey(today) ? "today" : "", key === localDateKey(calSelected) ? "selected" : ""].join(" ");
    cells += `<div class="${cls}" onclick="calSelect(${ms})" title="${list.length} task${list.length === 1 ? "" : "s"}"><div class="cal-num">${d.getDate()}</div><div class="cal-dots">${dots}</div></div>`;
  }

  const row = (t) => {
    const cat = state.categories.find((c) => c.name === t.category);
    const done = t.status === "completed";
    return `
      <div class="task-card" style="${done ? "opacity:0.55;" : ""}">
        <div class="cal-time font-mono">${t.time || "All day"}</div>
        <div class="task-info">
          <div class="task-title ${done ? "done" : ""}">${escapeHtml(t.title)}</div>
          <div class="task-meta">${cat ? `<span><span class="cat-dot" style="background:${cat.color}"></span> ${escapeHtml(cat.name)}</span>` : ""}<span>● ${t.priority}</span></div>
        </div>
        <div class="task-actions">
          <button class="icon-btn" title="Edit" onclick="openEditModal('${t.id}')">✎</button>
          <button class="btn-ghost btn-small" onclick="addToGoogleCalendar('${t.id}')">Google Calendar</button>
          <button class="btn-ghost btn-small" onclick="downloadTaskIcs('${t.id}')">.ics</button>
        </div>
      </div>`;
  };
  const dayList = (byDay[localDateKey(calSelected)] || []).slice().sort((a, b) => dueTimestamp(a) - dueTimestamp(b));
  const overdue = state.tasks.filter((t) => t.status === "active" && t.due !== null && t.due < today);
  const heading = new Date(calSelected).toLocaleDateString(undefined, { weekday: "long", month: "long", day: "numeric" });
  const rel = fmtDate(calSelected);

  el.innerHTML = `
    <div class="panel-head">
      <div class="cal-nav">
        <button class="btn-ghost btn-small" onclick="calNav(-1)" aria-label="Previous month">‹</button>
        <h2 class="font-display cal-title">${first.toLocaleDateString(undefined, { month: "long", year: "numeric" })}</h2>
        <button class="btn-ghost btn-small" onclick="calNav(1)" aria-label="Next month">›</button>
        <button class="btn-ghost btn-small" onclick="calToday()">Today</button>
      </div>
      <button class="btn-primary" onclick="exportIcs()">Export all (.ics)</button>
    </div>
    <div class="cal-grid">
      ${["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"].map((d) => `<div class="cal-dow">${d}</div>`).join("")}
      ${cells}
    </div>
    <div class="cal-legend"><span><i class="cal-dot high"></i> High</span><span><i class="cal-dot medium"></i> Medium</span><span><i class="cal-dot low"></i> Low</span><span><i class="cal-dot done"></i> Done</span></div>

    <div class="cal-day" style="margin-top:18px;">
      <div class="cal-day-head">${heading}${rel === "Today" || rel === "Tomorrow" || rel === "Yesterday" ? " · " + rel : ""}</div>
      <div class="quick-add" style="margin-bottom:10px;">
        <span>+</span>
        <input id="cal-add" placeholder="Add a task on this day, e.g. Call the bank at 3 PM" onkeydown="if(event.key==='Enter') calAddTask()" />
        <button onclick="calAddTask()">Add</button>
      </div>
      <div class="task-list">${dayList.map(row).join("") || `<div class="empty-state" style="padding:24px 12px;">Nothing on this day.</div>`}</div>
    </div>
    ${overdue.length ? `<div class="cal-day" style="margin-top:18px;"><div class="cal-day-head" style="color:var(--danger)">Overdue (${overdue.length})</div><div class="task-list">${overdue.map(row).join("")}</div></div>` : ""}`;
}

// ===========================================================================
// VOICE-TO-TASK
// ===========================================================================
let voiceRec = null, voiceListening = false;
function setVoiceBtn(on) {
  const b = document.getElementById("voice-btn");
  if (b) { b.classList.toggle("listening", on); b.textContent = on ? "⏺ Listening" : "🎙 Voice"; }
}
function startVoiceTask() {
  if (!requireFeature("voiceToTask")) return;
  const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
  if (!SR) { showToast("Voice input isn't supported in this browser. Try Chrome, Edge or Safari."); return; }
  if (voiceListening && voiceRec) { voiceRec.stop(); return; }
  const input = document.getElementById("quick-add-input");
  let finalText = "";
  voiceRec = new SR();
  voiceRec.lang = navigator.language || "en-US";
  voiceRec.interimResults = true;
  voiceRec.continuous = false;
  voiceRec.onstart = () => { voiceListening = true; setVoiceBtn(true); };
  voiceRec.onresult = (e) => {
    let interim = "";
    for (let i = e.resultIndex; i < e.results.length; i++) {
      const r = e.results[i];
      if (r.isFinal) finalText += r[0].transcript; else interim += r[0].transcript;
    }
    input.value = (finalText + interim).trim();
  };
  voiceRec.onerror = (e) => {
    if (e.error !== "no-speech" && e.error !== "aborted") showToast("Voice input error: " + e.error);
  };
  voiceRec.onend = () => {
    voiceListening = false; setVoiceBtn(false);
    const text = (finalText || input.value).trim();
    if (text) { input.value = text; quickAdd("Voice"); showToast("🎙 Added: " + text); }
  };
  voiceRec.start();
}

// ===========================================================================
// MULTIPLE INTEGRATIONS (webhook, Discord, Telegram)
// ===========================================================================
function dueText(t) { return t.due ? ` (due ${fmtDate(t.due)}${t.time ? " at " + t.time : ""})` : ""; }
function eventMessage(type, p) {
  if (type === "task.created") return `📌 New task: ${p.title}${dueText(p)}`;
  if (type === "task.completed") return `✅ Completed: ${p.title}`;
  if (type === "task.due") return `⏰ Due now: ${p.title}`;
  if (type === "signal.detected") return `📡 Possible task from ${(p.sources || []).join(" + ")}: ${p.title}`;
  return p.title || type;
}
function eventKey(type) { return { "task.created": "created", "task.completed": "completed", "task.due": "due", "signal.detected": "detected" }[type]; }

function sendWebhook(url, body) { return fetch(url, { method: "POST", mode: "no-cors", body: JSON.stringify(body) }); }
const DISCORD_URL_RE = /^https:\/\/(?:canary\.|ptb\.)?discord(?:app)?\.com\/api\/webhooks\/\d+\/[\w-]+/;
// Posts to a Discord channel. Resolves on success, throws a plain-English message otherwise.
async function sendDiscord(url, text) {
  const res = await fetch(url, {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ username: "Nudge", content: String(text).slice(0, 1900), allowed_mentions: { parse: [] } }),   // never ping @everyone
  });
  if (res.ok) return;
  if (res.status === 404) throw new Error("Discord can't find that webhook. It may have been deleted.");
  if (res.status === 429) throw new Error("Discord is slowing us down. Try again in a moment.");
  throw new Error("Discord answered " + res.status + ".");
}
let lastIntegrationError = 0;
function integrationFailed(name, e) {
  console.warn(name + " send failed", e);
  if (Date.now() - lastIntegrationError > 60000) { lastIntegrationError = Date.now(); showToast(name + ": " + (e && e.message ? e.message : "couldn't send")); }
}
function sendTelegram(tg, text) {
  return fetch(`https://api.telegram.org/bot${encodeURIComponent(tg.token)}/sendMessage`, {
    method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ chat_id: tg.chatId, text }),
  });
}
function dispatchToIntegrations(type, payload, message) {
  const ig = state.integrations;
  const jobs = [];
  if (ig.webhook.enabled && ig.webhook.url) {
    const data = payload.id ? { id: payload.id, title: payload.title, due: payload.due ? new Date(payload.due).toISOString() : null, time: payload.time || null, priority: payload.priority, category: payload.category, status: payload.status } : payload;
    jobs.push(sendWebhook(ig.webhook.url, { event: type, message, data, at: new Date().toISOString() }));
  }
  if (ig.discord.enabled && DISCORD_URL_RE.test(ig.discord.url)) jobs.push(sendDiscord(ig.discord.url, message).catch((e) => integrationFailed("Discord", e)));
  if (ig.telegram.enabled && ig.telegram.token && ig.telegram.chatId) jobs.push(sendTelegram(ig.telegram, message).catch((e) => integrationFailed("Telegram", e)));
  jobs.forEach((j) => j.catch((e) => console.warn("Integration send failed", e)));
  return jobs.length;
}
function emitEvent(type, payload) {
  if (!hasFeature("integrations")) return;
  const key = eventKey(type);
  if (!key || !state.integrations.events[key]) return;
  dispatchToIntegrations(type, payload, eventMessage(type, payload));
}
async function testIntegration(kind) {
  if (!requireFeature("integrations")) return;
  const ig = state.integrations[kind];
  const msg = "✅ Nudge test message. This works.";
  try {
    if (kind === "webhook") {
      if (!ig.url) { showToast("Paste the webhook link first."); return; }
      await sendWebhook(ig.url, { event: "test", message: msg, at: new Date().toISOString() });
      showToast("Sent. This kind of link can't confirm delivery, so check its run history.");
    } else if (kind === "discord") {
      if (!DISCORD_URL_RE.test(ig.url)) { showToast("Paste a Discord webhook link first (it starts with https://discord.com/api/webhooks/)."); return; }
      await sendDiscord(ig.url, msg);
      showToast("Sent! Check your Discord channel.");
    } else if (kind === "telegram") {
      if (!ig.token || !ig.chatId) { showToast("Fill in the bot token and chat ID first."); return; }
      const j = await (await sendTelegram(ig, msg)).json();
      showToast(j.ok ? "Sent! Check Telegram." : "Telegram said: " + (j.description || "error"));
    }
  } catch (e) { showToast("Couldn't send the test: " + (e.message || e)); }
}
function setDiscordUrl(value) {
  const v = value.trim();
  if (v && !DISCORD_URL_RE.test(v)) showToast("That doesn't look like a Discord webhook link. It starts with https://discord.com/api/webhooks/");
  state.integrations.discord.url = v;
  persistOnly(); renderPremium();
}
function setIntegration(kind, field, value) { state.integrations[kind][field] = value; persistOnly(); renderPremium(); }
function setIntegrationEvent(key, checked) { state.integrations.events[key] = checked; persistOnly(); }
function setAiEndpoint(v) { state.ai.endpoint = v.trim(); persistOnly(); }

// ===========================================================================
// CROSS-DEVICE SYNC (Google Drive + file export/import)
// ===========================================================================
const SYNC_FIELDS = ["tasks", "categories", "signals", "gmailProcessedIds", "ttsEnabled", "sourceStats", "automations", "learning", "held", "followUpsSent"];
let syncBusy = false;

function snapshot() {
  const out = {};
  SYNC_FIELDS.forEach((f) => { out[f] = JSON.parse(JSON.stringify(state[f])); });
  return out;
}
function applySnapshot(data) {
  SYNC_FIELDS.forEach((f) => { if (data[f] !== undefined) state[f] = data[f]; });
  fillDefaults(state, defaultPremiumState());
}
// ----- Google Drive sync: one JSON file in your own Drive's hidden app folder (no database, no server) -----
const DRIVE_SCOPE = "https://www.googleapis.com/auth/drive.appdata";
const DRIVE_FILE_NAME = "nudge-data.json";
let driveTokenClient = null, driveToken = null, driveTokenExpiresAt = 0;

function driveReady() { return !!driveToken && Date.now() < driveTokenExpiresAt; }

function initDrive() {
  if (driveTokenClient) return true;
  if (!gmailConfigured() || !window.google || !google.accounts || !google.accounts.oauth2) return false;
  driveTokenClient = google.accounts.oauth2.initTokenClient({
    client_id: gmailClientId(),
    scope: DRIVE_SCOPE,
    callback: onDriveToken,
    error_callback: (err) => {
      if (!err || err.type !== "popup_closed") showToast("Google sign-in was blocked or cancelled. Allow pop-ups and try again.");
    },
  });
  return true;
}

function connectDrive() {
  if (!requireFeature("sync")) return;
  if (!gmailConfigured()) { openGmailSetup(); return; }
  if (!initDrive()) { showToast("Google sign-in is still loading. Try again in a moment."); return; }
  driveTokenClient.requestAccessToken({ prompt: state.sync.connected ? "" : "select_account" });
}

function onDriveToken(resp) {
  if (resp.error) { showToast("Google said: " + (resp.error_description || resp.error)); return; }
  driveToken = resp.access_token;
  driveTokenExpiresAt = Date.now() + (Number(resp.expires_in) || 3600) * 1000 - 60000;
  state.sync.connected = true;
  persistOnly();
  renderPremium();
  syncNow(false);
}

function disconnectDrive() {
  if (driveToken && window.google && google.accounts && google.accounts.oauth2) google.accounts.oauth2.revoke(driveToken, () => {});
  driveToken = null;
  state.sync.connected = false;
  state.sync.auto = false;
  state.sync.lastRemoteTime = 0;
  persistOnly();
  renderPremium();
}

async function driveFetch(url, opts = {}) {
  const res = await fetch(url, { ...opts, headers: { Authorization: "Bearer " + driveToken, ...(opts.headers || {}) } });
  if (res.status === 401) { driveToken = null; throw new Error("Google sign-in expired. Tap Reconnect."); }
  if (res.status === 403) throw new Error("Google refused. Enable the Google Drive API in your Cloud project.");
  if (!res.ok) throw new Error("Google Drive answered " + res.status);
  return res;
}

// -> { id, updated_at, data } or null when nothing has been saved yet
async function driveRead() {
  const q = encodeURIComponent("name='" + DRIVE_FILE_NAME + "'");
  const list = await driveFetch(`https://www.googleapis.com/drive/v3/files?spaces=appDataFolder&q=${q}&fields=${encodeURIComponent("files(id,modifiedTime)")}`);
  const files = (await list.json()).files || [];
  if (!files.length) return null;
  const file = await driveFetch(`https://www.googleapis.com/drive/v3/files/${files[0].id}?alt=media`);
  return { id: files[0].id, updated_at: files[0].modifiedTime, data: await file.json() };
}

// Saves a snapshot; returns the file's new modified time (ISO string).
async function driveWrite(existingId) {
  const content = JSON.stringify(snapshot());
  let res;
  if (existingId) {
    res = await driveFetch(`https://www.googleapis.com/upload/drive/v3/files/${existingId}?uploadType=media&fields=id,modifiedTime`,
      { method: "PATCH", headers: { "Content-Type": "application/json" }, body: content });
  } else {
    const boundary = "nudge" + Date.now().toString(36);
    const body = `--${boundary}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n` +
      JSON.stringify({ name: DRIVE_FILE_NAME, parents: ["appDataFolder"] }) +
      `\r\n--${boundary}\r\nContent-Type: application/json\r\n\r\n${content}\r\n--${boundary}--`;
    res = await driveFetch("https://www.googleapis.com/upload/drive/v3/files?uploadType=multipart&fields=id,modifiedTime",
      { method: "POST", headers: { "Content-Type": "multipart/related; boundary=" + boundary }, body });
  }
  return (await res.json()).modifiedTime;
}

async function syncNow(silent) {
  if (!hasFeature("sync")) return;
  const s = state.sync;
  if (!driveReady()) {
    if (silent) return;
    if (s.connected) showToast("Reconnect Google to sync.");
    connectDrive();
    return;
  }
  if (syncBusy) return;
  syncBusy = true;
  try {
    const remote = await driveRead();
    const remoteTime = remote ? Date.parse(remote.updated_at) : 0;
    let action = "none";
    if (!remote) action = "push";
    else if (!s.lastRemoteTime) {
      if (silent) return; // never overwrite anything on a first sync without asking
      const choice = await askDialog("Nudge already saved data in this Google account. Which copy should win?", ["Cancel", "Use this device's data", "Use the Google Drive data"], { title: "First sync" });
      if (choice < 1) return;
      action = choice === 2 ? "pull" : "push";
    } else {
      const remoteChanged = remoteTime > s.lastRemoteTime;
      const localChanged = state.localUpdatedAt > s.lastPushTime;
      if (remoteChanged && !localChanged) action = "pull";
      else if (localChanged && !remoteChanged) action = "push";
      else if (remoteChanged && localChanged) {
        action = remoteTime > state.localUpdatedAt ? "pull" : "push";
        if (!silent) showToast("Both sides changed. Kept the newest version (" + (action === "pull" ? "Google Drive" : "this device") + ").");
      }
    }
    if (action === "push") {
      const modified = await driveWrite(remote ? remote.id : null);
      s.lastRemoteTime = Date.parse(modified) || Date.now();
      s.lastPushTime = Math.max(Date.now(), state.localUpdatedAt);
      s.lastSyncedAt = Date.now();
    } else if (action === "pull") {
      applySnapshot(remote.data);
      state.localUpdatedAt = Date.now();
      s.lastRemoteTime = remoteTime || Date.now();
      s.lastPushTime = state.localUpdatedAt;
      s.lastSyncedAt = Date.now();
    }
    persistOnly();
    if (action === "pull") render(); else renderPremium();
    if (!silent) showToast(action === "pull" ? "Synced: loaded from Google Drive." : action === "push" ? "Synced: saved to Google Drive." : "Already up to date.");
  } catch (e) {
    console.warn("Sync failed", e);
    if (!silent) showToast("Sync failed: " + e.message);
    renderPremium();
  } finally { syncBusy = false; }
}
function setSync(field, value) { state.sync[field] = value; persistOnly(); renderPremium(); }

function exportSyncFile() {
  if (!requireFeature("sync")) return;
  downloadFile("nudge-backup-" + localDateKey(Date.now()) + ".json", JSON.stringify({ app: "nudge", version: 2, exportedAt: new Date().toISOString(), data: snapshot() }, null, 2), "application/json");
}
function importSyncFile(input) {
  if (!requireFeature("sync")) return;
  const file = input.files && input.files[0];
  if (!file) return;
  const reader = new FileReader();
  reader.onload = async () => {
    try {
      const parsed = JSON.parse(reader.result);
      if (parsed.app !== "nudge" || !parsed.data || !Array.isArray(parsed.data.tasks)) throw new Error("Not a Nudge backup file");
      if (!(await confirmDialog(`This replaces the tasks on this device with the ${parsed.data.tasks.length} in the backup.`, "Replace", { title: "Restore backup?", danger: true }))) { input.value = ""; return; }
      applySnapshot(parsed.data);
      saveState();
      showToast("Backup imported.");
    } catch (e) { showToast("Couldn't import: " + e.message); }
    input.value = "";
  };
  reader.readAsText(file);
}

function renderIntegrations() {
  const el = document.getElementById("integrations-body");
  if (!el) return;
  if (!hasFeature("sync")) { el.innerHTML = lockCardHtml(["sync", "advancedAI", "integrations"]); return; }
  const s = state.sync, ig = state.integrations;
  const ev = ig.events;
  el.innerHTML = `
    <div class="panel">
      <h2 class="font-display">Cross-device sync</h2>
      <p class="panel-sub">Saves your tasks in a private spot in your own Google Drive that only Nudge can see. Sign in with the same Google account on each device.</p>
      <div class="panel-actions" style="margin-top:0;">
        ${s.connected && driveReady()
          ? `<button class="btn-primary" onclick="syncNow()">Sync now</button><button class="btn-ghost btn-small" onclick="disconnectDrive()">Disconnect</button>`
          : `<button class="btn-primary" onclick="connectDrive()">${s.connected ? "Reconnect Google" : "Connect Google Drive"}</button>${s.connected ? `<button class="btn-ghost btn-small" onclick="disconnectDrive()">Disconnect</button>` : ""}`}
        <span class="panel-note">${s.lastSyncedAt ? "Last synced " + new Date(s.lastSyncedAt).toLocaleTimeString() : "Not synced yet"}</span>
      </div>
      <label class="checkbox-row" style="margin-top:10px;"><input type="checkbox" ${s.auto ? "checked" : ""} ${s.connected ? "" : "disabled"} onchange="setSync('auto', this.checked)" /> Sync automatically every minute</label>
      <div class="divider" style="margin:14px 0;"></div>
      <div class="panel-actions" style="margin-top:0;">
        <button class="btn-ghost btn-small" onclick="exportSyncFile()">Download backup (.json)</button>
        <label class="btn-ghost btn-small" style="cursor:pointer;">Restore from backup<input type="file" accept="application/json" style="display:none" onchange="importSyncFile(this)" /></label>
      </div>
    </div>

    <div class="panel">
      <h2 class="font-display">Advanced AI</h2>
      <p class="panel-sub">Optional. Use your own AI server for “Extract tasks”.</p>
      <div class="field"><label>AI endpoint URL</label><input value="${escAttr(state.ai.endpoint)}" placeholder="http://localhost:8787/extract" onchange="setAiEndpoint(this.value)" /></div>
    </div>

    ${relayPanelHtml()}

    <div class="panel">
      <h2 class="font-display">Integrations</h2>
      <div class="ev-row">
        <label><input type="checkbox" ${ev.created ? "checked" : ""} onchange="setIntegrationEvent('created', this.checked)" /> Task added</label>
        <label><input type="checkbox" ${ev.completed ? "checked" : ""} onchange="setIntegrationEvent('completed', this.checked)" /> Task completed</label>
        <label><input type="checkbox" ${ev.due ? "checked" : ""} onchange="setIntegrationEvent('due', this.checked)" /> Task due</label>
        <label><input type="checkbox" ${ev.detected ? "checked" : ""} onchange="setIntegrationEvent('detected', this.checked)" /> Signal detected</label>
      </div>

      <div class="int-block">
        <div class="int-head"><strong>Webhook</strong> <span class="panel-note">Zapier, Make, n8n, IFTTT</span>
          <label class="int-toggle"><input type="checkbox" ${ig.webhook.enabled ? "checked" : ""} onchange="setIntegration('webhook','enabled', this.checked)" /> On</label></div>
        <div class="field"><input value="${escAttr(ig.webhook.url)}" placeholder="https://hooks.zapier.com/hooks/catch/…" onchange="setIntegration('webhook','url', this.value.trim())" /></div>
        <button class="btn-ghost btn-small" onclick="testIntegration('webhook')">Send test</button>
      </div>

      <div class="int-block">
        <div class="int-head"><strong>Discord</strong> <span class="panel-note">posts to a channel</span>
          <label class="int-toggle"><input type="checkbox" ${ig.discord.enabled ? "checked" : ""} onchange="setIntegration('discord','enabled', this.checked)" /> On</label></div>
        <div class="field"><input value="${escAttr(ig.discord.url)}" placeholder="https://discord.com/api/webhooks/…" onchange="setDiscordUrl(this.value)" /></div>
        <p class="panel-note" style="margin:0 0 8px;">Get the link in Discord: channel settings (⚙) &gt; Integrations &gt; Webhooks &gt; New Webhook &gt; Copy Webhook URL.</p>
        <button class="btn-ghost btn-small" onclick="testIntegration('discord')">Send test</button>
      </div>

      <div class="int-block">
        <div class="int-head"><strong>Telegram</strong> <span class="panel-note">bot token from @BotFather</span>
          <label class="int-toggle"><input type="checkbox" ${ig.telegram.enabled ? "checked" : ""} onchange="setIntegration('telegram','enabled', this.checked)" /> On</label></div>
        <div class="row-2">
          <div class="field"><input value="${escAttr(ig.telegram.token)}" placeholder="Bot token" onchange="setIntegration('telegram','token', this.value.trim())" /></div>
          <div class="field"><input value="${escAttr(ig.telegram.chatId)}" placeholder="Chat ID" onchange="setIntegration('telegram','chatId', this.value.trim())" /></div>
        </div>
        <button class="btn-ghost btn-small" onclick="testIntegration('telegram')">Send test</button>
      </div>
      <p class="panel-note" style="margin-top:10px;">Saved on this device only.</p>
    </div>`;
}

// ===========================================================================
// ADVANCED AUTOMATION (rules, including time of day)
// ===========================================================================
const RULE_FIELDS = { source: "Source contains", text: "Text contains", time: "Arrives between", priority: "Priority is", hasDue: "Has a due date", hasTime: "Has a time in it" };
const RULE_ACTIONS = {
  autoAdd: "Add it as a task automatically", setCategory: "Set the category", setPriority: "Set the priority",
  setDue: "Set the due date", setTime: "Set the due time", remindBefore: "Remind me ahead of time",
  ignore: "Ignore it quietly", forward: "Forward to my integrations",
};
const DUE_CHOICES = { "0": "today", "1": "tomorrow", "2": "in 2 days", "3": "in 3 days", "7": "in a week" };
const LEAD_CHOICES = { "5": "5 minutes", "10": "10 minutes", "15": "15 minutes", "30": "30 minutes", "60": "1 hour", "120": "2 hours", "1440": "1 day" };

function hhmmToMinutes(v) {
  const m = /^(\d{1,2}):(\d{2})$/.exec(v || "");
  return m ? parseInt(m[1], 10) * 60 + parseInt(m[2], 10) : null;
}
function hhmmTo12(v) {
  const m = hhmmToMinutes(v);
  if (m === null) return v;
  const h = Math.floor(m / 60);
  return (h % 12 || 12) + ":" + pad2(m % 60) + " " + (h >= 12 ? "PM" : "AM");
}

function ruleMatches(rule, sig) {
  const v = String(rule.when.value || "").toLowerCase();
  switch (rule.when.field) {
    case "source": return sig.sources.some((s) => s.toLowerCase().includes(v));
    case "text": return sig.rawTexts.join(" ").toLowerCase().includes(v);
    case "time": {
      const [from, to] = v.split("-");
      const a = hhmmToMinutes(from), b = hhmmToMinutes(to);
      if (a === null || b === null || a === b) return false;
      const d = new Date(sig.receivedAt || Date.now());
      const t = d.getHours() * 60 + d.getMinutes();
      return a < b ? (t >= a && t < b) : (t >= a || t < b); // a window like 22:00-07:00 crosses midnight
    }
    case "priority": return sig.urgency === v;
    case "hasDue": return v === "yes" ? !!sig.due : !sig.due;
    case "hasTime": return v === "yes" ? !!sig.time : !sig.time;
    default: return false;
  }
}

// Runs rules on a fresh signal. Returns true if a rule fully handled it (so no popup).
function applyAutomations(sig) {
  if (!hasFeature("automation")) return false;
  const rules = state.automations.filter((r) => r.enabled && ruleMatches(r, sig));
  rules.forEach((r) => {
    const t = r.then;
    if (t.action === "setPriority") { sig.urgency = t.value; r.hits++; }
    else if (t.action === "setCategory") { sig.category = t.value; r.hits++; }
    else if (t.action === "setDue") { sig.due = addDays(todayMidnight(), parseInt(t.value, 10)); r.hits++; }
    else if (t.action === "setTime") { sig.time = hhmmTo12(t.value); if (!sig.due) sig.due = todayMidnight(); r.hits++; }
    else if (t.action === "remindBefore") { sig.remindBefore = parseInt(t.value, 10); r.hits++; }
    else if (t.action === "forward") {
      r.hits++;
      dispatchToIntegrations("signal.detected", { title: sig.title, sources: sig.sources }, eventMessage("signal.detected", { title: sig.title, sources: sig.sources }));
    }
  });
  const terminal = rules.find((r) => r.then.action === "ignore" || r.then.action === "autoAdd");
  if (!terminal) return false;
  terminal.hits++;
  sig.autoRule = "Rule: " + terminal.name;
  if (terminal.then.action === "ignore") { sig.resolved = "ignored"; return true; }
  acceptSignal(sig.id, { auto: true });
  showToast("⚙ " + terminal.name + ": added “" + sig.title + "”");
  return true;
}

function describeRule(r) {
  const w = r.when, t = r.then;
  let when;
  if (w.field === "time") { const [a, b] = w.value.split("-"); when = `it arrives between ${hhmmTo12(a)} and ${hhmmTo12(b)}`; }
  else if (w.field === "hasDue") when = `it ${w.value === "yes" ? "has" : "has no"} due date`;
  else if (w.field === "hasTime") when = `it ${w.value === "yes" ? "has" : "has no"} time in it`;
  else if (w.field === "priority") when = `the priority is ${w.value}`;
  else when = `the ${w.field === "source" ? "source" : "text"} contains “${w.value}”`;
  const then = {
    autoAdd: "add it as a task automatically",
    setCategory: `set the category to ${t.value}`,
    setPriority: `set the priority to ${t.value}`,
    setDue: `set the due date to ${DUE_CHOICES[t.value]}`,
    setTime: `set the due time to ${hhmmTo12(t.value)}`,
    remindBefore: `remind me ${LEAD_CHOICES[t.value]} before`,
    ignore: "ignore it quietly",
    forward: "forward it to my integrations",
  }[t.action];
  return `When ${when}, ${then}`;
}

function updateRuleForm() {
  const field = document.getElementById("r-field").value;
  const action = document.getElementById("r-action").value;
  document.getElementById("r-value").placeholder = { source: "e.g. Messenger", text: "e.g. invoice", priority: "high, medium or low", hasDue: "yes or no", hasTime: "yes or no" }[field] || "";
  document.getElementById("r-value-wrap").style.display = field === "time" ? "none" : "block";
  document.getElementById("r-time-wrap").style.display = field === "time" ? "block" : "none";
  const wrap = document.getElementById("r-action-value-wrap");
  const sel = document.getElementById("r-action-value");
  const timeIn = document.getElementById("r-action-time");
  const label = document.getElementById("r-action-value-label");
  const options = (map) => Object.entries(map).map(([k, v]) => `<option value="${k}">${v}</option>`).join("");
  sel.style.display = "block"; timeIn.style.display = "none";
  if (action === "setCategory") { wrap.style.display = "block"; label.textContent = "Category"; sel.innerHTML = state.categories.map((c) => `<option>${escapeHtml(c.name)}</option>`).join(""); }
  else if (action === "setPriority") { wrap.style.display = "block"; label.textContent = "Priority"; sel.innerHTML = `<option>high</option><option>medium</option><option>low</option>`; }
  else if (action === "setDue") { wrap.style.display = "block"; label.textContent = "Due"; sel.innerHTML = options(DUE_CHOICES); }
  else if (action === "remindBefore") { wrap.style.display = "block"; label.textContent = "How early"; sel.innerHTML = options(LEAD_CHOICES); }
  else if (action === "setTime") { wrap.style.display = "block"; label.textContent = "Time"; sel.style.display = "none"; timeIn.style.display = "block"; }
  else wrap.style.display = "none";
}

function addAutomation() {
  const field = document.getElementById("r-field").value;
  const action = document.getElementById("r-action").value;
  let value;
  if (field === "time") {
    const from = document.getElementById("r-from").value, to = document.getElementById("r-to").value;
    if (!from || !to) { showToast("Pick both times."); return; }
    if (from === to) { showToast("The start and end times must differ."); return; }
    value = from + "-" + to;
  } else {
    value = document.getElementById("r-value").value.trim().toLowerCase();
    if (!value) { showToast("Enter a value for the condition."); return; }
    if (field === "priority" && !["high", "medium", "low"].includes(value)) { showToast("Priority must be high, medium or low."); return; }
    if ((field === "hasDue" || field === "hasTime") && !["yes", "no"].includes(value)) { showToast("Use yes or no."); return; }
  }
  let actionValue = null;
  if (action === "setTime") {
    actionValue = document.getElementById("r-action-time").value;
    if (!actionValue) { showToast("Pick a time."); return; }
  } else if (["setCategory", "setPriority", "setDue", "remindBefore"].includes(action)) {
    actionValue = document.getElementById("r-action-value").value || null;
    if (!actionValue) { showToast("Choose a value for the action."); return; }
  }
  const rule = { id: "r" + Date.now().toString(36), enabled: true, hits: 0, when: { field, value }, then: { action, value: actionValue } };
  rule.name = describeRule(rule).replace(/^When /, "").slice(0, 60);
  state.automations.push(rule);
  saveState();
}
function toggleAutomation(id, on) { const r = state.automations.find((x) => x.id === id); if (r) { r.enabled = on; saveState(); } }
function deleteAutomation(id) { state.automations = state.automations.filter((x) => x.id !== id); saveState(); }

function renderAutomations() {
  const el = document.getElementById("automations-body");
  if (!el) return;
  if (!hasFeature("automation")) { el.innerHTML = lockCardHtml("automation"); return; }
  const rules = state.automations.map((r) => `
    <div class="task-card">
      <input type="checkbox" ${r.enabled ? "checked" : ""} onchange="toggleAutomation('${r.id}', this.checked)" />
      <div class="task-info">
        <div class="task-title" style="${r.enabled ? "" : "color:var(--text-faint)"}">${escapeHtml(describeRule(r))}</div>
        <div class="task-meta"><span>${r.hits} time${r.hits === 1 ? "" : "s"} run</span></div>
      </div>
      <button class="icon-btn danger" onclick="deleteAutomation('${r.id}')">🗑</button>
    </div>`).join("");
  el.innerHTML = `
    <div class="panel">
      <h2 class="font-display">New rule</h2>
      <div class="row-2">
        <div class="field"><label>When</label>
          <select id="r-field" onchange="updateRuleForm()">${Object.entries(RULE_FIELDS).map(([k, v]) => `<option value="${k}">${v}</option>`).join("")}</select></div>
        <div class="field" id="r-value-wrap"><label>Value</label><input id="r-value" placeholder="e.g. Messenger" /></div>
        <div class="field" id="r-time-wrap" style="display:none;"><label>From and to</label>
          <div style="display:flex; gap:6px;"><input type="time" id="r-from" value="22:00" /><input type="time" id="r-to" value="07:00" /></div></div>
      </div>
      <div class="row-2">
        <div class="field"><label>Then</label>
          <select id="r-action" onchange="updateRuleForm()">${Object.entries(RULE_ACTIONS).map(([k, v]) => `<option value="${k}">${v}</option>`).join("")}</select></div>
        <div class="field" id="r-action-value-wrap" style="display:none;"><label id="r-action-value-label"></label>
          <select id="r-action-value"></select><input type="time" id="r-action-time" value="09:00" style="display:none;" /></div>
      </div>
      <button class="btn-primary" onclick="addAutomation()">Add rule</button>
    </div>
    <div class="task-list" style="margin-top:12px;">${rules || `<div class="empty-state">No rules yet. Try “arrives between 10:00 PM and 7:00 AM → ignore it quietly”.</div>`}</div>`;
  updateRuleForm();
}

// ===========================================================================
// PERSONALIZED TASK DETECTION
// ===========================================================================
const PERSONAL_FILTER_THRESHOLD = 15;

function learnFromSignal(sig, delta) {
  if (sig.smart) return;
  const kw = state.learning.keywords;
  (sig.triggers || []).forEach((t) => {
    const k = String(t).toLowerCase().trim();
    if (!k || k.length > 30) return;
    kw[k] = Math.max(-10, Math.min(10, (kw[k] || 0) + delta));
  });
}
function personalConfidence(triggers) {
  if (!triggers || !triggers.length) return 60;
  const kw = state.learning.keywords;
  const sum = triggers.reduce((a, t) => a + (kw[String(t).toLowerCase().trim()] || 0), 0);
  return Math.max(5, Math.min(99, Math.round(60 + (sum / triggers.length) * 10)));
}
function learnCategory(task, newCategory) {
  if (task.originSource) state.learning.sourceCategory[task.originSource] = newCategory;
}
function signalCategory(sig) {
  const names = state.categories.map((c) => c.name);
  if (sig.category && names.includes(sig.category)) return sig.category;
  if (hasFeature("personalized")) {
    const learned = state.learning.sourceCategory[sig.sources.join(" + ")];
    if (learned && names.includes(learned)) return learned;
  }
  return state.categories[0]?.name || "Personal";
}
function restoreSignal(id) {
  const sig = state.signals.find((s) => s.id === id);
  if (!sig) return;
  sig.resolved = null; sig.autoMuted = false; sig.autoRule = null;
  saveState();
}
async function resetLearning() {
  if (!(await confirmDialog("Nudge will stop filtering based on what you've accepted or ignored before.", "Reset", { title: "Reset learning?", danger: true }))) return;
  state.learning = { keywords: {}, sourceCategory: {} };
  saveState();
}
function signalBadges(sig) {
  const out = [];
  if (!sig.resolved && sig.confidence !== null && sig.confidence !== undefined) {
    const color = sig.confidence >= 70 ? "var(--success)" : sig.confidence >= 40 ? "var(--amber)" : "var(--danger)";
    out.push(`<span style="color:${color}" title="Based on which of these words you've acted on before">🎯 ${sig.confidence}% match</span>`);
  }
  if (!sig.resolved && sig.priorityReasons && sig.priorityReasons.length) {
    const more = sig.priorityReasons.length > 1 ? ` +${sig.priorityReasons.length - 1}` : "";
    out.push(`<span style="color:var(--blue)" title="${escAttr(sig.priorityReasons.join("; "))}">⚑ ${escapeHtml(sig.priorityReasons[0])}${more}</span>`);
  }
  if (sig.autoRule) out.push(`<span style="color:var(--purple)">⚙ ${escapeHtml(sig.autoRule)}</span>`);
  if (sig.smart) out.push(`<span style="color:var(--blue)">✦ smart follow-up</span>`);
  return out.join("");
}
function renderPersonalPanel() {
  const el = document.getElementById("personal-panel");
  if (!el) return;
  const entries = hasFeature("personalized") ? Object.entries(state.learning.keywords).filter(([, v]) => v !== 0).sort((a, b) => b[1] - a[1]) : [];
  if (!entries.length) { el.innerHTML = ""; return; }
  const pill = ([k, v]) => `<span class="source-pill" style="padding:3px 10px;"><span>${escapeHtml(k)}</span><span style="color:${v > 0 ? "var(--success)" : "var(--danger)"}">${v > 0 ? "+" : ""}${v}</span></span>`;
  el.innerHTML = `
    <div class="learning-panel">${entries.slice(0, 4).map(pill).join("")}${entries.slice(-3).filter((e) => e[1] < 0).map(pill).join("")}
      <button class="btn-ghost btn-small" onclick="resetLearning()" title="Forget what Nudge learned">Reset learning</button></div>`;
}

// ===========================================================================
// ADVANCED ANALYTICS
// ===========================================================================
function analyticsHtml() {
  const tasks = state.tasks;
  const today = todayMidnight();
  const done = tasks.filter((t) => t.status === "completed");
  const rate = tasks.length ? Math.round((done.length / tasks.length) * 100) : 0;
  const overdueOpen = tasks.filter((t) => t.status === "active" && t.due !== null && t.due < today).length;

  const timed = done.filter((t) => t.completedAt && t.createdAt);
  const avgDays = timed.length ? (timed.reduce((a, t) => a + (t.completedAt - t.createdAt) / DAY_MS, 0) / timed.length).toFixed(1) : null;

  const withDue = done.filter((t) => t.completedAt && t.due !== null);
  const onTime = withDue.length ? Math.round((withDue.filter((t) => t.completedAt < t.due + DAY_MS).length / withDue.length) * 100) : null;

  const doneDays = new Set(done.filter((t) => t.completedAt).map((t) => localDateKey(t.completedAt)));
  let streak = 0, cursor = today;
  if (!doneDays.has(localDateKey(cursor))) cursor = addDays(cursor, -1);
  while (doneDays.has(localDateKey(cursor))) { streak++; cursor = addDays(cursor, -1); }

  const weekdayCounts = [0, 0, 0, 0, 0, 0, 0];
  done.forEach((t) => { if (t.completedAt) weekdayCounts[new Date(t.completedAt).getDay()]++; });
  const bestIdx = weekdayCounts.indexOf(Math.max(...weekdayCounts));
  const bestDay = Math.max(...weekdayCounts) > 0 ? ["Sundays", "Mondays", "Tuesdays", "Wednesdays", "Thursdays", "Fridays", "Saturdays"][bestIdx] : null;

  const days = [];
  for (let i = 13; i >= 0; i--) {
    const d = addDays(today, -i), key = localDateKey(d);
    days.push({
      label: new Date(d).toLocaleDateString(undefined, { weekday: "narrow" }), key,
      created: tasks.filter((t) => t.createdAt && localDateKey(t.createdAt) === key).length,
      completed: done.filter((t) => t.completedAt && localDateKey(t.completedAt) === key).length,
    });
  }
  const maxBar = Math.max(1, ...days.map((d) => Math.max(d.created, d.completed)));

  const bars = (rows) => rows.map(([name, d, total]) => {
    const pct = total ? Math.round((d / total) * 100) : 0;
    return `<div class="insight-row" style="padding:10px 14px;">
      <div style="display:flex; justify-content:space-between; font-size:13px;"><span>${escapeHtml(name)}</span><span class="font-mono" style="color:var(--text-faint); font-size:12px;">${d}/${total} · ${pct}%</span></div>
      <div class="insight-bar-track" style="height:8px;"><div class="insight-bar-fill" style="width:${pct}%"></div></div></div>`;
  }).join("");
  const byCategory = state.categories.map((c) => { const all = tasks.filter((t) => t.category === c.name); return [c.name, all.filter((t) => t.status === "completed").length, all.length]; }).filter((r) => r[2] > 0);
  const byPriority = ["high", "medium", "low"].map((p) => { const all = tasks.filter((t) => t.priority === p); return [p[0].toUpperCase() + p.slice(1), all.filter((t) => t.status === "completed").length, all.length]; }).filter((r) => r[2] > 0);
  const bySignal = Object.entries(state.sourceStats).filter(([, s]) => s.added + s.ignored > 0).map(([src, s]) => [src, s.added, s.added + s.ignored]);

  const kpi = (value, label) => `<div class="kpi"><div class="kpi-value font-display">${value}</div><div class="kpi-label">${label}</div></div>`;
  return `
    <div class="kpi-grid">
      ${kpi(rate + "%", "Completion rate")}
      ${kpi(streak + (streak === 1 ? " day" : " days"), "Current streak")}
      ${kpi(onTime === null ? "–" : onTime + "%", "Finished on time")}
      ${kpi(avgDays === null ? "–" : avgDays + "d", "Avg. time to finish")}
      ${kpi(overdueOpen, "Overdue now")}
      ${kpi(bestDay || "–", "Most productive day")}
    </div>
    <div class="panel">
      <h2 class="font-display">Last 14 days</h2>
      <div class="day-chart">${days.map((d) => `
        <div class="day-col" title="${d.key}: ${d.created} added, ${d.completed} completed">
          <div class="day-bars"><div class="bar-added" style="height:${(d.created / maxBar) * 100}%"></div><div class="bar-done" style="height:${(d.completed / maxBar) * 100}%"></div></div>
          <div class="day-label">${d.label}</div>
        </div>`).join("")}</div>
      <div class="chart-legend"><span><i class="lg lg-added"></i> Added</span><span><i class="lg lg-done"></i> Completed</span></div>
    </div>
    ${byCategory.length ? `<h3 class="sub-h">By category</h3><div class="insight-list">${bars(byCategory)}</div>` : ""}
    ${byPriority.length ? `<h3 class="sub-h">By priority</h3><div class="insight-list">${bars(byPriority)}</div>` : ""}
    ${bySignal.length ? `<h3 class="sub-h">Detection sources: how often you act on them</h3><div class="insight-list">${bars(bySignal)}</div>` : ""}`;
}

// ===========================================================================
// ADMIN: Analytics lives here, behind a PIN
// ===========================================================================
// This keeps Analytics out of everyone's menu. The PIN is saved as a salted hash, not as typed. It is a
// lock for casual use on this device only: anyone who can open the browser's developer tools can get past it.
// Optional: set adminEmail in config.js (your Google email). Then Admin only opens while Nudge is connected to Gmail as that account,
// so a copy of the app on someone else's phone can't be unlocked just by choosing a PIN.
let ADMIN_EMAIL = (typeof NUDGE_CONFIG !== "undefined" && NUDGE_CONFIG.adminEmail) || "";
let adminUnlocked = false, adminFails = 0, adminLockedUntil = 0;
function isAdminOwner() { return !ADMIN_EMAIL || (state.gmailEmail || "").toLowerCase() === ADMIN_EMAIL.toLowerCase(); }

async function hashPin(pin, salt) {
  const data = new TextEncoder().encode(salt + ":" + pin);
  if (window.crypto && crypto.subtle) {
    const buf = await crypto.subtle.digest("SHA-256", data);
    return Array.from(new Uint8Array(buf), (b) => b.toString(16).padStart(2, "0")).join("");
  }
  let h = 2166136261;                                  // fallback when the page isn't a secure context
  for (const b of data) { h ^= b; h = Math.imul(h, 16777619); }
  return "f" + (h >>> 0).toString(16);
}
const adminField = (id) => (document.getElementById(id) || { value: "" }).value;

async function adminSetPin() {
  const a = adminField("admin-pin-new"), b = adminField("admin-pin-confirm");
  if (!/^\d{4,8}$/.test(a)) { showToast("Use 4 to 8 digits."); return; }
  if (a !== b) { showToast("The two PINs don't match."); return; }
  const salt = genId();
  state.admin = { salt, hash: await hashPin(a, salt) };
  adminUnlocked = true;
  saveState();
  showToast("Admin PIN saved.");
}
async function adminUnlock() {
  if (Date.now() < adminLockedUntil) { showToast("Too many tries. Wait a few seconds."); return; }
  const ok = (await hashPin(adminField("admin-pin"), state.admin.salt)) === state.admin.hash;
  if (ok) { adminUnlocked = true; adminFails = 0; renderPremium(); return; }
  if (++adminFails >= 5) { adminFails = 0; adminLockedUntil = Date.now() + 30000; showToast("Too many tries. Locked for 30 seconds."); }
  else showToast("Wrong PIN.");
}
function adminLock() { adminUnlocked = false; renderPremium(); }

function renderAdmin() {
  const el = document.getElementById("admin-body");
  if (!el) return;
  if (!isAdminOwner()) {
    el.innerHTML = `<div class="panel" style="max-width:420px;"><h2 class="font-display">Owner only</h2><p class="panel-sub" style="margin:0;">Connect Gmail with the owner's Google account to open this.</p></div>`;
    return;
  }
  const pinFields = (label) => `
      <div class="row-2">
        <div class="field"><label>${label}</label><input id="admin-pin-new" type="password" inputmode="numeric" maxlength="8" placeholder="4 to 8 digits" /></div>
        <div class="field"><label>Repeat it</label><input id="admin-pin-confirm" type="password" inputmode="numeric" maxlength="8" onkeydown="if(event.key==='Enter') adminSetPin()" /></div>
      </div>`;
  if (!state.admin || !state.admin.hash) {
    el.innerHTML = `
      <div class="panel" style="max-width:480px;">
        <h2 class="font-display">Set an admin PIN</h2>
        <p class="panel-sub">Analytics is only for the admin. Choose a PIN to lock this area.</p>
        ${pinFields("New PIN")}
        <button class="btn-primary" onclick="adminSetPin()">Save PIN</button>
      </div>`;
    return;
  }
  if (!adminUnlocked) {
    el.innerHTML = `
      <div class="panel" style="max-width:420px;">
        <h2 class="font-display">🔒 Admin</h2>
        <div class="field"><label>PIN</label><input id="admin-pin" type="password" inputmode="numeric" maxlength="8" onkeydown="if(event.key==='Enter') adminUnlock()" /></div>
        <button class="btn-primary" onclick="adminUnlock()">Unlock</button>
      </div>`;
    return;
  }
  el.innerHTML = `
    <div class="panel-head"><h2 class="font-display" style="margin:0; font-size:18px;">Analytics</h2><button class="btn-ghost btn-small" onclick="adminLock()">Lock</button></div>
    ${analyticsHtml()}
    <details class="panel" style="margin-top:14px;"><summary style="cursor:pointer; font-size:13px;">Change PIN</summary>
      <div style="margin-top:12px;">${pinFields("New PIN")}<button class="btn-ghost btn-small" onclick="adminSetPin()">Change PIN</button></div>
    </details>`;
}

// ===========================================================================
// SHARED UI: plan banner, nav locks, render hook, boot
// ===========================================================================
function renderPlanBanner() {
  const el = document.getElementById("plan-banner");
  if (!el) return;
  const limit = detectionLimit();
  rolloverUsage();
  const parts = [];
  if (limit !== Infinity) parts.push(`Detections today: <strong>${Math.min(state.usage.detections, limit)} of ${limit}</strong>`);
  if (state.held.length) parts.push(`<strong>${state.held.length}</strong> waiting${currentPlan() === "pro" ? "" : " until you upgrade or tomorrow"}`);
  if (!parts.length) { el.innerHTML = ""; return; }
  const upsell = currentPlan() === "pro" ? "" : `<button class="btn-primary btn-small" onclick="setView('plans')">Get more</button>`;
  el.innerHTML = `<div class="plan-banner">${parts.join(" · ")} ${upsell}</div>`;
}
function updateNavLocks() {
  const map = { calendar: "calendar", automations: "automation", integrations: "sync" };
  Object.entries(map).forEach(([view, feat]) => {
    const el = document.getElementById("lock-" + view);
    if (el) el.textContent = hasFeature(feat) ? "" : "🔒";
  });
  const ic = document.getElementById("install-chip");
  if (ic) ic.textContent = (typeof isStandalone === "function" && isStandalone()) ? "✓" : "";
  const chip = document.getElementById("plan-chip");
  if (chip) chip.textContent = PLANS[currentPlan()].name;
  const v = document.getElementById("voice-btn");
  if (v && !voiceListening) v.textContent = (hasFeature("voiceToTask") ? "" : "🔒 ") + "🎙 Voice";
  const x = document.getElementById("extract-btn");
  if (x) x.textContent = (hasFeature("aiExtraction") ? "" : "🔒 ") + "✨ Extract";
}
function isEditingIn(sectionId) {
  const a = document.activeElement, sec = document.getElementById(sectionId);
  return !!(a && sec && sec.contains(a) && /^(INPUT|TEXTAREA|SELECT)$/.test(a.tagName));
}
function renderPremium() {
  renderPlanBox();
  updateNavLocks();
  renderPlanBanner();
  renderPersonalPanel();
  const views = { install: renderInstall, plans: renderPlans, calendar: renderCalendar, admin: renderAdmin, automations: renderAutomations, integrations: renderIntegrations };
  const fn = views[currentView];
  if (fn && !isEditingIn("view-" + currentView)) fn();
}

let lastAutoSync = 0;
function onReminderTick() {
  checkSubscription();
  rolloverUsage();
  if (state.held.length && withinDetectionLimit()) releaseHeld();
  runSmartFollowUps();
  if (hasFeature("sync") && state.sync.auto && driveReady() && state.sync.lastRemoteTime && Date.now() - lastAutoSync > 60000) {
    lastAutoSync = Date.now();
    syncNow(true);
  }
}
function initPremium() {
  if (typeof initMenu === "function") initMenu();
  const ver = document.getElementById("app-version");
  if (ver) ver.textContent = "Nudge " + APP_VERSION;
  checkSubscription();
  renderPremium();
  document.addEventListener("visibilitychange", () => {
    if (!document.hidden && hasFeature("sync") && state.sync.auto && driveReady() && state.sync.lastRemoteTime) syncNow(true);
  });
}
