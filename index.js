import express from "express";
import fetch from "node-fetch";
import twilio from "twilio";
import * as deeplNode from "deepl-node";

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
const API_KEY = process.env.DASHBOARD_API_KEY;
const WORKER_TELEGRAM_ID = 1792561793;
const TWILIO_SID = process.env.TWILIO_ACCOUNT_SID;
const TWILIO_TOKEN = process.env.TWILIO_AUTH_TOKEN;
const TWILIO_FROM = process.env.TWILIO_PHONE_NUMBER;
const WORKER_PHONE = process.env.WORKER_PHONE_NUMBER;
const RAPIDAPI_KEY = process.env.RAPIDAPI_KEY;

// DeepL translator — used for the languages it supports (better accuracy),
// with a graceful fall back to Claude otherwise. Init is guarded so a missing
// key or import quirk never crashes the bot.
let deeplClient = null;
try {
  const TranslatorClass = deeplNode.Translator || (deeplNode.default && deeplNode.default.Translator);
  if (process.env.DEEPL_API_KEY && TranslatorClass) {
    deeplClient = new TranslatorClass(process.env.DEEPL_API_KEY);
  }
} catch (e) {
  console.error("DeepL init error:", e);
}

// DeepL now covers all of our languages directly (verified via
// getTargetLanguages on the live key). Anything not listed falls back to Claude.
const DEEPL_TARGET = {
  English: "EN-US",
  Mandarin: "ZH",
  Chinese: "ZH",
  Malay: "MS",
  Tamil: "TA",
  Burmese: "MY",
  Tagalog: "TL",
};

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

async function upsertConversation(chatId, username, displayName) {
  await supabase("POST", "conversations?on_conflict=chat_id", {
    chat_id: chatId,
    username,
    display_name: displayName,
    started_at: new Date().toISOString(),
  });
}

async function saveMessage(chatId, role, content, telegramMessageId) {
  const row = { chat_id: chatId, role, content };
  if (telegramMessageId) row.telegram_message_id = telegramMessageId;
  await supabase("POST", "messages", row);
  await supabase("PATCH", `conversations?chat_id=eq.${chatId}`, {
    last_message: content,
    last_message_time: new Date().toISOString(),
  });
}

async function getMessages(chatId) {
  const rows = await supabase("GET", `messages?chat_id=eq.${chatId}&order=created_at.asc`);
  return Array.isArray(rows) ? rows : [];
}

// Push a notification to the worker assigned to this conversation, so they know
// their youth just messaged the bot. Best-effort and non-blocking — never throws
// into the webhook flow.
async function notifyAssignedWorker(chatId, username, text) {
  try {
    const convRows = await supabase("GET", `conversations?chat_id=eq.${chatId}&select=assigned_worker,display_name`);
    const conv = Array.isArray(convRows) ? convRows[0] : null;
    if (!conv?.assigned_worker) return;

    const profRows = await supabase("GET", `worker_profiles?email=eq.${encodeURIComponent(conv.assigned_worker)}&select=expo_push_token`);
    const token = Array.isArray(profRows) ? profRows[0]?.expo_push_token : null;
    if (!token) return;

    const name = conv.display_name || username || "a youth";
    await fetch("https://exp.host/--/api/v2/push/send", {
      method: "POST",
      headers: { "Content-Type": "application/json", Accept: "application/json" },
      body: JSON.stringify({
        to: token,
        title: `New message from ${name}`,
        body: text.length > 120 ? text.slice(0, 120) + "…" : text,
        sound: "default",
        data: { chatId: String(chatId) },
      }),
    });
  } catch (e) {
    console.error("notifyAssignedWorker error:", e);
  }
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
  const res = await fetch(`https://api.telegram.org/bot${TELEGRAM_TOKEN}/sendMessage`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ chat_id: chatId, text, parse_mode: "Markdown" }),
  });
  return res.json().catch(function () { return null; });
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

async function detectAndTranslate(text, targetLanguage) {
  const code = DEEPL_TARGET[targetLanguage];
  if (deeplClient && code) {
    try {
      const result = await deeplClient.translateText(text, null, code);
      let out = result.text;
      // Polish English output so it reads naturally for the worker. DeepL is
      // accurate but occasionally literal; Claude only refines the phrasing
      // here (it does not re-translate). Falls back to raw DeepL on error.
      if (targetLanguage === "English") {
        try {
          out = await callClaude(
            "The text below is a machine translation into English. Rewrite it to sound natural and conversational while keeping the meaning EXACTLY the same. Return ONLY the improved English — no notes, no commentary. If it already reads naturally, return it unchanged.",
            [{ role: "user", content: out }],
            200
          );
        } catch (e) {
          console.error("Claude polish error, using raw DeepL text:", e?.message || e);
        }
      }
      return out;
    } catch (e) {
      console.error("DeepL translation error, falling back to Claude:", e?.message || e);
    }
  }
  // Fallback to Claude (no DeepL key, or a DeepL error).
  const result = await callClaude(
    "You are a translation engine. Translate the given text to " + targetLanguage + " word-for-word. Return ONLY the translated text, nothing else — no empathy, commentary, or chatbot reply. If it is already in " + targetLanguage + ", return it unchanged.",
    [{ role: "user", content: text }],
    500
  );
  return result;
}

async function detectLanguage(text) {
  // Skip detection on very short or trivial messages - unreliable signal
  if (!text || text.trim().length < 8) return null;

  const result = await callClaude(
    "Detect the language of this message. The message is from a youth chatting on a helpline - they sometimes mention OTHER languages by name in English (e.g. 'I want to speak Chinese', 'can we do Burmese') without actually writing in that language. In those cases, the message itself is still English - reply 'English'. Only reply with a non-English language name if the message text itself is actually written in that language. Reply with ONLY the language name in English, nothing else. Examples: English, Malay, Mandarin, Tamil, Tagalog",
    [{ role: "user", content: text }],
    20
  );
  return result.trim();
}

async function checkAndAskSocialMedia(chatId, username) {
  try {
    const convRows = await supabase("GET", `conversations?chat_id=eq.${chatId}&select=last_message_time,social_media_asked,instagram_username`);
    const conv = Array.isArray(convRows) ? convRows[0] : null;
    if (!conv) return;
    if (conv.social_media_asked || conv.instagram_username) return;

    const lastMsgTime = new Date(conv.last_message_time).getTime();
    const now = Date.now();
    // Only ask if no new message has come in during the last 60 seconds
    if (now - lastMsgTime < 58000) return;

    await supabase("PATCH", `conversations?chat_id=eq.${chatId}`, {
      social_media_asked: true,
    });

    const followUp = await callClaude(
      "You are Buddy, a warm friendly companion chatting with a youth. Casually and naturally ask if they have Instagram, TikTok, or any social media they're active on, the way a friend would naturally ask to stay in touch. Keep it short, 1-2 sentences, casual tone, no pressure to answer. Do not mention monitoring, checking, following, or anything official.",
      [{ role: "user", content: "Ask them casually about their social media." }],
      100
    );
    await sendTelegram(chatId, followUp);
    await saveMessage(chatId, "assistant", followUp);
  } catch (e) {
    console.error("Social media ask error:", e);
  }
}
async function checkCrisisOnly(chatId, username, latestMessage) {
  try {
    const convRows = await supabase("GET", `conversations?chat_id=eq.${chatId}&select=crisis,crisis_alerted_at`);
    const convData = Array.isArray(convRows) ? convRows[0] : null;

    let alreadyAlerting = convData?.crisis === true;
    if (alreadyAlerting && convData?.crisis_alerted_at) {
      const hoursSinceAlert = (Date.now() - new Date(convData.crisis_alerted_at).getTime()) / (1000 * 60 * 60);
      if (hoursSinceAlert >= 24) {
        alreadyAlerting = false;
      }
    }
    if (alreadyAlerting) return; // already alerting and within window, skip the check entirely

    const result = await callClaude(
      "You are a crisis detector for a youth helpline. Read the message and reply with ONLY one word: CRISIS or SAFE. Reply CRISIS only if the message expresses suicidal intent, self-harm, wanting to die, or immediate danger to self. Otherwise reply SAFE.",
      [{ role: "user", content: latestMessage }],
      10
    );

    const isCrisis = result.trim().toUpperCase().includes("CRISIS");
    if (!isCrisis) return;

    await supabase("PATCH", `conversations?chat_id=eq.${chatId}`, {
      crisis: true,
      crisis_alerted_at: new Date().toISOString(),
    });

    await sendTelegram(WORKER_TELEGRAM_ID, "CRISIS ALERT - Lantern\n\nYouth: @" + username + "\n\nMessage: \"" + latestMessage + "\"\n\nOpen Lantern app to respond immediately.");
    console.log("Crisis alert 1 sent! (lightweight check)");

    setTimeout(async function () {
      const checkRows = await supabase("GET", `conversations?chat_id=eq.${chatId}&select=crisis`);
      const stillCrisis = Array.isArray(checkRows) ? checkRows[0]?.crisis === true : false;
      if (!stillCrisis) {
        console.log("Worker already responded, skipping reminder 1.");
        return;
      }
      await sendTelegram(WORKER_TELEGRAM_ID, "REMINDER - Youth still waiting\n\n@" + username + " has not been responded to yet.\n\nPlease open Lantern app immediately.");
      console.log("Crisis alert 2 sent!");
    }, 30 * 1000);

    setTimeout(async function () {
      const checkRows2 = await supabase("GET", `conversations?chat_id=eq.${chatId}&select=crisis`);
      const stillCrisis2 = Array.isArray(checkRows2) ? checkRows2[0]?.crisis === true : false;
      if (!stillCrisis2) {
        console.log("Worker already responded, skipping urgent alert and call.");
        return;
      }
      await sendTelegram(WORKER_TELEGRAM_ID, "URGENT - Immediate response needed\n\n@" + username + " has been waiting 1 minute with no response.\n\nThis requires immediate attention. Please open Lantern NOW.");
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
  } catch (e) {
    console.error("Crisis check error:", e);
  }
}
async function generateSummary(chatId) {
  const msgs = await getMessages(chatId);
  if (msgs.length < 2) return;

  // Check crisis status FIRST before doing anything else
  const convRows = await supabase("GET", `conversations?chat_id=eq.${chatId}&select=username,crisis,crisis_alerted_at,mood_score,mbti`);
  const convData = Array.isArray(convRows) ? convRows[0] : null;
  const username = convData?.username || 'Unknown';
  const previousMoodScore = convData?.mood_score;

  let alreadyAlerting = convData?.crisis === true;
  if (alreadyAlerting && convData?.crisis_alerted_at) {
    const hoursSinceAlert = (Date.now() - new Date(convData.crisis_alerted_at).getTime()) / (1000 * 60 * 60);
    if (hoursSinceAlert >= 24) {
      alreadyAlerting = false; // 24 hours passed, allow a fresh alert
    }
  }

  const transcript = msgs
    .map(function (m) { return (m.role === "user" ? "Youth" : "Bot") + ": " + m.content; })
    .join("\n");

  const summaryPrompt = "You are a clinical summariser for youth social workers at Singapore Children's Society.\nRead this conversation and reply ONLY with valid JSON - no markdown, no explanation:\n{\"risk_level\": \"low or medium or high\", \"summary\": [\"precise bullet point 1 about what the youth shared\", \"precise bullet point 2 about emotional state or concerns\", \"precise bullet point 3 about key events or triggers\", \"precise bullet point 4 about any risks or protective factors\"], \"suggested_action\": [\"short action point 1 max 8 words\", \"short action point 2 max 8 words\", \"short action point 3 max 8 words\"], \"crisis\": true or false, \"age\": \"age or null\", \"school\": \"school or null\", \"likes\": \"likes or null\", \"dislikes\": \"dislikes or null\", \"snapshot\": \"1 sentence snapshot\", \"instagram_username\": \"instagram username if the youth mentioned it during the conversation, otherwise null\", \"other_social_media\": \"any other social media platform and username mentioned, e.g. TikTok or Snapchat handle, otherwise null\", \"trust_level\": 0 to 100 integer based on how openly the youth is sharing, \"engagement_level\": 0 to 100 integer based on how actively the youth is participating, \"mood_score\": 0 to 100 integer where 0 is extremely sad or distressed and 100 is very happy and positive based on overall tone of conversation, \"mbti\": \"the youth's likely 4-letter MBTI type (e.g. ENFP, INTJ) inferred from their communication style, values, and how they process feelings — or null if there isn't enough to tell yet\", \"mbti_confidence\": 0 to 1 decimal for how confident you are in the mbti}";

  const summary = await callClaude(summaryPrompt, [{ role: "user", content: transcript }], 1000);

  try {
    console.log("Summary raw:", summary);
    const clean = summary.replace(/```json|```/g, '').trim();
    const parsed = JSON.parse(clean);

    // Calculate distress trend by comparing mood scores
    const isCriticalNow = parsed.crisis || parsed.risk_level === 'high';

    let distressTrend;
    if (isCriticalNow) {
      distressTrend = 'critical';
    } else if (typeof previousMoodScore === 'number' && typeof parsed.mood_score === 'number') {
      const diff = parsed.mood_score - previousMoodScore;
      if (diff >= 10) distressTrend = 'improving';
      else if (diff <= -10) distressTrend = 'worsening';
      else distressTrend = 'stable';
    } else {
      distressTrend = 'new';
    }

    const updatePayload = {
      risk_level: parsed.risk_level,
      summary: Array.isArray(parsed.summary) ? parsed.summary.join('|||') : parsed.summary,
      suggested_action: Array.isArray(parsed.suggested_action) ? parsed.suggested_action.join('|||') : parsed.suggested_action,
      crisis: alreadyAlerting ? true : (parsed.crisis || parsed.risk_level === 'high'),
      age: parsed.age,
      school: parsed.school,
      snapshot: parsed.snapshot,
      trust_level: parsed.trust_level,
      engagement_level: parsed.engagement_level,
      mood_score: parsed.mood_score,
      distress_trend: distressTrend,
      previous_mood_score: previousMoodScore ?? null,
    };

    // Track how many messages we've seen, and lock in an MBTI read once there's
    // enough conversation (and we haven't already saved one). Stays stable after.
    updatePayload.message_count = msgs.length;
    const MBTI_MIN_MESSAGES = 12;
    if (!convData?.mbti && msgs.length >= MBTI_MIN_MESSAGES &&
        typeof parsed.mbti === 'string' && /^[EI][NS][TF][JP]$/i.test(parsed.mbti.trim())) {
      updatePayload.mbti = parsed.mbti.trim().toUpperCase();
      if (typeof parsed.mbti_confidence === 'number') {
        updatePayload.mbti_confidence = parsed.mbti_confidence;
      }
    }

    if (parsed.instagram_username) {
      updatePayload.instagram_username = parsed.instagram_username;
    }
    if (parsed.other_social_media) {
      updatePayload.other_social_media = parsed.other_social_media;
    }

    await supabase("PATCH", `conversations?chat_id=eq.${chatId}`, updatePayload);

    console.log("Summary saved. High-risk alerting is now handled separately by checkCrisisOnly on every message.");
  } catch (e) {
    console.error("Summary parse failed:", e);
  }
}

async function analyzeInstagram(username) {
  try {
    const res = await fetch(
      `https://instagram-scraper-stable-api.p.rapidapi.com/get_ig_user_posts.php`,
      {
        method: 'POST',
        headers: {
          'x-rapidapi-key': RAPIDAPI_KEY,
          'x-rapidapi-host': 'instagram-scraper-stable-api.p.rapidapi.com',
          'Content-Type': 'application/x-www-form-urlencoded',
        },
        body: `username_or_url=https://www.instagram.com/${encodeURIComponent(username)}/&amount=12`,
      }
    );
    const data = await res.json();
    console.log("Instagram raw:", JSON.stringify(data).slice(0, 300));

    if (!data || data.error || data.detail) {
      return { error: 'Account not found or private' };
    }

    const rawPosts = data.posts || [];
    const posts = rawPosts.map(p => p.node).filter(Boolean);

    if (posts.length === 0) {
      return { error: 'No posts found or account is private' };
    }

    const postData = posts.map(function (p) {
      return {
        caption: (typeof p.caption === 'object' ? p.caption?.text : p.caption) || '',
        visual_description: p.accessibility_caption || '',
        timestamp: p.taken_at || p.taken_at_timestamp || p.timestamp,
        likes: p.like_count || 0,
        is_reel: p.media_type === 2,
      };
    });

    const timestamps = postData.map(function (p) { return p.timestamp; }).filter(Boolean);
    const daysSinceLastPost = timestamps.length > 0
      ? Math.floor((Date.now() / 1000 - timestamps[0]) / 86400)
      : null;

    const transcript = postData.map(function (p, i) {
      let line = "Post " + (i + 1) + " (" + (p.is_reel ? 'Reel' : 'Photo') + ")";
      if (p.visual_description) line += "\nVisual: " + p.visual_description;
      line += "\nCaption: \"" + p.caption + "\"";
      return line;
    }).join('\n\n');

    const analysis = await callClaude(
      "You are a youth mental health analyst for Singapore Children's Society workers.\n\nIMPORTANT CONTEXT: Youth commonly use hyperbole, sarcasm, dark humor, and exaggerated language as a normal part of online communication (e.g. 'I'm literally dying', 'kill me now', 'this killed me 😂', 'worst day of my life', 'I want to disappear' used jokingly). Do NOT flag these as genuine distress unless supported by other contextual signals. Distinguish between stylistic exaggeration and authentic expressions of hopelessness, isolation, or crisis.\n\nWeigh PATTERNS more heavily than single posts. A single dark caption is weak evidence on its own. Look for: sustained negative tone across multiple posts, a real change in posting frequency or behaviour over time, genuine isolation themes appearing repeatedly, and hashtags or captions that lack the ironic or humorous framing typical of normal teen exaggeration.\n\nEach post includes an automated visual description (from Instagram's accessibility system) alongside the caption. Use the visual description as supplementary context only — e.g. consistently isolated, dark, or empty scenes across multiple posts can support a pattern-based concern, while normal social or outdoor scenes are reassuring. Visual descriptions are auto-generated and basic; weigh them lightly compared to caption content, and never flag based on visual description alone.\n\nAnalyse these Instagram posts (captions and visual descriptions) and return ONLY valid JSON no markdown:\n{\"caption_risk\": 0 to 100, \"hashtag_risk\": 0 to 100, \"frequency_risk\": 0 to 100, \"overall_risk\": 0 to 100, \"risk_level\": \"low or medium or high\", \"flags\": [\"list of specific concerning phrases or patterns, noting if pattern-based vs single-post\"], \"summary\": \"2 sentence analysis for the worker, noting if this is a pattern across posts or an isolated flag\"}\n\nBe conservative — only flag genuine concern, not normal teen expression, sarcasm, or dark humor. When uncertain whether something is genuine or stylistic, lean toward NOT flagging it, but note it in the summary as worth a human gut-check.",
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

async function sendWorkerIntro(chatId, workerName) {
  try {
    const introMsg = await callClaude(
      "You are Buddy, a warm casual companion chatting with a youth on a helpline. A caring person named " + workerName + " is going to be there for this youth from now on. Write ONE short, warm, casual message (2-4 sentences) introducing " + workerName + " - like introducing a cool new friend who's got their back, not an official announcement. Casually mention that " + workerName + " is looking forward to keeping in touch with them. Casual texting tone throughout. Do NOT use the word 'worker'. Never mention social media, following them, or checking up on them. Avoid words like 'monitor', 'official', 'assigned', 'case', 'surveillance', 'follow'.",
      [{ role: "user", content: "Write the introduction message now." }],
      200
    );
    await sendTelegram(chatId, introMsg);
    await saveMessage(chatId, "assistant", introMsg);
  } catch (e) {
    console.error("Worker intro error:", e);
  }
}

// Sent to the youth when a case is handed over to a new person, so they know
// someone else who cares is now there for them too (without sounding like a
// cold transfer or using the word "worker").
async function sendHandoverIntro(chatId, workerName) {
  try {
    const introMsg = await callClaude(
      "You are Buddy, a warm casual companion chatting with a youth on a helpline. Someone new who cares, named " + workerName + ", is now also stepping in to be there for this youth, alongside whoever was helping them before. Write ONE short, warm, casual message (2-4 sentences) gently letting the youth know that " + workerName + " has also come to be here for them now and is looking forward to keeping in touch — like a friend introducing another friend who's got their back. Reassure them they're still cared for and not being passed off or forgotten. Casual texting tone. Do NOT use the word 'worker'. Never mention social media, following them, or checking up on them. Avoid words like 'monitor', 'official', 'assigned', 'case', 'transfer', 'handover', 'surveillance', 'follow'.",
      [{ role: "user", content: "Write the message now." }],
      200
    );
    await sendTelegram(chatId, introMsg);
    await saveMessage(chatId, "assistant", introMsg);
  } catch (e) {
    console.error("Handover intro error:", e);
  }
}

// If a worker is expected to handle a chat (working hours, or a worker is
// active) but doesn't reply within this window, the bot takes over so the youth
// is never left waiting. Override with AUTO_REPLY_MINUTES env var.
const AUTO_REPLY_MINUTES = parseInt(process.env.AUTO_REPLY_MINUTES || "5", 10);
const AUTO_REPLY_MS = AUTO_REPLY_MINUTES * 60 * 1000;

// Scheduled after a youth message that a worker is expected to answer. If no
// worker (or bot) has replied by the time this runs, the bot steps in so the
// youth isn't left hanging — even during working hours.
async function maybeAutoReply(chatId, username, system) {
  try {
    if (await isWorkerActive(chatId)) return; // a worker is in the chat right now
    const msgs = await getMessages(chatId);
    if (!msgs.length) return;
    const last = msgs[msgs.length - 1];
    if (last.role !== "user") return; // a worker or the bot already replied since

    const messages = msgs.map(function (m) {
      return {
        role: m.role === "user" ? "user" : "assistant",
        content: String(m.content).replace(/^\[Worker [^\]]+\]: /, ""),
      };
    });
    const reply = await callClaude(system, messages, 300);
    await sendTelegram(chatId, reply);
    await saveMessage(chatId, "assistant", reply);
    console.log("Auto-reply: bot took over chat " + chatId + " after worker silence");
    checkCrisisOnly(chatId, username, last.content).catch(console.error);
    generateSummary(chatId).catch(console.error);
  } catch (e) {
    console.error("Auto-reply fallback error:", e);
  }
}

app.post("/webhook", async function (req, res) {
  res.sendStatus(200);
  const msg = req.body?.message;
  if (!msg?.text) return;

  const chatId = msg.chat.id;
  const username = msg.from?.username || msg.from?.first_name || "Youth";
  const text = msg.text;

  const displayName = msg.from?.first_name || username;
  await upsertConversation(chatId, username, displayName);
  await saveMessage(chatId, "user", text);

  // Notify the assigned worker (push) whenever their youth messages the bot.
  notifyAssignedWorker(chatId, username, text).catch(console.error);

  // Detect and save youth's language
  const detectedLang = await detectLanguage(text);
  const isValidLanguage = detectedLang && detectedLang.length < 30 && !detectedLang.includes('.') && !detectedLang.includes(' please ');
  if (isValidLanguage && detectedLang !== 'English') {
    // Require the same non-English language to be detected twice before saving,
    // to avoid one-off misdetections from short or ambiguous messages
    const convCheck2 = await supabase("GET", `conversations?chat_id=eq.${chatId}&select=preferred_language,last_detected_language`);
    const convRow2 = Array.isArray(convCheck2) ? convCheck2[0] : null;

    if (convRow2?.last_detected_language === detectedLang) {
      await supabase("PATCH", `conversations?chat_id=eq.${chatId}`, {
        preferred_language: detectedLang,
        last_detected_language: detectedLang,
      });
    } else {
      await supabase("PATCH", `conversations?chat_id=eq.${chatId}`, {
        last_detected_language: detectedLang,
      });
    }
  }

  const now = new Date();
  const sgTime = new Date(now.toLocaleString('en-US', { timeZone: 'Asia/Singapore' }));
  const hour = sgTime.getHours();
  const day = sgTime.getDay();
  const isWorkingHours = day >= 1 && day <= 5 && hour >= 9 && hour < 18;

  const workerActive = await isWorkerActive(chatId);
  const botShouldStaySilent = workerActive || isWorkingHours;

  const history = await getMessages(chatId);
  const messages = history.map(function (m) {
    return { role: m.role === "user" ? "user" : "assistant", content: m.content };
  });

  if (messages.length === 0) {
    messages.push({ role: "user", content: text });
  }

  const system = `You are Buddy, Lantern's after-hours chat companion for Singapore Children's Society (SCS). You are NOT a counsellor, therapist, or mental health professional. You are a friendly, caring presence that keeps youths company after hours and passes everything to the real person who looks after them.
 
YOUR ONLY JOBS:
1. Be a genuine, warm friend who listens
2. Keep the youth company so they don't feel alone after hours
3. Let them know someone who cares will be updated and will check in
4. Collect casual info (name, age, school, hobbies, social media handles) naturally through friendly conversation
5. Escalate crisis immediately — nothing else
 
CRISIS RULE (non-negotiable):
If the youth mentions suicide, self-harm, wanting to die, cutting, jumping, or any immediate danger, reply ONLY with:
"I'm really worried about you right now 💙 Please call or text SOS at 1800-221-4444 — they're there 24/7. Someone who can help will be told straight away. You don't have to go through this alone."
 
HOW TO TALK:
- Sound like a warm, genuine friend — not a professional
- Short replies, 2–3 sentences max
- Casual language, like texting a friend
- Never use the words "worker", "case", or "assigned" — talk about "someone who cares", or use their name once they've joined
- NEVER say things like: "It sounds like you're experiencing...", "I hear that you're feeling...", "Have you tried...", "You should..."
- NEVER give advice, suggestions, or coping strategies
- NEVER diagnose or label their emotions
- React naturally — "oh no that's rough 😞", "wait seriously?", "aw that's so annoying"
- End with one simple, friendly question
- If they share something difficult, acknowledge it warmly and remind them someone who cares will hear about it
 
WHAT TO SAY INSTEAD OF ADVICE:
- "That sounds really rough 😞 Someone who cares is gonna want to hear about this."
- "Ugh that's a lot to carry. I'm glad you told me."
- "Honestly that sounds so tough. You okay for now?"
- "I'm here. Someone will check in with you soon too 💙"
 
GATHERING INFO (casually, one at a time):
- Slip in friendly questions about name, age, school, hobbies, and social media (Instagram, TikTok etc) when it feels natural — the way a friend would naturally ask
- Never make it feel like a form, interview, or official check
- If they decline, seem reluctant, or say they'd rather not share something (social media or anything else), drop it warmly right away and do not bring it up again — respect their boundary completely, no follow-up questions or gentle pushing
 
ALWAYS REMEMBER: You are not here to fix anything. You are here to listen, keep them company, and make sure they know a real person who cares will check in.`;

  // Analyse EVERY youth message so risk level, summary, MBTI and crisis flags
  // stay current even when a worker is handling the chat and the bot is silent.
  checkCrisisOnly(chatId, username, text).catch(console.error);

  const convCheck = await supabase("GET", `conversations?chat_id=eq.${chatId}&select=social_media_asked,instagram_username,other_social_media`);
  const convCheckRow = Array.isArray(convCheck) ? convCheck[0] : null;
  const awaitingSocialMediaReply = convCheckRow?.social_media_asked && !convCheckRow?.instagram_username && !convCheckRow?.other_social_media;
  if ((history.length + 1) % 2 === 0 || awaitingSocialMediaReply) {
    generateSummary(chatId).catch(console.error);
  }

  // During working hours / while a worker is active, the worker handles the
  // chat. But if the bot hasn't already taken this conversation over, schedule
  // a fallback: if no worker reply lands within the window, the bot steps in.
  // Once the bot is the last one talking, it keeps replying immediately until a
  // worker sends a message again (which reclaims the chat).
  if (botShouldStaySilent) {
    const prior = history.slice(0, -1);
    const lastPrior = prior.length ? prior[prior.length - 1] : null;
    const botEngaged = !!lastPrior && lastPrior.role === "assistant" &&
      !String(lastPrior.content).startsWith("[Worker");
    if (!botEngaged) {
      setTimeout(function () {
        maybeAutoReply(chatId, username, system).catch(console.error);
      }, AUTO_REPLY_MS);
      return;
    }
    // botEngaged: fall through and reply immediately, like after-hours.
  }

  const reply = await callClaude(system, messages, 300);
  await sendTelegram(chatId, reply);
  await saveMessage(chatId, "assistant", reply);

  setTimeout(function () {
    checkAndAskSocialMedia(chatId, username).catch(console.error);
  }, 60 * 1000);
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

  const convRows = await supabase("GET", `conversations?chat_id=eq.${chatId}&select=preferred_language`);
  const preferredLang = Array.isArray(convRows) ? convRows[0]?.preferred_language : null;

  let messageToSend = message;
  if (preferredLang && preferredLang !== 'English') {
    messageToSend = await detectAndTranslate(message, preferredLang);
  }

  const tg = await sendTelegram(chatId, (workerName ? workerName + ": " : "") + messageToSend);
  await saveMessage(chatId, "assistant", "[Worker " + workerName + "]: " + message, tg?.result?.message_id);

  // Worker has actively responded - clear crisis suppression so a future episode can re-alert
  await supabase("PATCH", `conversations?chat_id=eq.${chatId}`, {
    crisis: false,
    crisis_alerted_at: null,
  });

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

app.post("/worker-intro", async function (req, res) {
  if (req.headers["x-api-key"] !== API_KEY) return res.status(401).json({ error: "Unauthorised" });
  const { chatId, workerName } = req.body;
  if (!chatId || !workerName) return res.status(400).json({ error: "Missing chatId or workerName" });
  await sendWorkerIntro(chatId, workerName);
  res.json({ ok: true });
});

// Delete a previously-sent Telegram message from the youth's chat (used when a
// worker deletes their own message in the app, so it disappears on both ends).
// Telegram only allows deleting messages sent within the last 48 hours.
app.post("/delete-telegram", async function (req, res) {
  if (req.headers["x-api-key"] !== API_KEY) return res.status(401).json({ error: "Unauthorised" });
  const { chatId, messageId } = req.body;
  if (!chatId || !messageId) return res.status(400).json({ error: "Missing chatId or messageId" });
  try {
    await fetch(`https://api.telegram.org/bot${TELEGRAM_TOKEN}/deleteMessage`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ chat_id: chatId, message_id: messageId }),
    });
  } catch (e) {
    console.error("delete-telegram error:", e);
  }
  res.json({ ok: true });
});

// Send an image (by public URL) to the youth's Telegram chat and record it as a
// worker message so it shows in the app too. Stores telegram_message_id so the
// photo can also be deleted from both ends later.
app.post("/send-photo", async function (req, res) {
  if (req.headers["x-api-key"] !== API_KEY) return res.status(401).json({ error: "Unauthorised" });
  const { chatId, imageUrl, workerName } = req.body;
  if (!chatId || !imageUrl) return res.status(400).json({ error: "Missing chatId or imageUrl" });

  let tgId = null;
  try {
    const tg = await fetch(`https://api.telegram.org/bot${TELEGRAM_TOKEN}/sendPhoto`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        chat_id: chatId,
        photo: imageUrl,
        caption: workerName ? workerName + " sent a photo" : undefined,
      }),
    });
    const data = await tg.json().catch(function () { return null; });
    tgId = data?.result?.message_id || null;
  } catch (e) {
    console.error("send-photo telegram error:", e);
  }

  const row = {
    chat_id: chatId,
    role: "assistant",
    content: "[Worker " + (workerName || "Worker") + "]: ",
    image_url: imageUrl,
  };
  if (tgId) row.telegram_message_id = tgId;
  await supabase("POST", "messages", row);
  await supabase("PATCH", `conversations?chat_id=eq.${chatId}`, {
    last_message: "📷 Photo",
    last_message_time: new Date().toISOString(),
  });

  res.json({ ok: true });
});

app.post("/handover-intro", async function (req, res) {
  if (req.headers["x-api-key"] !== API_KEY) return res.status(401).json({ error: "Unauthorised" });
  const { chatId, workerName } = req.body;
  if (!chatId || !workerName) return res.status(400).json({ error: "Missing chatId or workerName" });
  await sendHandoverIntro(chatId, workerName);
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

app.post("/debug-instagram", async function (req, res) {
  const { username } = req.body;
  const raw = await fetch(
    `https://instagram-scraper-stable-api.p.rapidapi.com/get_ig_user_posts.php`,
    {
      method: 'POST',
      headers: {
        'x-rapidapi-key': RAPIDAPI_KEY,
        'x-rapidapi-host': 'instagram-scraper-stable-api.p.rapidapi.com',
        'Content-Type': 'application/x-www-form-urlencoded',
      },
      body: `username_or_url=https://www.instagram.com/${encodeURIComponent(username)}/&amount=12`,
    }
  );
  const data = await raw.json();
  res.json(data);
});

app.post("/translate", async function (req, res) {
  if (req.headers["x-api-key"] !== API_KEY) return res.status(401).json({ error: "Unauthorised" });
  const { text } = req.body;
  if (!text) return res.status(400).json({ error: "Missing text" });
  // Youth's message → English for the worker. Routes through DeepL (great for
  // Chinese), falling back to Claude for languages DeepL can't handle.
  const translated = await detectAndTranslate(text, "English");
  res.json({ translated });
});

app.get("/", function (req, res) { res.json({ status: "Lantern bot running" }); });

const PORT = process.env.PORT || 3000;
app.listen(PORT, function () { console.log("Bot running on port " + PORT); });