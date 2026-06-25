# Lantern — architecture & design reasoning

Lantern is an after-hours / overflow companion for Singapore Children's Society
youth workers: a Telegram bot ("Buddy") keeps youths company and escalates
crises when no worker is available, and a worker app manages cases, handovers,
and team coordination.

## Components & why
| Component | Choice | Why |
|-----------|--------|-----|
| Youth chat | **Telegram Bot API** (webhook) | Youths already use it; zero install; webhooks are natively event-driven. |
| Bot runtime | **Node 20 Alpine, single stateless container** | Stateless → trivially restartable/scalable; small image; all state in Postgres. |
| AI | **Anthropic Claude Haiku 4.5** | Cheap + fast for high-volume per-message calls (chat, crisis, summary, MBTI); quality sufficient for companionship + triage. |
| Data | **Supabase (managed Postgres + REST + Storage + Auth)** | No DB ops; row-level security; auth out of the box; REST avoids a custom backend for the app. |
| Worker app | **Expo / React Native** | One codebase → iOS/Android/web; fast iteration. |
| Translation | **DeepL + Claude polish** | DeepL accuracy for SEA languages; Claude smooths phrasing. |
| Edge | **Cloudflare Tunnel** | HTTPS + hides origin, **no inbound ports opened** on the host — strong security posture for a home/edge origin. |
| Orchestration | **Kubernetes manifests + HPA** (scale-ready) | Documented scale-out path (2→10 pods @ 70% CPU, rolling deploys, health probes). |

## Deliberate trade-offs (honest)
- **Modular monolith, not microservices.** One bot service + managed DB is
  right-sized for the scope; premature decomposition would add ops cost with no
  benefit. The AI/analysis could be split out later if volume demands.
- **Live runtime today = single container behind the tunnel.** The k8s/HPA layer
  is a *prepared* scale-out path, not the current production hot path — presented
  as such, not claimed as live autoscaling.
- **Cost:** managed Supabase + Haiku + scale-to-need keep run cost low.

## Security & responsible AI
- **Crisis → human, always.** On suicidal/self-harm signals the bot replies only
  with the SOS hotline and escalates to a worker (Telegram + Twilio); it never
  counsels or diagnoses.
- **Data:** youth PII in Postgres; RLS locks tables to authenticated staff
  (app sends worker JWTs; bot uses a server-only service key). TLS via Cloudflare.
- **AI limits acknowledged:** MBTI is a *soft* matching signal, not clinical;
  crisis detection is assistive, not a guarantee; the bot defers to humans.
- **Privacy:** social-media asks are Instagram-focused, optional, and skipped
  during crisis; confidentiality is reassured to the youth.

## Known gaps / next
- Observability beyond `/health` + `/metrics` (add Prometheus/Grafana, tracing).
- Replace app polling with Supabase Realtime; move in-process `setTimeout`
  delayed tasks to a durable scheduler/queue (survives restarts).
- CI/CD: image build/push is automated (GitHub Actions); cluster rollout is
  currently operator-run (local kind).
