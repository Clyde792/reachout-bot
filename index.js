import express from "express";
import fetch from "node-fetch";
import twilio from "twilio";

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
const TWILIO_SID = process.env.TWILIO_ACCOUNT_SID;
const TWILIO_TOKEN = process.env.TWILIO_AUTH_TOKEN;
const TWILIO_FROM = process.env.TWILIO_PHONE_NUMBER;
const WORKER_PHONE = process.env.WORKER_PHONE_NUMBER;
const RAPIDAPI_KEY = process.env.RAPIDAPI_KEY;

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

  const summaryPrompt = "You are a clinical summariser for youth social workers.\nRead this conversation and reply ONLY with valid JSON - no markdown, no explanation:\n{\"risk_level\": \"low or medium or high\", \"summary\": \"2 sentence summary\", \"suggested_action\": \"one clear action\", \"crisis\": true or false, \"age\": \"age or null\", \"school\": \"school or null\", \"likes\": \"likes or null\", \"dislikes\": \"dislikes or null\", \"snapshot\": \"1 sentence snapshot\", \"trust_level\": 0 to 100 integer based on how openly the youth is sharing, \"engagement_level\": 0 to 100 integer based on how actively the youth is participating}";

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
      trust_level: parsed.trust_level,
      engagement_level: parsed.engagement_level,
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

        try {
          const client = twilio(TWILIO_SID, TWILIO_TOKEN);
          await client.calls.create({
            url: 'https://handler.twilio.com/twiml/EHec93d994881880928808eb3dedac7516',
            to: WORKER_PHONE,
            from: TWILIO_FROM,
          });
          console.log("Phone call made to worker!");
        } catch (e) {
          console.error("Call failed:", e.message);
        }
      }, 60 * 1000);
    }
  } catch (e) {
    console.error("Summary parse failed:", e);
  }
}

async function analyzeInstagram(username) {
  try {
    const res = await fetch(
      `https://instagram-scraper-stable-api.p.rapidapi.com/v1/get_user_posts_or_tagged_posts?username_or_url=${encodeURIComponent(username)}&amount=12`,
      {
        method: 'GET',
        headers: {
          'x-rapidapi-key': RAPIDAPI_KEY,
          'x-rapidapi-host': 'instagram-scraper-stable-api.p.rapidapi.com',
        },
      }
    );
    const data = await res.json();
    console.log("Instagram raw:", JSON.stringify(data).slice(0, 300));

    if (!data || data.error || data.detail) {
      return { error: 'Account not found or private' };
    }

    const posts = data.data?.items || data.items || data.result?.items || [];
    if (posts.length === 0) {
      return { error: 'No posts found or account is private' };
    }

    const postData = posts.map(function (p) {
      return {
        caption: p.caption?.text || p.caption || '',
        timestamp: p.taken_at || p.timestamp,
        likes: p.like_count || 0,
        is_reel: p.media_type === 2,
      };
    });

    const timestamps = postData.map(function (p) { return p.timestamp; }).filter(Boolean);
    const daysSinceLastPost = timestamps.length > 0
      ? Math.floor((Date.now() / 1000 - timestamps[0]) / 86400)
      : null;

    const transcript = postData.map(function (p, i) {
      return "Post " + (i + 1) + " (" + (p.is_reel ? 'Reel' : 'Photo') + "): \"" + p.caption + "\"";
    }).join('\n');

    const analysis = await callClaude(
      "You are a youth mental health analyst for Singapore Children's Society workers.\nAnalyse these Instagram posts from a youth and return ONLY valid JSON no markdown:\n{\"caption_risk\": 0 to 100, \"hashtag_risk\": 0 to 100, \"frequency_risk\": 0 to 100, \"overall_risk\": 0 to 100, \"risk_level\": \"low or medium or high\", \"flags\": [\"list of specific concerning phrases or patterns\"], \"summary\": \"2 sentence analysis for the worker\"}\nBase your analysis on: dark language, hopelessness, isolation themes, concerning hashtags like numb broken sad exhausted, and themes of self-harm or giving up. Be conservative - only flag genuine concerns not normal teen expression.",
      [{ role: "user", content: "Username: @" + username + "\nDays since last post: " + daysSinceLastPost + "\nRecent posts:\n" + transcript }],
      1000
    );

    try {
      const clean = analysis.replace(/```json|```/g, '').trim();
      const parsed = JSON.parse(clean);
      return { ...parsed, post_count: posts.length, days_since_last_post: daysSinceLastPost };
    } catch (e) {
      return { error: 'Analysis failed', raw: analysis };
    }
  } catch (e) {
    console.error('Instagram analysis error:', e);
    return { error: e.message };
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

app.post("/analyze-social", async function (req, res) {
  if (req.headers["x-api-key"] !== API_KEY) return res.status(401).json({ error: "Unauthorised" });
  const { chatId, instagram_username } = req.body;
  if (!instagram_username) return res.status(400).json({ error: "Missing instagram_username" });

  console.log("Analysing Instagram:", instagram_username);
  const result = await analyzeInstagram(instagram_username);

  if (!result.error && chatId) {
    await supabase("PATCH", `conversations?chat_id=eq.${chatId}`, {
      instagram_username,
      social_risk_score: result.overall_risk,
      social_risk_summary: result.summary,
      social_last_checked: new Date().toISOString(),
    });
  }

  res.json(result);
});

app.get("/", function (req, res) { res.json({ status: "ReachOut bot running" }); });

const PORT = process.env.PORT || 3000;
app.listen(PORT, function () { console.log("Bot running on port " + PORT); });