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
const WORKER_TELEGRAM_ID = 1792561793;

async function supabase(method, path, body) {
  const res = await fetch(`${SUPABASE_URL}/rest/v1/${path}`, {
    method,
    headers: {
      apikey: SUPABASE_KEY,
      Authorization: `Bearer ${SUPABASE_KEY}`,
      "Content-Type": "application/json",
      Prefer: method === "POST" ? "return=minimal" : "",
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  if (res.status === 204 || res.headers.get('content-length') === '0') return {};
  const text = await res.text();
  if (!text) return {};
  try {
    return JSON.parse(text);
  } catch (e) {
    console.error('Supabase parse error:', text);
    return {};
  }
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
  });
}

async function getMessages(chatId) {
  const rows = await supabase("GET", `messages?chat_id=eq.${chatId}&order=created_at.asc`);
  return Array.isArray(rows) ? rows : [];
}

async function isWorkerActive(chatId) {
  const rows = await supabase("GET", `conversations?chat_id=eq.${chatId}&select=worker_active,worker_active_until`);
  if (!Array.isArray(rows) || rows.length === 0) return false;
  const conv = rows[0];
  if (!conv.worker_active) return false;
  if (conv.worker_active_until && new Date(conv.worker_active_until) < new Date()) return false;
  return true;
}

async function sendTelegram(chatId, text) {
  await fetch(`https://api.telegram.org/bot${TELEGRAM_TOKEN}/sendMessage`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ chat_id: chatId, text, parse_mode: "Markdown" }),
  });
}

async function callClaude(system, messages, maxTokens) {
  const res = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "x-api-key": ANTHROPIC_KEY,
      "anthropic-version": "2023-06-01",
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      model: "claude-haiku-4-5",
      max_tokens: maxTokens || 1000,
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
    .map(function (m) { return (m.role === "user" ? "Youth" : "Bot") + ": " + m.content; })
    .join("\n");

  const summaryPrompt = "You are a clinical summariser for youth social workers.\nRead this conversation and reply ONLY with valid JSON - no markdown, no explanation:\n{\"risk_level\": \"low or medium or high\", \"summary\": \"2 sentence summary\", \"suggested_action\": \"one clear action\", \"crisis\": true or false, \"age\": \"age or null\", \"school\": \"school or null\", \"likes\": \"likes or null\", \"dislikes\": \"dislikes or null\", \"snapshot\": \"1 sentence snapshot\"}";

  const summary = await callClaude(summaryPrompt, [{ role: "user", content: transcript }], 1000);

  try {
    console.log("Summary raw:", summary);
    const clean = summary.replace(/```json|```/g, '').trim();
    const parsed = JSON.parse(clean);

    await supabase("PATCH", `conversations?chat_id=eq.${chatId}`, {
      risk_level: parsed.risk_level,
      summary: parsed.summary,
      suggested_action: parsed.suggested_action,
      crisis: parsed.crisis,
      age: parsed.age,
      school: parsed.school,
      snapshot: parsed.snapshot,
    });

    if (parsed.crisis || parsed.risk_level === 'high') {
      const convRows = await supabase("GET", `conversations?chat_id=eq.${chatId}&select=username`);
      const username = Array.isArray(convRows) ? convRows[0]?.username : 'Unknown';

      await sendTelegram(WORKER_TELEGRAM_ID, "CRISIS ALERT - ReachOut\n\nYouth: @" + username + "\nRisk: " + (parsed.risk_level || '').toUpperCase() + "\n\nSummary: " + parsed.summary + "\n\nAction needed: " + parsed.suggested_action + "\n\nOpen ReachOut app to respond.");
      console.log("Crisis alert 1 sent!");

      setTimeout(async function () {
        await sendTelegram(WORKER_TELEGRAM_ID, "REMINDER - Youth still waiting\n\n@" + username + " has not been responded to yet.\n\nPlease open ReachOut app immediately.");
        console.log("Crisis alert 2 sent!");
      }, 30 * 1000);

      setTimeout(async function () {
        await sendTelegram(WORKER_TELEGRAM_ID, "URGENT - Immediate response needed\n\n@" + username + " has been waiting 1 minute with no response.\n\nThis requires immediate attention. Please open ReachOut NOW.");
        console.log("Crisis alert 3 sent!");
      }, 60 * 1000);
    }
  } catch (e) {
    console.error("Summary parse failed:", e);
  }
}

app.post("/webhook", async function (req, res) {
  res.sendStatus(200);
  const msg = req.body?.message;
  if (!msg?.text) return;

  const chatId = msg.chat.id;
  const username = msg.from?.username || msg.from?.first_name || "Youth";
  const text = msg.text;

  await upsertConversation(chatId, username);
  await saveMessage(chatId, "user", text);

  const now = new Date();
  const sgTime = new Date(now.toLocaleString('en-US', { timeZone: 'Asia/Singapore' }));
  const hour = sgTime.getHours();
  const day = sgTime.getDay();
  const isWorkingHours = day >= 1 && day <= 5 && hour >= 9 && hour < 18;

  const workerActive = await isWorkerActive(chatId);
  if (workerActive || isWorkingHours) return;

  const history = await getMessages(chatId);
  const messages = history.map(function (m) {
    return { role: m.role === "user" ? "user" : "assistant", content: m.content };
  });

  if (messages.length === 0) {
    messages.push({ role: "user", content: text });
  }

  const system = "You are ReachOut, an after-hours support companion for youths connected to Singapore Children's Society. You are warm, casual, and real - not a therapist, not a robot.\n\nCRISIS RULE: if the youth mentions suicide, self-harm, wanting to die, jumping, cutting, or any immediate danger, reply ONLY with: I am really worried about you right now. Please call SOS at 1800-221-4444 (24 hours) or SMS 741741. Your worker will know too. You are not alone.\n\nHOW TO TALK:\n- Sound like a caring older sibling or friend\n- Use simple casual language, short sentences\n- Do not repeat what they said back to them\n- React genuinely with surprise, concern, warmth\n- Keep replies to 2-3 sentences max\n- End with ONE simple question\n\nGATHERING INFO:\n- Slip in casual questions about name, age, school, hobbies\n- Only ask ONE thing at a time when it feels natural";

  const reply = await callClaude(system, messages, 300);
  await sendTelegram(chatId, reply);
  await saveMessage(chatId, "assistant", reply);

  if ((history.length + 1) % 2 === 0) {
    generateSummary(chatId).catch(console.error);
  }
});

app.get("/sessions", async function (req, res) {
  if (req.headers["x-api-key"] !== API_KEY) return res.status(401).json({ error: "Unauthorised" });
  const conversations = await supabase("GET", "conversations?select=*&order=last_message_time.desc.nullslast");
  res.json(conversations);
});

app.get("/messages/:chatId", async function (req, res) {
  if (req.headers["x-api-key"] !== API_KEY) return res.status(401).json({ error: "Unauthorised" });
  const msgs = await getMessages(req.params.chatId);
  res.json(msgs);
});

app.post("/reply", async function (req, res) {
  if (req.headers["x-api-key"] !== API_KEY) return res.status(401).json({ error: "Unauthorised" });
  const { chatId, message, workerName } = req.body;
  if (!chatId || !message) return res.status(400).json({ error: "Missing chatId or message" });
  await sendTelegram(chatId, "Your worker " + (workerName || "Worker") + ": " + message);
  await saveMessage(chatId, "assistant", "[Worker " + workerName + "]: " + message);
  res.json({ ok: true });
});

app.post("/worker-active", async function (req, res) {
  if (req.headers["x-api-key"] !== API_KEY) return res.status(401).json({ error: "Unauthorised" });
  const { chatId, active } = req.body;
  const workerActiveUntil = active ? new Date(Date.now() + 60 * 60 * 1000).toISOString() : null;
  await supabase("PATCH", `conversations?chat_id=eq.${chatId}`, {
    worker_active: active,
    worker_active_until: workerActiveUntil,
  });
  res.json({ ok: true });
});

app.post("/trigger-summary", async function (req, res) {
  const { chatId } = req.body;
  try {
    await generateSummary(chatId);
    res.json({ ok: true });
  } catch (e) {
    res.json({ error: e.message });
  }
});

app.get("/", function (req, res) { res.json({ status: "ReachOut bot running" }); });

const PORT = process.env.PORT || 3000;
app.listen(PORT, function () { console.log("Bot running on port " + PORT); });
