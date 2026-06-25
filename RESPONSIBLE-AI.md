# Lantern — Data Handling & Responsible AI

Youth mental‑health data is the most sensitive category we handle. We run on
three principles: **minimize, protect, keep humans in control.**

## How data is stored
- **Managed Postgres (Supabase)** — encrypted at rest, TLS in transit.
- **Row‑Level Security:** every youth/staff table is locked to **authenticated
  SCS workers**. The app's public key alone **cannot** read youth data; the bot
  writes through a **server‑only service key** that never ships to clients.
- **Edge:** Cloudflare Tunnel terminates HTTPS and hides the origin — **no
  inbound ports opened**.

## How data is used (purpose limitation)
- Used **only** to support that youth: triage, worker continuity, translation.
- **Never** sold, shared, or used for advertising.

## How the AI uses data — and its boundary
- The model sees the conversation to **keep the youth company, assess risk, and
  summarize for the worker**.
- It **never diagnoses, never gives clinical advice, never makes care decisions.**
- On any crisis it **stops and routes to a human** + the SOS hotline (verified:
  100% recall / 100% precision on our crisis eval).
- **Providers don't train on our data:** Anthropic (chat/triage/summaries) and
  DeepL (translation) do **not** use API data to train models. Youth data never
  improves an external model.
- **MBTI is a soft, assistive signal — not a clinical assessment**; risk/mood
  scores are decision support for a human, not verdicts.

## Youth‑facing ethics
- A first‑contact notice tells the youth they're chatting with an AI, that a real
  caring person will see the conversation, and that it's confidential.
- Info asks (e.g. Instagram) are **optional, low‑pressure, and skipped during a
  crisis**; declining is respected and never re‑asked.

## Retention & rights (policy)
- **Retention:** conversation data kept only as long as needed to support the
  case; closed/inactive cases purged on a schedule (see
  `reachout-fresh/supabase-retention.sql`).
- **Right to deletion / access:** a youth can request deletion (right to be
  forgotten) and access — aligned with **Singapore PDPA**.
- **Access control & accountability:** staff access is authenticated; roadmap:
  per‑case scoping + audit logging of who viewed/changed what.

## Compliance posture
- **PDPA (Singapore):** lawful basis, purpose limitation, retention limits,
  access/correction/deletion rights; a **DPIA** is recommended for this sensitive
  minor data, and the Supabase region should be set to Singapore for residency.

## Honest roadmap (what we'd harden next)
Explicit consent capture + audit logs, per‑case RLS scoping, durable retention
automation, periodic bias/safety review across languages, and a formal DPIA.
