

const http = require("http");

const PORT = process.env.PORT || 8787;
const ALLOWED_ORIGIN = process.env.ALLOWED_ORIGIN || "http://localhost:8000";
const MODEL = process.env.NUDGE_MODEL || "claude-sonnet-5-5";

const SYSTEM = `You extract actionable tasks from text a person pasted (emails, chats, notes).
Reply with JSON only, no prose and no code fences, in exactly this shape:
{"tasks":[{"title":string,"due":"YYYY-MM-DD"|null,"time":"h:mm AM"|"h:mm PM"|null,"priority":"high"|"medium"|"low","category":string|null,"assignedTo":string|null}]}
Rules: one task per distinct action; imperative titles under 80 characters; resolve relative dates
("next Friday", "end of the month") using the current date and timezone given; use a category only
if it is in the list provided, otherwise null; set assignedTo only when someone else is asked to do it;
ignore pleasantries and things that already happened.`;

function readBody(req) {
  return new Promise((resolve, reject) => {
    let data = "";
    req.on("data", (c) => { data += c; if (data.length > 50000) { reject(new Error("Body too large")); req.destroy(); } });
    req.on("end", () => resolve(data));
    req.on("error", reject);
  });
}

http.createServer(async (req, res) => {
  res.setHeader("Access-Control-Allow-Origin", ALLOWED_ORIGIN);
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
  if (req.method === "OPTIONS") { res.writeHead(204); return res.end(); }
  if (req.method !== "POST") { res.writeHead(405); return res.end(); }

  try {
    const { text, now, timezone, categories } = JSON.parse(await readBody(req));
    if (!text || typeof text !== "string") throw new Error("Missing text");

    const apiRes = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: { "x-api-key": process.env.ANTHROPIC_API_KEY, "anthropic-version": "2023-06-01", "content-type": "application/json" },
      body: JSON.stringify({
        model: MODEL, max_tokens: 1000, system: SYSTEM,
        messages: [{ role: "user", content: `Current date/time: ${now} (${timezone})\nCategories: ${(categories || []).join(", ") || "none"}\n\nText:\n${text.slice(0, 8000)}` }],
      }),
    });
    if (!apiRes.ok) throw new Error("Anthropic API error " + apiRes.status);
    const data = await apiRes.json();
    const raw = (data.content || []).map((b) => b.text || "").join("").replace(/```json|```/g, "").trim();
    const parsed = JSON.parse(raw);

    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ tasks: Array.isArray(parsed.tasks) ? parsed.tasks : [] }));
  } catch (e) {
    console.error(e.message);
    res.writeHead(500, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: "Extraction failed" }));
  }
}).listen(PORT, () => console.log("Nudge AI proxy on http://localhost:" + PORT + "/extract"));
