# StreamFlow

A minimal RTMP-to-HLS streaming server with a management dashboard and REST API. Built with [MediaMTX](https://github.com/bluenviron/mediamtx), Node.js/Express, and Docker.

| Protocol | Port | Purpose                              |
|----------|------|--------------------------------------|
| RTMP     | 1935 | Ingest (push from OBS, FFmpeg, etc.) |
| HLS      | 8888 | Playback                             |
| HTTP     | 80   | Dashboard + management API           |

## Prerequisites

- [Docker](https://docs.docker.com/get-docker/) and Docker Compose
- [OBS Studio](https://obsproject.com/) (or any RTMP client) for streaming
- A modern browser (Chrome, Firefox, Edge, Safari)

## Directory Structure

```
streamflow/
├── app/
│   ├── index.js          # Express server (dashboard + management API)
│   ├── package.json
│   └── media/            # Dashboard assets (auto-created, gitignored)
├── html/
│   └── index.html        # Dashboard
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

## Dashboard

Open `http://<your-host-ip>` in a browser. The dashboard shows:

- **Server status** — live uptime indicator
- **Connect** — RTMP URL and OBS setup steps
- **Active Streams** — live cards with HLS URLs, a built-in viewer, and disconnect controls
- **Settings** — API token (stored in your browser's localStorage)

The default API token is `streamflow-dev-token`. Change it by setting `STREAM_API_TOKEN` in `docker-compose.yml`.

## HLS Playback

HLS playlists are served by MediaMTX at:
```
http://<host>:8888/live/<stream-key>/index.m3u8
```

Play in any HLS-capable player (VLC, ffplay, Safari, or the built-in dashboard viewer).

## REST API

All endpoints are on port 80. Authentication uses a Bearer token header.

### `GET /api/status`
Public. Returns server health.

```bash
curl http://localhost/api/status
# {"status":"ok","uptime":42}
```

### `GET /api/streams`
Auth required. Returns active publish sessions.

```bash
curl -H "Authorization: Bearer streamflow-dev-token" http://localhost/api/streams
# {"streams":[{"name":"live/test","uptime":17}]}
```

### `DELETE /api/streams/:name`
Auth required. Disconnects a stream. The name must be URL-encoded (e.g. `live%2Ftest`).

```bash
curl -X DELETE \
  -H "Authorization: Bearer streamflow-dev-token" \
  http://localhost/api/streams/live%2Ftest
# {"success":true}
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
- The stream key in the dashboard path will be `live/<your-key>`

**HLS returns 404 right after stream starts**
MediaMTX needs a few seconds to write the first HLS segments. Wait 3–5 seconds and retry.

**Stream freezes in the player**
Ensure port `8888` is reachable from your browser's host. If on a remote machine, open it in the firewall.

**Applying changes**

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
