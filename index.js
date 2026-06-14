import express from "express";
import fetch from "node-fetch";

const app = express();
app.use(express.json());
app.use((req, res, next) => {
  res.header('Access-Control-Allow-Origin', '*');
  res.header('Access-Control-Allow-Headers', 'Content-Type, x-api-key');
  res.header('Access-Control-Allow-Methods', 'GET, POST, PATCH, OPTIONS');
  if (req.method === 'OPTIONS') return res.sendStatus(200);
  next();
});

const TELEGRAM_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const ANTHROPIC_KEY = process.env.ANTHROPIC_API_KEY;
const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_KEY = process.env.SUPABASE_KEY;
const API_KEY = process.env.DASHBOARD_API_KEY || "reachout123";

// ── Supabase helpers ──────────────────────────────────────────────────────────

async function supabase(method, path, body) {
  const res = await fetch(`${SUPABASE_URL}/rest/v1/${path}`, {
    method,
    headers: {
      apikey: SUPABASE_KEY,
      Authorization: `Bearer ${SUPABASE_KEY}`,
      "Content-Type": "application/json",
      Prefer: method === "POST" ? "return=representation" : "",
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  return res.json();
}

async function upsertConversation(chatId, username) {
  await supabase("POST", "conversations?on_conflict=chat_id", {
    chat_id: chatId,
    username,
    started_at: new Date().toISOString(),
  });
}

async function saveMessage(chatId, role, content) {
  await supabase("POST", "messages", { chat_id: chatId, role, content });
  await supabase("PATCH", `conversations?chat_id=eq.${chatId}`, {
    last_message: content,
    last_message_time: new Date().toISOString(),
    message_count: 99, // Supabase will handle real count via trigger if you add one
  });
}

async function getMessages(chatId) {
  const rows = await supabase("GET",
    `messages?chat_id=eq.${chatId}&order=created_at.asc`);
  return Array.isArray(rows) ? rows : [];
}

// ── Telegram helper ───────────────────────────────────────────────────────────

async function sendTelegram(chatId, text) {
  await fetch(`https://api.telegram.org/bot${TELEGRAM_TOKEN}/sendMessage`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ chat_id: chatId, text, parse_mode: "Markdown" }),
  });
}

// ── Claude AI helpers ─────────────────────────────────────────────────────────

async function callClaude(system, messages) {
  const res = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "x-api-key": ANTHROPIC_KEY,
      "anthropic-version": "2023-06-01",
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      model: "claude-haiku-4-5",
      max_tokens: 300,
      system,
      messages,
    }),
  });
  const data = await res.json();
  console.log("Claude response:", JSON.stringify(data));
  return data?.content?.[0]?.text || "I'm here with you.";
}

async function generateSummary(chatId) {
  const msgs = await getMessages(chatId);
  if (msgs.length < 2) return;

  const transcript = msgs
    .map(m => `${m.role === "user" ? "Youth" : "Bot"}: ${m.content}`)
    .join("\n");

  const summary = await callClaude(
    `You are a clinical summariser for youth social workers. 
Read this conversation and reply ONLY with valid JSON — no markdown, no explanation:
{
  "risk_level": "low" | "medium" | "high",
  "summary": "2 sentence summary of what the youth shared",
  "suggested_action": "one clear action the worker should take tomorrow",
  "crisis": true | false
}`,
    [{ role: "user", content: transcript }]
  );

  try {
    const parsed = JSON.parse(summary);
    await supabase("PATCH", `conversations?chat_id=eq.${chatId}`, {
      risk_level: parsed.risk_level,
      summary: parsed.summary,
      suggested_action: parsed.suggested_action,
      crisis: parsed.crisis,
    });
  } catch (e) {
    console.error("Summary parse failed:", e);
  }
}

// ── Webhook — receives messages from Telegram ─────────────────────────────────

app.post("/webhook", async (req, res) => {
  res.sendStatus(200);
  const msg = req.body?.message;
  if (!msg?.text) return;

  const chatId = msg.chat.id;
  const username = msg.from?.username || msg.from?.first_name || "Youth";
  const text = msg.text;

  // Save the incoming message
  await upsertConversation(chatId, username);
  await saveMessage(chatId, "user", text);

  // Get full history for context
  const history = await getMessages(chatId);
  const messages = history.map(m => ({
    role: m.role === "user" ? "user" : "assistant",
    content: m.content,
  }));

  // Fallback: if history is empty, use current message
  if (messages.length === 0) {
    messages.push({ role: "user", content: text });
  }

  // AI reply
  const system = `You are a warm, supportive after-hours chatbot for youths connected to Singapore Children's Society youth workers.

IMPORTANT — if the youth mentions suicide, self-harm, wanting to die, jumping, cutting, or any immediate danger, you MUST reply with ONLY this:
"I'm really concerned about you right now. Please call SOS immediately at 1800-221-4444 (24 hours) or SMS 741741. Your worker will also be notified. You are not alone. 💙"

For all other messages, reply warmly in 2-3 short sentences. Listen, don't give advice. Always end with something that invites them to keep sharing.`;

  const reply = await callClaude(system, messages);
  await sendTelegram(chatId, reply);
  await saveMessage(chatId, "assistant", reply);

  // After every 5 messages, regenerate the AI summary for the worker dashboard
  if (history.length % 5 === 0) {
    generateSummary(chatId).catch(console.error);
  }
});

// ── Dashboard API — ReachOut app reads this ───────────────────────────────────

app.get("/sessions", async (req, res) => {
  if (req.headers["x-api-key"] !== API_KEY)
    return res.status(401).json({ error: "Unauthorised" });

  const conversations = await supabase("GET",
    "conversations?order=last_message_time.desc");
  res.json(conversations);
});

app.get("/messages/:chatId", async (req, res) => {
  if (req.headers["x-api-key"] !== API_KEY)
    return res.status(401).json({ error: "Unauthorised" });

  const msgs = await getMessages(req.params.chatId);
  res.json(msgs);
});

// ── Worker reply — sends a message back to the youth ─────────────────────────

app.post("/reply", async (req, res) => {
  if (req.headers["x-api-key"] !== API_KEY)
    return res.status(401).json({ error: "Unauthorised" });

  const { chatId, message, workerName } = req.body;
  if (!chatId || !message)
    return res.status(400).json({ error: "Missing chatId or message" });

  await sendTelegram(chatId,
    `💬 *${workerName || "Your worker"}*: ${message}`);
  await saveMessage(chatId, "assistant", `[Worker ${workerName}]: ${message}`);
  res.json({ ok: true });
});

app.get("/", (req, res) => res.json({ status: "ReachOut bot running ✅" }));

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Bot running on port ${PORT}`)); 