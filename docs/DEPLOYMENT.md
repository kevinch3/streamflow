# Deployment Guide

Self-hosting guide for StreamFlow. Covers first-time setup, production hardening, reverse proxy configuration, and ongoing operations.

---

## Prerequisites

- **Docker Engine** 24.x+ with **Docker Compose v2** (the `docker compose` plugin form)
- A Linux server (Ubuntu 22.04+, Debian 12+, Fedora 38+, or similar). macOS via Docker Desktop and Windows via WSL2 + Docker Desktop also work for development.
- Minimum hardware: **2 CPU cores, 1 GB RAM** (sufficient for 1-2 concurrent streams)
- Inbound ports to open: **1935** (RTMP), **8888** (HLS), **80** or **443** (dashboard)
- Port **9997** (MediaMTX internal API) must **never** be exposed to the internet

---

## First-Time Setup

### 1. Clone and configure

```bash
git clone <your-repo-url> streamflow
cd streamflow
cp .env.example .env
```

### 2. Edit `.env`

Open `.env` in your editor and set real values:

```bash
# Generate a strong API token (used to authenticate dashboard and API calls)
openssl rand -base64 28
# Example output: a1B2c3D4e5F6g7H8i9J0k1L2m3N4o5P6q7R=

# Generate MediaMTX callback secret
openssl rand -base64 21
# Example output: x9Y8z7W6v5U4t3S2r1Q0p

# Generate publish token signing secret
openssl rand -base64 21
# Example output: m8Q7n6P5w4A3s2D1f0Gh
```

Paste the generated values:

```
STREAM_API_TOKEN=a1B2c3D4e5F6g7H8i9J0k1L2m3N4o5P6q7R=
MEDIAMTX_AUTH_SECRET=x9Y8z7W6v5U4t3S2r1Q0p
PUBLISH_TOKEN_SECRET=m8Q7n6P5w4A3s2D1f0Gh
PORT=80
```

| Variable | Required | Purpose |
|----------|----------|---------|
| `STREAM_API_TOKEN` | Yes | Bearer token for authenticated API endpoints. If not set, a random token is generated at startup and printed to the logs. |
| `MEDIAMTX_AUTH_SECRET` | Yes | Shared secret used by MediaMTX when calling `POST /api/internal/mediamtx/auth`. |
| `PUBLISH_TOKEN_SECRET` | Yes | HMAC secret used by StreamFlow to sign short-lived publish tokens (`pt`). |
| `PORT` | No | Express listen port (default: 80). Change if running behind a reverse proxy on a non-standard port. |
| `MEDIAMTX_API` | No | MediaMTX REST API URL (default: `http://mediamtx:9997`). Only change if you rename the Docker service. |

### 3. Build and start

```bash
docker compose up --build -d
```

The first run pulls the MediaMTX image and builds the Node.js container.

### 4. Get the API token

If you set `STREAM_API_TOKEN` in `.env`, use that value. If you didn't, check the logs for the auto-generated token:

```bash
docker compose logs app | grep token
# [token] STREAM_API_TOKEN not set — generated ephemeral token: sf_Xk9...
```

### 5. Log into the dashboard

Open `http://<your-host-ip>` in a browser. Go to **Settings**, paste your API token, and click **Save**.

---

## Strict Publish Authorization (Default)

Publish authorization is now enforced through MediaMTX HTTP auth callback and signed publish tokens:

1. Dashboard calls `POST /api/publish/prepare` and gets `obsServer` + `obsStreamKey` (`... ?pt=<signed-token>`).
2. OBS/WHIP starts publishing with those credentials.
3. MediaMTX calls `POST /api/internal/mediamtx/auth`.
4. StreamFlow validates:
   - `action=publish`
   - strict path format `s/<session-id>/<stream-key>`
   - signed token integrity + expiry + path/session match
   - active owner session and credits > 0

Any invalid or tampered path/key/token is rejected before ingest starts.

---

## Deployment Without a Reverse Proxy

Suitable for LAN, homelab, or trusted-network deployments where TLS is not required.

### Firewall rules

**ufw (Ubuntu/Debian):**

```bash
sudo ufw allow 1935/tcp comment "RTMP ingest"
sudo ufw allow 8888/tcp comment "HLS playback"
sudo ufw allow 80/tcp   comment "StreamFlow dashboard"
sudo ufw deny 9997/tcp  comment "MediaMTX internal API — never expose"
```

**firewalld (Fedora/RHEL):**

```bash
sudo firewall-cmd --permanent --add-port=1935/tcp
sudo firewall-cmd --permanent --add-port=8888/tcp
sudo firewall-cmd --permanent --add-port=80/tcp
sudo firewall-cmd --reload
```

### Limitations

- No HTTPS — the API token travels in plaintext
- No TLS on HLS — stream content is unencrypted
- Not suitable for internet-facing deployments

---

## Deployment With nginx (Recommended)

nginx terminates TLS and proxies to the Express dashboard. This is the recommended setup for internet-facing deployments.

### Install nginx + certbot

```bash
# Ubuntu/Debian
sudo apt install nginx certbot python3-certbot-nginx

# Fedora/RHEL
sudo dnf install nginx certbot python3-certbot-nginx
```

### Obtain a certificate

```bash
sudo certbot --nginx -d your-domain.com
```

### nginx configuration

Save to `/etc/nginx/sites-available/streamflow` (or `/etc/nginx/conf.d/streamflow.conf`):

```nginx
server {
    listen 80;
    server_name your-domain.com;
    return 301 https://$host$request_uri;
}

server {
    listen 443 ssl http2;
    server_name your-domain.com;

    ssl_certificate     /etc/letsencrypt/live/your-domain.com/fullchain.pem;
    ssl_certificate_key /etc/letsencrypt/live/your-domain.com/privkey.pem;

    # Dashboard + API
    location / {
        proxy_pass         http://127.0.0.1:80;
        proxy_set_header   Host $host;
        proxy_set_header   X-Real-IP $remote_addr;
        proxy_set_header   X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header   X-Forwarded-Proto $scheme;

        # Required for SSE (Server-Sent Events)
        proxy_buffering    off;
        proxy_cache        off;
        proxy_read_timeout 3600s;
    }
}
```

Enable and reload:

```bash
sudo ln -s /etc/nginx/sites-available/streamflow /etc/nginx/sites-enabled/
sudo nginx -t && sudo systemctl reload nginx
```

### Important: SSE requires specific nginx settings

The dashboard uses Server-Sent Events for real-time updates. Without the following settings, SSE connections drop every 60 seconds (nginx's default proxy timeout):

```nginx
proxy_buffering    off;    # Don't buffer SSE responses
proxy_cache        off;    # Don't cache SSE streams
proxy_read_timeout 3600s;  # Keep SSE connections alive for 1 hour
```

### HLS port 8888

HLS is served directly by MediaMTX on port 8888, separate from the Express server. You have two options:

**Option A: Expose port 8888 directly** (simpler, but no TLS on HLS)

Open port 8888 in your firewall. The browser connects directly to `your-domain.com:8888` for HLS segments. This means stream playback is unencrypted even though the dashboard is behind HTTPS.

**Option B: Proxy HLS through nginx** (recommended for full TLS)

Add a second location block to your nginx config:

```nginx
    # HLS proxy (optional — for full TLS coverage)
    location /hls/ {
        proxy_pass http://127.0.0.1:8888/;
        proxy_set_header Host $host;
    }
```

Note: if you proxy HLS, the hardcoded `:8888` port in the HTML files will need to be changed. See [CUSTOMIZATION.md](CUSTOMIZATION.md#changing-ports) for details.

---

## Deployment With Caddy

Caddy provides the simplest HTTPS setup with automatic Let's Encrypt certificates.

### Install Caddy

```bash
# Ubuntu/Debian
sudo apt install -y debian-keyring debian-archive-keyring apt-transport-https
curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/gpg.key' | sudo gpg --dearmor -o /usr/share/keyrings/caddy-stable-archive-keyring.gpg
curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/debian.deb.txt' | sudo tee /etc/apt/sources.list.d/caddy-stable.list
sudo apt update && sudo apt install caddy
```

### Caddyfile

```
your-domain.com {
    reverse_proxy localhost:80 {
        # Required for SSE — flush responses immediately
        flush_interval -1
    }
}
```

The `flush_interval -1` is required for SSE. Without it, Caddy buffers SSE responses and the dashboard appears to hang.

Start Caddy:

```bash
sudo systemctl enable --now caddy
```

---

## Managing the API Token

### First login

1. Check `docker compose logs app` for the token
2. Open the dashboard → Settings
3. Paste the token → Save
4. The dashboard connects and starts showing data

### Persisting the token

Set `STREAM_API_TOKEN` in `.env` so the same token survives container restarts:

```
STREAM_API_TOKEN=your-token-here
```

Then restart: `docker compose restart app`

### Regenerating the token

Click **Regen** in the dashboard Settings. The new token is:
- Displayed in the input field (copy it now)
- Auto-saved to your browser's localStorage
- Active immediately on the server

The old token stops working. If you have `.env` set, update it to match the new token for persistence.

### Lockout recovery

If you lose the token and can't access the dashboard:

1. Set a new value in `.env`: `STREAM_API_TOKEN=my-new-token`
2. Restart: `docker compose restart app`
3. Open the dashboard → Settings → paste `my-new-token` → Save

---

## Pinning the MediaMTX Version

The default `docker-compose.yml` uses `latest-ffmpeg` which pulls the newest MediaMTX release on every build. This can break your config if MediaMTX introduces breaking changes.

For production, pin to a specific version:

```yaml
# docker-compose.yml
mediamtx:
  image: docker.io/bluenviron/mediamtx:1.11.3-ffmpeg  # pinned
```

Find available tags at: https://hub.docker.com/r/bluenviron/mediamtx/tags

To upgrade later:
1. Update the tag in `docker-compose.yml`
2. Check the [MediaMTX changelog](https://github.com/bluenviron/mediamtx/releases) for breaking changes
3. `docker compose pull mediamtx && docker compose up -d`

---

## Health Checks

Both services have Docker health checks configured:

- **mediamtx**: pings the internal API at `http://localhost:9997/v3/config/global/get` every 30s
- **app**: pings `http://localhost:80/api/status` every 30s

The app service uses `depends_on: condition: service_healthy` to wait for MediaMTX to be ready before starting.

Check health status:

```bash
docker compose ps
# NAME                  STATUS
# streamflow-mediamtx   Up (healthy)
# streamflow-app        Up (healthy)
```

---

## Logging and Monitoring

### View logs

```bash
docker compose logs -f          # all services, follow
docker compose logs -f app      # Express only
docker compose logs -f mediamtx # MediaMTX only
docker compose logs --since 1h  # last hour
```

### Log rotation

By default, Docker stores logs indefinitely. Add log rotation to prevent disk fill:

```yaml
# docker-compose.yml — add to each service
    logging:
      driver: json-file
      options:
        max-size: "10m"
        max-file: "3"
```

### Monitoring endpoint

`GET /api/status` returns:

```json
{"status": "ok", "uptime": 3600}
```

Or `503` with `{"status": "error", ...}` if MediaMTX is unreachable. Use this for uptime monitoring (UptimeRobot, Healthchecks.io, etc.).

---

## Upgrading

```bash
cd streamflow
git pull
docker compose build --no-cache app
docker compose up -d
```

For MediaMTX version bumps, update the image tag in `docker-compose.yml` first (see [Pinning the MediaMTX Version](#pinning-the-mediamtx-version)).

---

## Resource Limits

Default limits in `docker-compose.yml`:

| Service | Memory | CPU |
|---------|--------|-----|
| mediamtx | 512 MB | 1.0 |
| app | 256 MB | 0.5 |

**When to increase:**
- Multiple concurrent streams: increase mediamtx CPU to 2.0+ and memory to 1 GB+
- High viewer count: increase mediamtx memory (each HLS client consumes a segment buffer)
- The app service rarely needs more than 256 MB unless you add persistent storage

Edit `docker-compose.yml` under `deploy.resources.limits` for each service.

---

## Known Prototype Limitations

Be aware of these limitations in the current version:

| Limitation | Impact | Future fix |
|------------|--------|------------|
| Credits are in-memory | Balance resets to 100 on every container restart | Database persistence (Phase 2) |
| Payment is simulated | No real money is processed | Payment gateway integration (Phase 2) |
| Chat is simulated | Messages are randomly generated, not real | WebSocket chat backend (Phase 2) |
| Viewer count is simulated | "N watching" is a random number | Real SSE connection tracking (Phase 2) |
| Token in localStorage | Accessible to any JS on the page | HttpOnly session cookie (Phase 2) |
| `unsafe-inline` in CSP | Inline scripts allowed by policy | External JS files + nonce-based CSP |
| No TLS on HLS (port 8888) | Stream content unencrypted unless proxied | Proxy HLS through nginx/Caddy |
| SSE token in query param | Token visible in server logs and browser history | Short-lived session cookie |
