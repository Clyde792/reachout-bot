import express from "express";
import fetch from "node-fetch";

const app = express();
app.use(express.json());

const BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const ANTHROPIC_KEY = process.env.ANTHROPIC_API_KEY;
const TELEGRAM_API = `https://api.telegram.org/bot${BOT_TOKEN}`;

// In-memory store (replace with Supabase later)
const sessions = {};

// Crisis keywords
const CRISIS_WORDS = ["suicide", "kill myself", "end my life", "run away", "hurt myself", "self harm"];

function isCrisis(text) {
  return CRISIS_WORDS.some(w => text.toLowerCase().includes(w));
}

async function callClaude(system, userMessage) {
  const res = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-api-key": ANTHROPIC_KEY,
      "anthropic-version": "2023-06-01"
    },
    body: JSON.stringify({
      model: "claude-sonnet-4-6",
      max_tokens: 200,
      system,
      messages: [{ role: "user", content: userMessage }]
    })
  });
  const data = await res.json();
  return data.content?.[0]?.text || "I'm here. Can you tell me more?";
}

async function analyseMessage(text) {
  const system = `You are a social work assistant at Singapore Children's Society.
Analyse this youth message. Return ONLY a JSON object with:
- risk: "low", "medium", or "high"
- summary: one sentence summary
- action: one concrete action for the worker tomorrow
Flag high risk for self-harm, running away, or immediate danger.`;
  try {
    const result = await callClaude(system, text);
    return JSON.parse(result.replace(/```json|```/g, "").trim());
  } catch {
    return { risk: "medium", summary: text, action: "Review this message and follow up." };
  }
}

async function sendTelegram(chatId, text) {
  await fetch(`${TELEGRAM_API}/sendMessage`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ chat_id: chatId, text, parse_mode: "Markdown" })
  });
}

// Webhook endpoint — Telegram sends messages here
app.post("/webhook", async (req, res) => {
  res.sendStatus(200); // Always respond fast

  const message = req.body?.message;
  if (!message || !message.text) return;

  const chatId = message.chat.id;
  const text = message.text;
  const username = message.from?.first_name || "Youth";

  // Store message in session
  if (!sessions[chatId]) {
    sessions[chatId] = {
      username,
      chatId,
      messages: [],
      startTime: new Date().toISOString()
    };
  }

  sessions[chatId].messages.push({
    role: "user",
    content: text,
    time: new Date().toISOString()
  });

  // Crisis check
  if (isCrisis(text)) {
    await sendTelegram(chatId,
      `${username}, I can hear that things are really hard right now. Please reach out immediately:\n\n` +
      `📞 *SOS Crisis Line* — 1800-221-4444\n` +
      `📞 *CHAT* — 1800-353-5800\n\n` +
      `Your worker will also be alerted. You are not alone. 💙`
    );
    sessions[chatId].crisis = true;
    return;
  }

  // /start command
  if (text === "/start") {
    await sendTelegram(chatId,
      `Hey ${username} 👋 I'm ReachOut, a support companion from Singapore Children's Society.\n\n` +
      `Workers are offline right now but I'm here to listen. Your messages are safe and your worker will follow up with you.\n\n` +
      `How are you feeling tonight?`
    );
    return;
  }

  // AI response
  try {
    const system = `You are a warm, supportive AI companion for youths at Singapore Children's Society in Singapore.
Workers are offline. Your job is to listen and provide emotional support only.
Rules:
- Keep responses short (2-3 sentences max)
- Never give medical or psychological advice
- Never pretend to be a human worker
- Be warm, non-judgmental, and conversational
- End every message with a gentle question to keep them talking
- Always remind them their worker will follow up`;

    const history = sessions[chatId].messages
      .slice(-6)
      .map(m => `${m.role === "user" ? username : "Assistant"}: ${m.content}`)
      .join("\n");

    const reply = await callClaude(system, history);
    await sendTelegram(chatId, reply);

    sessions[chatId].messages.push({
      role: "assistant",
      content: reply,
      time: new Date().toISOString()
    });
  } catch (err) {
    await sendTelegram(chatId, "I'm here. Tell me more about what's going on.");
  }
});

// Dashboard API — ReachOut app fetches this to see overnight messages
app.get("/sessions", (req, res) => {
  const key = req.headers["x-api-key"];
  if (key !== process.env.DASHBOARD_API_KEY) {
    return res.status(401).json({ error: "Unauthorised" });
  }

  const result = Object.values(sessions).map(s => ({
    chatId: s.chatId,
    username: s.username,
    startTime: s.startTime,
    crisis: s.crisis || false,
    messageCount: s.messages.length,
    lastMessage: s.messages.filter(m => m.role === "user").slice(-1)[0]?.content || "",
    lastTime: s.messages.slice(-1)[0]?.time || s.startTime,
    analysis: s.analysis || null
  }));

  res.json(result);
});

// Worker reply — send a message back to a youth via Telegram
app.post("/reply", async (req, res) => {
  const key = req.headers["x-api-key"];
  if (key !== process.env.DASHBOARD_API_KEY) {
    return res.status(401).json({ error: "Unauthorised" });
  }

  const { chatId, message, workerName } = req.body;
  if (!chatId || !message) return res.status(400).json({ error: "Missing chatId or message" });

  await sendTelegram(chatId,
    `💬 *${workerName || "Your worker"}*: ${message}\n\n_Reply here to continue the conversation._`
  );

  res.json({ ok: true });
});

// Analyse all sessions (run overnight)
app.post("/analyse", async (req, res) => {
  const key = req.headers["x-api-key"];
  if (key !== process.env.DASHBOARD_API_KEY) {
    return res.status(401).json({ error: "Unauthorised" });
  }

  for (const chatId of Object.keys(sessions)) {
    const s = sessions[chatId];
    const userMessages = s.messages.filter(m => m.role === "user").map(m => m.content).join(" ");
    if (userMessages && !s.analysis) {
      s.analysis = await analyseMessage(userMessages);
    }
  }

  res.json({ ok: true, analysed: Object.keys(sessions).length });
});

// Health check
app.get("/", (req, res) => res.json({ status: "ReachOut bot running" }));

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Bot server running on port ${PORT}`));
