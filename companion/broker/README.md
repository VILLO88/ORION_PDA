# Orion ↔ Notion OAuth broker

Tiny **stateless** HTTPS service (2 endpoints, no database) that lets the
distributed Orion Companion desktop app connect each user's own Notion **without
ever shipping the Notion `client_secret`** inside the app.

```
Desktop app ──opens browser──▶ Notion login + page picker
Notion ──redirect ?code──▶  THIS BROKER /api/callback   (has client_secret)
broker ──code→token (server-side)──▶ Notion token endpoint
broker ──302 http://127.0.0.1:<port>/cb?payload=…──▶ app loopback (token over localhost only)
```

The user's access token is then stored **encrypted on their own machine**
(Electron `safeStorage`). The broker keeps **nothing**.

## Endpoints

- `GET /api/callback` — Notion's redirect target. Validates `state` (which carries
  the app's loopback `{nonce, port}`), exchanges `code` → token, and 302-redirects
  the browser back to `http://127.0.0.1:<port>/cb`. Only ever redirects to
  `127.0.0.1` (no open-redirect).
- `POST /api/refresh` — body `{ "refresh_token": "..." }` → returns a fresh token
  JSON. Used by the app when an access token expires.

Neither endpoint logs `code` or tokens.

## One-time setup (developer)

1. **Create a Notion public integration** at <https://www.notion.so/my-integrations>:
   - Type: **Public**.
   - Capabilities: read + insert + update content.
   - OAuth **Redirect URI**: `https://<your-broker-domain>/api/callback`
     (must match `NOTION_REDIRECT_URI` below, exactly).
   - Copy the **OAuth client ID** and **client secret**.

2. **Deploy the broker.** Two ready-made variants are included — pick one.

### A) Cloudflare Workers (recommended — `broker/worker/`)

Zero-dependency Worker, free, edge, no cold start.

```bash
cd broker/worker
# edit wrangler.toml: set NOTION_CLIENT_ID and (after first deploy) NOTION_REDIRECT_URI
npx wrangler deploy
npx wrangler secret put NOTION_CLIENT_SECRET   # paste the secret — Worker only
```

First deploy prints the Worker URL (e.g. `https://orion-notion-broker.<you>.workers.dev`).
Set `NOTION_REDIRECT_URI` in `wrangler.toml` to `…/callback` of that URL, redeploy,
and register that exact `…/callback` URL as the integration's Redirect URI.

Routes are `/callback` and `/refresh` (no `/api` prefix).

### B) Vercel (`broker/api/`)

```bash
cd broker
vercel deploy --prod
```
Set env (Vercel dashboard or `vercel env`):
```
NOTION_CLIENT_ID=<oauth client id>
NOTION_CLIENT_SECRET=<oauth client secret>     # secret — broker only
NOTION_REDIRECT_URI=https://<your-broker-domain>/api/callback
NOTION_VERSION=2022-06-28                       # verify current value in Notion docs
```
Routes are `/api/callback` and `/api/refresh`.

3. **Point the app at the broker** — in `src/main/ipc/notion/config.ts`:
   ```ts
   export const CLIENT_ID = "<oauth client id>";   // public, safe to ship
   // Cloudflare Worker:
   export const BROKER_BASE_URL = "https://orion-notion-broker.<you>.workers.dev";
   // …or Vercel: "https://<your-broker-domain>/api"
   ```
   The app calls `${BROKER_BASE_URL}/callback` and `${BROKER_BASE_URL}/refresh`, so
   point `BROKER_BASE_URL` at the Worker root (Cloudflare) or the `/api` base (Vercel).
   In dev you can instead export `NOTION_OAUTH_CLIENT_ID` / `NOTION_BROKER_URL` env vars.

## Local dev

Notion requires an **HTTPS** redirect URI. With Cloudflare, `npx wrangler dev` plus a
quick tunnel (or just deploy a preview) gives you HTTPS. With Vercel, `vercel dev`
behind `cloudflared tunnel --url http://localhost:3000`. Use the HTTPS URL as both
`NOTION_REDIRECT_URI` and the integration's Redirect URI.

## Security checklist

- `client_secret` is set **only** in the broker env, never committed, never in the app.
- `/api/callback` redirects exclusively to `http://127.0.0.1:<port>`.
- `state` is validated (`nonce` hex, `port` in 1024–65535) before use.
- No token or `code` is ever logged.
