# StreamFlow

A minimal RTMP-to-HLS streaming server with a management dashboard, viewer pages, credits system, and REST API. Built with [MediaMTX](https://github.com/bluenviron/mediamtx), Node.js/Express, and Docker.

> **Prototype status:** This is a Phase 1 MVP. Credits are in-memory (reset on restart), payments are simulated, and chat/viewer counts are placeholders. See [Known Limitations](#known-limitations) for details.

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
# Edit .env — set STREAM_API_TOKEN (generate one: openssl rand -base64 28)
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

## Streaming with OBS

1. Open OBS -> **Settings** -> **Stream**
2. Set **Service** to `Custom`
3. Set **Server** to `rtmp://<your-host-ip>:1935/live`
4. Set **Stream Key** to any name (e.g. `test`)
5. Click **Start Streaming**

The stream will appear in the dashboard within a few seconds.

**With RTMP publish auth enabled** (see [Deployment Guide](docs/DEPLOYMENT.md#enabling-rtmp-publish-authentication)):

| Setting | Value |
|---------|-------|
| Server | `rtmp://<your-host>:1935/live` |
| Stream Key | any name (e.g. `test`) |
| Authentication -> Username | `stream` |
| Authentication -> Password | your `RTMP_PUBLISH_KEY` value |

## Dashboard

Open `http://<your-host-ip>` in a browser.

- **Server status** — live uptime indicator in the header
- **Connect** — RTMP ingest URL and OBS setup steps
- **Active Streams** — live cards with codec, bitrate, and uptime; includes Watch and Disconnect controls
- **Credits** — balance display; deducted at 1 credit/min per active stream; zero balance disconnects all streams
- **Buy Credits** — simulated purchase flow (Starter 100 cr / Standard 500 cr / Pro 2000 cr). Payment methods are placeholders.
- **Settings** — view, copy, save, or regenerate the API token (stored in browser localStorage)

The dashboard uses Server-Sent Events (SSE) for real-time updates — no polling.

## Viewer Page

Each stream has a shareable public viewer URL:

```
http://<host>/viewer.html?stream=live%2F<stream-key>
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
http://<host>:8888/live/<stream-key>/index.m3u8
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

#### `GET /api/streams/:name/live`

Check if a specific stream is live. `:name` is the URL-encoded stream path (e.g. `live%2Ftest`).

```bash
curl http://localhost/api/streams/live%2Ftest/live
# {"live":true,"credits":97,"tracks":[...],"bitrateKbps":2840,"uptime":34}
# {"live":false,"credits":97}   <- when offline
```

### Authenticated endpoints

Include `Authorization: Bearer <your-token>` on all requests below.

#### `GET /api/streams`

List all active publish sessions with codec and bitrate info.

```bash
curl -H "Authorization: Bearer <your-token>" http://localhost/api/streams
# {"streams":[{"name":"live/test","uptime":17,"tracks":[...],"bitrateKbps":2840}]}
```

#### `DELETE /api/streams/:name`

Disconnect a stream. The name must be URL-encoded (e.g. `live%2Ftest`).

```bash
curl -X DELETE \
  -H "Authorization: Bearer <your-token>" \
  http://localhost/api/streams/live%2Ftest
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

Rotate the API token. The response contains the new token — update your `.env` and dashboard Settings.

```bash
curl -X POST \
  -H "Authorization: Bearer <your-token>" \
  http://localhost/api/token/regenerate
# {"token":"sf_Xk9..."}
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
{"live":true,"credits":97,"tracks":[...],"bitrateKbps":2840,"uptime":34}
```

```bash
curl -N "http://localhost/api/events/live/live%2Ftest"
```

## Troubleshooting

**Port already in use**

```bash
sudo ss -tlnp | grep -E ':80|:1935|:8888'
```

Stop the conflicting process or change the host port in `docker-compose.yml`.

**OBS connects but stream doesn't appear in the dashboard**

- Confirm OBS shows "Live" status (not just connected)
- Check `docker compose logs mediamtx` for RTMP errors
- The stream key in the dashboard will be shown as `live/<your-key>`

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
| Credits are in-memory | Balance resets to 100 on container restart |
| Payment is simulated | No real payment processing |
| Chat is simulated | Messages are randomly generated, not real |
| Viewer count is simulated | "N watching" is a random number |
| Token in localStorage | Accessible to any JS running on the page |
| CSP uses `unsafe-inline` | Required for inline scripts in the current HTML architecture |

## Further Reading

- [Deployment Guide](docs/DEPLOYMENT.md) — self-hosting, reverse proxy (nginx/Caddy), TLS, RTMP auth, health checks, firewall, logging
- [Customization Guide](docs/CUSTOMIZATION.md) — changing ports, branding, credits, HLS tuning, stream paths, embedding
