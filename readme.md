# StreamFlow

A minimal RTMP-to-HLS streaming server with a management dashboard, viewer pages, credits system, and REST API. Built with [MediaMTX](https://github.com/bluenviron/mediamtx), Node.js/Express, and Docker.

> **Prototype status:** This is a Phase 1 MVP. Credits and session balances persist in Postgres, while payments/chat/viewer counts remain simulated placeholders. See [Known Limitations](#known-limitations) for details.

| Protocol | Port | Purpose |
|----------|------|---------|
| RTMP | 1935 | Ingest (push from OBS, FFmpeg, etc.) |
| HLS | 8888 | Playback (served by MediaMTX) |
| HTTP | 80 | Dashboard + viewer + management API |

## Quick Start

```bash
git clone <your-repo-url> streamflow
cd streamflow
cp .env.example .env
# Edit .env — set STREAM_API_TOKEN and DATABASE_URL (Supabase Postgres)
docker compose run --rm app npm run db:migrate
docker compose up --build -d
```

Open `http://localhost` in a browser. Go to **Settings**, paste your `STREAM_API_TOKEN` value, and click **Save**.

If you didn't set a token in `.env`, check the logs for the auto-generated one:

```bash
docker compose logs app | grep token
```

## Prerequisites

- [Docker](https://docs.docker.com/get-docker/) Engine 24+ with Docker Compose v2
- [OBS Studio](https://obsproject.com/) (or any RTMP client) for streaming
- A modern browser (Chrome, Firefox, Edge, Safari)
- A Postgres database URL (Supabase recommended)

## Directory Structure

```
streamflow/
├── app/
│   ├── index.js          # Express server — API, SSE, credits, security
│   └── package.json
├── html/
│   ├── index.html        # Admin dashboard (SPA)
│   └── viewer.html       # Public viewer page
├── docs/
│   ├── DEPLOYMENT.md     # Self-hosting & production guide
│   └── CUSTOMIZATION.md  # Adapting ports, branding, credits, HLS
├── mediamtx.yml          # MediaMTX configuration
├── Dockerfile
├── docker-compose.yml
├── .env.example          # Environment variable template
└── readme.md
```

## Running

```bash
docker compose up --build        # foreground (first run)
docker compose up -d --build     # background
docker compose logs -f           # view logs
docker compose down              # stop
```

## Database Setup

StreamFlow now requires Postgres persistence for sessions and credits.

1. Set `DATABASE_URL` in `.env` (Supabase Postgres URL).
2. Apply migrations:

```bash
docker compose run --rm app npm run db:migrate
```

3. Start services:

```bash
docker compose up --build -d
```

## Streaming with OBS

1. Open the dashboard (`/`) and go to **Connect**.
2. Enter a stream key (3-64 chars, letters/numbers/`_`/`-`).
3. Copy **RTMP Server** and the generated **Secure OBS Stream Key**.
4. Open OBS -> **Settings** -> **Stream** and set **Service** to `Custom`.
5. Paste the generated server/key values and click **Start Streaming**.

Publish is now strict and session-bound: tampered or invalid stream paths/keys are rejected before ingest starts.

## Dashboard

Open `http://<your-host-ip>` in a browser.

- **Server status** — live uptime indicator in the header
- **Connect** — RTMP ingest URL and OBS setup steps
- **Connect diagnostics** — path validity, discovery state, quality, codec, bitrate, uptime, and secure-key quick actions
- **Active Streams** — live cards with codec, bitrate, and uptime; includes Watch and Disconnect controls
- **Public Active Streams** — `/live.html` public listing with watch links
- **Credits** — balance display; deducted at 1 credit/min per active stream; zero balance disconnects all streams
- **Buy Credits** — simulated purchase flow (Starter 100 cr / Standard 500 cr / Pro 2000 cr). Payment methods are placeholders.
- **Settings** — view, copy, save, or regenerate the API token (stored in browser localStorage)

The dashboard uses Server-Sent Events (SSE) for real-time updates — no polling.

## Viewer Page

Each stream has a shareable public viewer URL:

```
http://<host>/viewer.html?stream=s%2F<session-id>%2F<stream-key>
```

The viewer page includes:

- **HLS player** — powered by hls.js, loads automatically when the stream is live
- **Info bar** — resolution, codec, bitrate, uptime, ping, and credit balance
- **Share** — copies the viewer URL to clipboard
- **Embed** — generates an iframe snippet for embedding on another site
- **Chat** — chat panel (simulated in this prototype — no real backend)
- **Viewer count** — simulated (random number, not real connection tracking)
- **Offline overlay** — displayed when the stream ends or credits run out

## HLS Playback

HLS playlists are served by MediaMTX at:

```
http://<host>:8888/s/<session-id>/<stream-key>/index.m3u8
```

Play in any HLS-capable player (VLC, ffplay, Safari, or via the dashboard/viewer).

## REST API

All endpoints are on port 80. Protected endpoints require a Bearer token.

### Public endpoints

#### `GET /api/status`

Server health check.

```bash
curl http://localhost/api/status
# {"status":"ok","uptime":42}
```

#### `GET /api/credits`

Current credit balance.

```bash
curl http://localhost/api/credits
# {"credits":97}
```

#### `POST /api/credits/redeem`

Redeem a promo code. Promo definitions and usage are persisted in Postgres.

- A promo code is globally single-use (first successful redemption wins).

```bash
curl -X POST \
  -H "Content-Type: application/json" \
  -d '{"code":"FLOW26"}' \
  http://localhost/api/credits/redeem
# {"credits":200,"added":200,"token":"sf_...","prefix":"s/0123456789abcdef/"}
```

#### `GET /api/streams/:name/live`

Check if a specific stream is live. `:name` is the URL-encoded strict stream path (e.g. `s%2F0123456789abcdef%2Fstream_1`).

```bash
curl http://localhost/api/streams/s%2F0123456789abcdef%2Fstream_1/live
# {"live":true,"credits":97,"tracks":[...],"bitrateKbps":2840,"quality":"good","uptime":34}
# {"live":false,"credits":97,"quality":"unknown"}   <- when offline
```

### Authenticated endpoints

Include `Authorization: Bearer <your-token>` on all requests below.

#### `GET /api/streams`

List all active publish sessions with codec, bitrate, and quality.

```bash
curl -H "Authorization: Bearer <your-token>" http://localhost/api/streams
# {"streams":[{"name":"s/0123456789abcdef/stream_1","uptime":17,"tracks":[...],"bitrateKbps":2840,"quality":"good"}]}
```

#### `POST /api/publish/prepare`

Create a signed, short-lived publish credential for OBS/WHIP.

```bash
curl -X POST \
  -H "Authorization: Bearer <your-token>" \
  -H "Content-Type: application/json" \
  -d '{"streamKey":"stream_1","browserId":"b_local"}' \
  http://localhost/api/publish/prepare
# {"streamPath":"s/0123456789abcdef/stream_1","obsServer":"rtmp://localhost:1935","obsStreamKey":"s/0123456789abcdef/stream_1?pt=...","expiresAt":...}
```

#### `DELETE /api/streams/:name`

Disconnect a stream. The name must be URL-encoded strict path (e.g. `s%2F0123456789abcdef%2Fstream_1`).

```bash
curl -X DELETE \
  -H "Authorization: Bearer <your-token>" \
  http://localhost/api/streams/s%2F0123456789abcdef%2Fstream_1
# {"success":true}
```

#### `POST /api/credits/purchase`

Add credits (simulated purchase). Body: `{"package":"starter"|"standard"|"pro"}`.

```bash
curl -X POST \
  -H "Authorization: Bearer <your-token>" \
  -H "Content-Type: application/json" \
  -d '{"package":"starter"}' \
  http://localhost/api/credits/purchase
# {"credits":197,"added":100}
```

#### `POST /api/token/regenerate`

Rotate the current **session token**. The old session token stops working immediately.

```bash
curl -X POST \
  -H "Authorization: Bearer <your-token>" \
  http://localhost/api/token/regenerate
# {"token":"sf_Xk9..."}
```

#### `GET /api/credits/history?limit=50`

Read credit ledger events (purchase/redeem/burn). Session tokens see their own events; super-admin token sees all events.

```bash
curl -H "Authorization: Bearer <your-token>" \
  "http://localhost/api/credits/history?limit=20"
# {"entries":[{"id":42,"sessionId":"0123456789abcdef","eventType":"burn","delta":-1,"balanceAfter":97,"meta":{"activeStreams":1},"createdAt":"2026-03-04T09:10:00.000Z"}]}
```

### SSE endpoints (real-time)

These are Server-Sent Events streams, not request/response endpoints. Connect with `EventSource` in the browser or `curl` for debugging.

#### `GET /api/events?token=<your-token>`

Admin SSE stream. Requires the API token as a query parameter (EventSource doesn't support custom headers). Pushes a JSON message every 3 seconds with:

```json
{"streams":[...],"credits":97,"status":"ok","uptime":42}
```

```bash
curl -N "http://localhost/api/events?token=<your-token>"
```

#### `GET /api/events/live/:name`

Public SSE stream scoped to a single stream path. No auth required. Pushes status updates every 3 seconds:

```json
{"live":true,"credits":97,"tracks":[...],"bitrateKbps":2840,"quality":"good","uptime":34}
```

```bash
curl -N "http://localhost/api/events/live/s%2F0123456789abcdef%2Fstream_1"
```

#### `GET /api/events/public`

Public stream listing feed used by `/live.html`.

```json
{"streams":[{"name":"s/0123456789abcdef/stream_1","uptime":34,"tracks":[...],"bitrateKbps":2840,"quality":"good"}],"status":"ok","uptime":42}
```

```bash
curl -N "http://localhost/api/events/public"
```

## Troubleshooting

**Port already in use**

```bash
sudo ss -tlnp | grep -E ':80|:1935|:8888'
```

Stop the conflicting process or change the host port in `docker-compose.yml`.

**OBS connects but stream doesn't appear in the dashboard**

- Confirm OBS is using the generated **Secure OBS Stream Key** (contains `?pt=...`)
- Confirm the dashboard stream key matches `^[A-Za-z0-9_-]{3,64}$`
- Check `docker compose logs app` and `docker compose logs mediamtx` for auth rejections

**Dashboard shows "Invalid API token"**

- Check `docker compose logs app | grep token` for the current token
- Paste it into dashboard Settings -> Save

**HLS returns 404 right after stream starts**

MediaMTX needs a few seconds to write the first HLS segments. Wait 3-5 seconds and retry.

**Stream freezes in the player**

Ensure port 8888 is reachable from your browser's host. If running on a remote machine, open the port in the firewall.

**SSE not connecting / dashboard data not updating**

- If behind nginx/Caddy, ensure `proxy_buffering off` (nginx) or `flush_interval -1` (Caddy) is set. See [Deployment Guide](docs/DEPLOYMENT.md).
- Check that the token in Settings matches the server token

**Credits hit zero — stream disconnected**

Purchase more credits from the dashboard Buy Credits section, then restart the stream from OBS.

## Development Workflow

After editing `app/index.js`:

```bash
docker compose restart app
```

After editing `mediamtx.yml`:

```bash
docker compose restart mediamtx
```

After editing `app/package.json`:

```bash
docker compose up --build
```

HTML files (`html/`) are volume-mounted — a browser refresh picks up changes immediately with no container restart.

## Known Limitations

| Limitation | Notes |
|------------|-------|
| Payment is simulated | No real payment processing |
| Chat is simulated | Messages are randomly generated, not real |
| Viewer count is simulated | "N watching" is a random number |
| Token in localStorage | Accessible to any JS running on the page |
| CSP uses `unsafe-inline` | Required for inline scripts in the current HTML architecture |

## Further Reading

- [Deployment Guide](docs/DEPLOYMENT.md) — self-hosting, reverse proxy (nginx/Caddy), TLS, RTMP auth, health checks, firewall, logging
- [Customization Guide](docs/CUSTOMIZATION.md) — changing ports, branding, credits, HLS tuning, stream paths, embedding
