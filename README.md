# ReachOut Bot — Telegram Backend

This is the backend server that connects Telegram to the ReachOut dashboard.

## Environment variables (set these in Railway)

| Variable | Value |
|---|---|
| `TELEGRAM_BOT_TOKEN` | From @BotFather |
| `ANTHROPIC_API_KEY` | From console.anthropic.com |
| `DASHBOARD_API_KEY` | Make up any secret string e.g. `reachout-secret-2024` |

## API endpoints

| Endpoint | Method | Description |
|---|---|---|
| `/` | GET | Health check |
| `/webhook` | POST | Receives messages from Telegram |
| `/sessions` | GET | Returns all overnight sessions (requires x-api-key header) |
| `/reply` | POST | Sends a worker reply to a youth on Telegram |
| `/analyse` | POST | Runs AI analysis on all sessions |
