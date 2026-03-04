# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What This Project Is

StreamFlow is a minimal RTMP-to-HLS streaming server with a management dashboard, credits system, and REST API. It wraps [MediaMTX](https://github.com/bluenviron/mediamtx) as the media engine and exposes an Express.js management layer on top.

**This is a Phase 1 prototype.** Credits are persisted in Postgres, PayPal checkout is used for credit purchases when configured, and chat/viewer counts are still fake. See "Known Prototype Limitations" in `readme.md`.

## Running the Project

```bash
make setup   # first time: generates .env, detects LAN IP, configures firewall
make up      # build + start (detached)
make logs    # follow all logs; make logs s=app for one service
make status  # container status + API token for dashboard login
make down    # stop
make restart s=app  # restart one service after editing backend files
```

**After code changes:**
- `app/*.js` or `app/routes/*.js` → `make restart s=app`
- `mediamtx.yml` → `make restart s=mediamtx`
- `app/package.json` → `make up` (rebuild)
- `html/*.html`, `html/css/*.css`, `html/js/*.js` → browser refresh (volume-mounted in dev, no restart needed)

There are no automated tests or linting commands in this project.

## Architecture

Two Docker services communicate internally:

```
OBS/ffmpeg ──RTMP:1935──► mediamtx ──internal:9997──► app (Express)
Browser ◄──HLS:8888────── mediamtx                     │
Browser ◄──HTTP:80──────────────────────────────────── app
```

- **mediamtx** (`bluenviron/mediamtx:latest-ffmpeg`) handles all media: RTMP ingest on `:1935`, HLS output on `:8888`, and an internal REST API on `:9997` (never exposed externally).
- **app** (modular Express backend under `app/`) proxies the MediaMTX API, manages sessions/credits/tokens, and serves the static frontend. It communicates with MediaMTX via `http://mediamtx:9997`.

### `app/` backend modules

The backend is split by responsibility:

- `index.js` — thin entrypoint: middleware, static serving, route mounting, and background interval startup.
- `config.js` — env/config constants, validation helpers, credit packages, promo code metadata.
- `sessions.js` — in-memory sessions map + create/find/regenerate + idle cleanup interval.
- `auth.js` — super token handling, HMAC publish token signing/verification, auth middleware.
- `mediamtx.js` — MediaMTX fetch helpers (`getPublishers`, `getPathInfo`, `kickUrl`).
- `streams.js` — stream descriptors, bitrate computation, quality classification, visibility set.
- `credits.js` — per-minute credit deduction and forced disconnect when credits hit zero.
- `sse.js` — SSE client registries, payload builders, server resource snapshot, 3s broadcast loop.
- `routes/public.js` — status/credits/public stream endpoints and promo redemption.
- `routes/admin.js` — authenticated admin endpoints (prepare publish, list/kick/toggle, purchase, regenerate token).
- `routes/events.js` — SSE endpoints for admin/public/viewer clients.
- `routes/internal.js` — MediaMTX publish auth callback endpoint.

### `html/` (static frontend)

- `index.html`, `viewer.html`, `live.html` — HTML shells.
- `css/common.css` + page CSS (`dashboard.css`, `viewer.css`, `live.css`) — extracted external stylesheets.
- `js/common.js` + page JS (`dashboard.js`, `viewer.js`, `live.js`) — extracted external scripts.
- `index.html` (dashboard) connects to `/api/events?token=...` SSE for real-time stream/credit data. Token is stored in `localStorage`.
- `viewer.html` connects to `/api/events/live/:name` SSE and uses hls.js (CDN) for HLS playback.
- `live.html` connects to `/api/events/public` SSE and renders the listed live stream directory.

All frontend files are volume-mounted in Docker — edits take effect on browser refresh.

### `mediamtx.yml` / `mediamtx.prod.yml`

`mediamtx.yml` — dev/LAN config, open RTMP publish (anyone can stream). `mediamtx.prod.yml` — production config, RTMP locked to `user: stream` authenticated with `${RTMP_PUBLISH_KEY}`. The prod compose override mounts `mediamtx.prod.yml` in place of the dev one.

### Deployment configs

- `docker-compose.prod.yml` — compose override for production: swaps the mediamtx config, removes dev volume mounts, uses GHCR image (`ghcr.io/${GITHUB_REPOSITORY}:${IMAGE_TAG:-latest}`), adds log rotation. Requires Docker Compose ≥ 2.24 for `!reset` syntax. Always used as: `docker compose -f docker-compose.yml -f docker-compose.prod.yml`.
- `nginx/vps.conf` — nginx config for the VPS relay: TCP stream proxy for RTMP (:1935) and HLS (:8888), HTTPS reverse proxy for dashboard with SSE settings. Upstreams use Tailscale MagicDNS hostnames (placeholders substituted by `scripts/setup-vps.sh`).
- `scripts/setup.sh` — LAN first-time setup (generates secrets, detects IP, configures firewall).
- `scripts/setup-vps.sh` — VPS provisioning (installs nginx-full, certbot, Docker, Tailscale; deploys nginx config; gets TLS cert). Run once on a fresh Ubuntu 22.04+ VPS.

## Environment Variables

| Variable | Default | Purpose |
|----------|---------|---------|
| `STREAM_API_TOKEN` | auto-generated | Bearer token for API + SSE auth. Auto-generated and logged on startup if unset. |
| `RTMP_PUBLISH_KEY` | — | RTMP publish password (only active with `mediamtx.prod.yml`). |
| `PORT` | `80` | Express listen port. |
| `MEDIAMTX_API` | `http://mediamtx:9997` | Internal MediaMTX API URL. |
| `GITHUB_REPOSITORY` | — | Production only. `owner/repo` (lowercase). Used by `docker-compose.prod.yml` to reference the GHCR image. |
| `IMAGE_TAG` | `latest` | Production only. Set by GitHub Actions deploy workflow to `sha-<short-sha>`. |

Port **9997** must never be exposed to the internet (internal MediaMTX API, no auth).

## Key Design Decisions

- **SSE instead of polling**: The server-side broadcast loop pushes updates to all clients every 3s. This means N open browser tabs cost N persistent connections instead of N×(requests/min).
- **Modular backend**: Express logic is split across focused modules/routes while keeping vanilla Node + Express.
- **External frontend assets**: Inline `<style>`/`<script>` blocks were moved to `html/css` and `html/js`; CSP `script-src`/`style-src` no longer require `'unsafe-inline'`.
- **Rate limiting**: Applied only to mutation endpoints (`/api/token/*`, `/api/credits/purchase`) — not to SSE or read endpoints.
- **Reverse proxy SSE requirements**: nginx needs `proxy_buffering off` + `proxy_read_timeout 3600s`; Caddy needs `flush_interval -1`. Without these, SSE connections drop.
