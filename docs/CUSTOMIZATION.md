# Customization Guide

How to adapt StreamFlow for your use case: ports, branding, credits, HLS tuning, stream paths, and embedding.

---

## Changing Ports

### RTMP port (default: 1935)

Change in two places:

1. **`docker-compose.yml`** — host-side port mapping:
   ```yaml
   mediamtx:
     ports:
       - "1935:1935"   # change the left number
   ```

2. **`mediamtx.yml`** — MediaMTX listen address:
   ```yaml
   rtmpAddress: :1935   # change to match
   ```

Note: the RTMP URL displayed in the dashboard is generated from `window.location.hostname` with port `1935` hardcoded at `html/index.html` line 740. If you change the RTMP port, update that line too.

### HLS port (default: 8888)

Change in **four** places:

1. **`docker-compose.yml`** — host-side port mapping:
   ```yaml
   mediamtx:
     ports:
       - "8888:8888"   # change the left number
   ```

2. **`mediamtx.yml`** — MediaMTX listen address:
   ```yaml
   hlsAddress: :8888    # change to match
   ```

3. **`html/index.html`** — HLS URLs at lines 886 and 1013:
   ```javascript
   // Both lines contain :8888 — change to your new port
   const hlsUrl = `${window.location.protocol}//${window.location.hostname}:8888/...`;
   ```

4. **`html/viewer.html`** — HLS URL at line 460:
   ```javascript
   const hlsUrl = `${window.location.protocol}//${window.location.hostname}:8888/...`;
   ```

If you miss the HTML file changes, the dashboard will list streams but the HLS player will fail to load.

### Dashboard port (default: 80)

Change in two places:

1. **`docker-compose.yml`** — host-side port mapping:
   ```yaml
   app:
     ports:
       - "80:80"   # change the left number for external access
   ```

2. **`.env`** — Express internal listen port:
   ```
   PORT=80
   ```

If you only change the compose port mapping (e.g. `3000:80`), Express still listens on 80 inside the container, which is fine. Only change `PORT` if you need Express to listen on a different internal port.

---

## Branding

### App name

`StreamFlow` appears in these locations:

| File | Line | Context |
|------|------|---------|
| `html/index.html` | 6 | `<title>StreamFlow</title>` |
| `html/viewer.html` | 6 | `<title>StreamFlow — Viewer</title>` |
| `html/viewer.html` | 729 | `document.title = 'StreamFlow — ...'` |

Search and replace `StreamFlow` with your brand name in both HTML files.

### Primary color

The brand color is **indigo** (`#6366f1`). It appears ~15 times in `html/index.html` and ~10 times in `html/viewer.html` — used for buttons, links, highlights, card borders, and the logo.

To change the brand color, replace all occurrences of `#6366f1` in both HTML files. Related shades you may also want to update:

- `#a78bfa` — lighter purple (random key chip)
- `#c4b5fd` — lighter purple hover
- `#1e1e3a` — dark indigo background (selected states)

### Favicon

Neither HTML file includes a favicon. To add one, place your icon file in the `html/` directory and add to both `<head>` sections:

```html
<link rel="icon" href="/favicon.ico">
```

Since `html/` is volume-mounted, the icon is served immediately with no rebuild.

---

## Stream Path Conventions

The `live/` prefix (e.g. `live/test`) is a convention, not enforced. OBS sends the stream key as the path suffix after the RTMP host URL.

Any path matching the validation regex is accepted:

```
/^[a-zA-Z0-9_\-/]{1,200}$/
```

Examples of valid paths: `live/test`, `broadcast/main`, `user123/stream`, `my-stream`.

### Restricting allowed paths

By default, `mediamtx.yml` uses a wildcard:

```yaml
paths:
  all_others:
```

To allow only specific paths, replace with named entries:

```yaml
paths:
  live/main:
  live/backup:
```

Any attempt to publish to an unlisted path will be rejected by MediaMTX.

---

## Credits System

### Starting balance

In `app/index.js` line 23:

```javascript
let credits = 100;
```

Change `100` to your desired initial balance. This value resets on every container restart (credits are stored in-memory only).

### Burn rate

Credits are deducted at `app/index.js` line 75:

```javascript
setInterval(async () => {
  // Deducts 1 credit per active stream, every 60 seconds
}, 60_000);
```

- The interval (`60_000` ms = 60 seconds) controls the deduction frequency
- Each tick deducts `N` credits where `N` is the number of active streams
- When credits reach 0, all streams are automatically disconnected

### Credit packages

Defined at `app/index.js` lines 25-29:

```javascript
const CREDIT_PACKAGES = {
  starter:  { credits: 100,  label: 'Starter',  price: '$ 5.00'  },
  standard: { credits: 500,  label: 'Standard', price: '$ 20.00' },
  pro:      { credits: 2000, label: 'Pro',       price: '$ 50.00' }
};
```

Change the `credits` amount, `label`, and `price` string as needed. Purchases are simulated — no real payment processing occurs.

---

## HLS Tuning

All HLS settings are in `mediamtx.yml`.

### Variant

```yaml
hlsVariant: mpegts
```

| Variant | Compatibility | Latency | Notes |
|---------|--------------|---------|-------|
| `mpegts` | Best (all browsers + hls.js) | ~6-10s | Default. Standard HLS with MPEG-TS segments. |
| `fmp4` | Good (modern browsers) | ~4-8s | Fragmented MP4. Better codec support (HEVC). |
| `lowLatency` | Limited | ~2-4s | LL-HLS. Requires `hlsSegmentCount >= 7` and hls.js LL mode configuration. |

### Segment duration

```yaml
hlsSegmentDuration: 2s
```

- **Lower** (1s): less latency, more segment requests, more CPU
- **Higher** (4-6s): more latency, better stability on slow connections

### Segment count

```yaml
hlsSegmentCount: 3
```

The number of segments in the playlist. `3` is the minimum for most players. Increasing to 5-6 provides a larger buffer for viewers on unstable connections.

### Always remux

```yaml
hlsAlwaysRemux: yes
```

When set to `yes`, MediaMTX starts generating HLS segments immediately when a stream starts, even before any viewer connects. This eliminates the first-viewer delay.

### CORS

```yaml
hlsAllowOrigins:
  - '*'
```

Allows any origin to load HLS segments. Required for the viewer embed feature to work cross-origin. To restrict to your domain only:

```yaml
hlsAllowOrigins:
  - 'https://your-domain.com'
```

---

## Rate Limits

The rate limiter is configured at `app/index.js` line 201:

```javascript
const strictLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,  // 15 minute window
  max: 20,                    // max requests per window per IP
});
```

Applied only to mutation endpoints:
- `POST /api/token/regenerate`
- `POST /api/credits/purchase`

There is no global rate limit — the dashboard uses SSE (a single persistent connection) instead of polling, so high request volume is not a concern.

To adjust: change `max` for a different request cap, or `windowMs` for a different time window.

---

## Embedding the Viewer

### Viewer URL format

```
http://your-host/viewer.html?stream=live%2Ftest
```

The `stream` query parameter is the URL-encoded stream path (e.g. `live/test` becomes `live%2Ftest`).

### Iframe embed

The viewer page generates an embed code when the user clicks the Embed button:

```html
<iframe
  src="http://your-host/viewer.html?stream=live%2Ftest"
  width="854"
  height="480"
  frameborder="0"
  allowfullscreen>
</iframe>
```

### Requirements for embedding

Two things must be configured for cross-origin embedding to work:

1. **MediaMTX HLS CORS** — `hlsAllowOrigins: ['*']` in `mediamtx.yml` (default)
2. **CSP `frame-ancestors`** — the viewer page has `frame-ancestors *` in its CSP header (set in `app/index.js`), allowing it to be embedded on any site. The admin dashboard has `frame-ancestors 'none'` to prevent clickjacking.

---

## Environment Variables Reference

| Variable | Default | File | Purpose |
|----------|---------|------|---------|
| `STREAM_API_TOKEN` | (auto-generated) | `.env` | Bearer token for authenticated API endpoints |
| `RTMP_PUBLISH_KEY` | (none) | `.env` | RTMP publish password (when auth is enabled in `mediamtx.yml`) |
| `PORT` | `80` | `.env` | Express server listen port |
| `MEDIAMTX_API` | `http://mediamtx:9997` | `docker-compose.yml` | Internal URL for MediaMTX REST API |
