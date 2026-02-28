# StreamFlow

A minimal RTMP-to-HLS streaming server with a management dashboard, viewer pages, credits system, and REST API. Built with [MediaMTX](https://github.com/bluenviron/mediamtx), Node.js/Express, and Docker.

| Protocol | Port | Purpose                              |
|----------|------|--------------------------------------|
| RTMP     | 1935 | Ingest (push from OBS, FFmpeg, etc.) |
| HLS      | 8888 | Playback (MediaMTX internal)         |
| HTTP     | 80   | Dashboard + viewer + management API  |

## Prerequisites

- [Docker](https://docs.docker.com/get-docker/) and Docker Compose
- [OBS Studio](https://obsproject.com/) (or any RTMP client) for streaming
- A modern browser (Chrome, Firefox, Edge, Safari)

## Directory Structure

```
streamflow/
├── app/
│   ├── index.js          # Express server — API + static file serving
│   └── package.json
├── html/
│   ├── index.html        # Admin dashboard
│   └── viewer.html       # Public viewer page
├── mediamtx.yml          # MediaMTX configuration
├── Dockerfile
├── docker-compose.yml
└── readme.md
```

## Running

```bash
docker compose up --build
```

The first run pulls the MediaMTX image and builds the Node.js container. Subsequent starts use cached layers.

**Background mode:**
```bash
docker compose up -d --build
```

**View logs:**
```bash
docker compose logs -f
```

**Stop:**
```bash
docker compose down
```

## Streaming with OBS

1. Open OBS → **Settings** → **Stream**
2. Set **Service** to `Custom`
3. Set **Server** to `rtmp://<your-host-ip>:1935/live`
4. Set **Stream Key** to any name (e.g. `test`)
5. Click **Start Streaming**

The stream will appear in the dashboard within a few seconds.

## Dashboard

Open `http://<your-host-ip>` in a browser.

- **Server status** — live uptime indicator in the header
- **Connect** — RTMP ingest URL and OBS setup steps
- **Active Streams** — live cards with thumbnail preview, codec, bitrate, and uptime; includes Watch and Disconnect controls
- **Credits** — balance display; deducted at 1 credit/min per active stream; zero balance disconnects all streams
- **Buy Credits** — simulated purchase flow (Starter 100 cr / Standard 500 cr / Pro 2000 cr); Apple Pay, Google Pay, and Bitcoin buttons are placeholders
- **Settings** — view, copy, save, or regenerate the API token (stored in browser localStorage)

The default API token is `streamflow-dev-token`. Change it by setting `STREAM_API_TOKEN` in `docker-compose.yml`.

## Viewer Page

Each stream has a shareable public viewer URL:

```
http://<host>/viewer.html?stream=live%2F<stream-key>
```

The viewer page includes:

- **HLS player** — powered by hls.js, loads automatically when the stream is live
- **Info bar** — resolution, codec, bitrate, uptime, ping, and credit balance
- **Share** — copies the viewer URL to clipboard
- **Embed** — generates an iframe snippet for embedding the player on another site
- **Chat** — live chat panel (simulated in this prototype)
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
Check if a specific stream is live. `:name` is the stream path (e.g. `live%2Ftest`).

```bash
curl http://localhost/api/streams/live%2Ftest/live
# {"live":true,"credits":97,"tracks":[...],"bitrateKbps":2840,"uptime":34}
# {"live":false,"credits":97}   ← when offline
```

### Authenticated endpoints

Include `Authorization: Bearer <token>` on all requests below.

#### `GET /api/streams`
List all active publish sessions with codec and bitrate info.

```bash
curl -H "Authorization: Bearer streamflow-dev-token" http://localhost/api/streams
# {"streams":[{"name":"live/test","uptime":17,"tracks":[...],"bitrateKbps":2840}]}
```

#### `DELETE /api/streams/:name`
Disconnect a stream. The name must be URL-encoded (e.g. `live%2Ftest`).

```bash
curl -X DELETE \
  -H "Authorization: Bearer streamflow-dev-token" \
  http://localhost/api/streams/live%2Ftest
# {"success":true}
```

#### `POST /api/credits/purchase`
Add credits (simulated purchase). Body: `{"package":"starter"|"standard"|"pro"}`.

```bash
curl -X POST \
  -H "Authorization: Bearer streamflow-dev-token" \
  -H "Content-Type: application/json" \
  -d '{"package":"starter"}' \
  http://localhost/api/credits/purchase
# {"credits":197,"added":100}
```

#### `POST /api/token/regenerate`
Rotate the API token. The response contains the new token — copy it to dashboard Settings before the page refreshes.

```bash
curl -X POST \
  -H "Authorization: Bearer streamflow-dev-token" \
  http://localhost/api/token/regenerate
# {"token":"sf_Xk9..."}
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

**HLS returns 404 right after stream starts**
MediaMTX needs a few seconds to write the first HLS segments. Wait 3–5 seconds and retry.

**Stream freezes in the player**
Ensure port `8888` is reachable from your browser's host. If running on a remote machine, open the port in the firewall.

**Credits hit zero — stream disconnected**
Purchase more credits from the dashboard Buy Credits section, then restart the stream from OBS.

**Applying code changes**

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

HTML files (`html/`) are volume-mounted and served directly — a browser refresh picks up changes immediately with no container restart needed.
