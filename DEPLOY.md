# Lantern bot — deployment (real topology)

## How traffic actually reaches the bot
```
Telegram / Lantern app
      │  HTTPS  →  bot.lanternscs.org
      ▼
Cloudflare  (TLS termination, DDoS, hides origin IP)
      │  Cloudflare Tunnel (token tunnel, no inbound ports opened)
      ▼
cloudflared  (Windows service "Cloudflared")  ── origin: http://localhost:3001
      ▼
kubectl port-forward :3001 → svc/reachout-bot-service:80   (kept alive by the keeper, below)
      ▼
Kubernetes pods (kind cluster "desktop", ns "reachout", deploy "reachout-bot")
      └─ image: clydelinhtet/reachout-bot:latest   (Node 20 Alpine, stateless)
```
The bot's API key (`DASHBOARD_API_KEY`) on the **k8s** pods is the key the app
uses. The `docker-compose` container on :3000 is a **decoy** (different key) — do
not deploy there.

## Deploy a new version
```bash
cd reachout-bot
docker build -t clydelinhtet/reachout-bot:latest .
docker push clydelinhtet/reachout-bot:latest
kubectl rollout restart deployment reachout-bot -n reachout
kubectl rollout status  deployment reachout-bot -n reachout
```
Verify it's live (new endpoints return 400 not 404; /health returns ok):
```bash
curl https://bot.lanternscs.org/health
```

## Keeping :3001 up (so the tunnel always has an origin)
`scripts/lantern-portforward.ps1` self-heals the port-forward. It auto-starts at
logon via a launcher in the Windows Startup folder
(`%APPDATA%\Microsoft\Windows\Start Menu\Programs\Startup\LanternBotPortForward.vbs`).
If the public URL ever 502s, that keeper (or the port-forward) has stopped —
start the script manually or re-run the launcher.

## Secrets (env)
On the k8s deployment (via `reachout-secrets`) / docker-compose `.env`:
`TELEGRAM_BOT_TOKEN`, `ANTHROPIC_API_KEY`, `SUPABASE_URL`, `SUPABASE_KEY`,
`SUPABASE_SERVICE_KEY` (server-only, bypasses RLS — set before enabling RLS),
`DASHBOARD_API_KEY`, `DEEPL_API_KEY`, `AUTO_REPLY_MINUTES` (optional),
Twilio + `RAPIDAPI_KEY`.

## Observability
- `GET /health` → liveness (uptime).
- `GET /metrics` → uptime, memory, node version, `db_ok`.
- Point a free uptime monitor (UptimeRobot/BetterStack) at
  `https://bot.lanternscs.org/health` → alerts on down/5xx.
