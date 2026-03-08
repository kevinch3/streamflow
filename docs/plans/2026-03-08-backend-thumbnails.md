# Backend Thumbnails Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Replace client-side HLS-capture thumbnails with a backend proxy to MediaMTX's native thumbnail API, eliminating the 3–12s capture delay and deduplicating thumbnail logic across pages.

**Architecture:** Express proxies `GET /api/streams/:name/thumbnail` → MediaMTX internal `/v3/paths/get/{name}/thumbnail` → JPEG response. Frontend renders a plain `<img>` tag; shared helpers in `common.js` manage URL cache-busting and load/error state. No HLS loading or canvas in the browser.

**Tech Stack:** Express (Node.js), MediaMTX v1.x REST API, vanilla JS, Docker Compose

---

## Task 1: Verify MediaMTX thumbnail endpoint

No code yet — confirm the exact URL before writing the proxy.

**Step 1: Start a live stream**

Use OBS or ffmpeg to push an RTMP stream. Confirm it's active:
```bash
curl -s http://localhost:9997/v3/rtmpconns/list | grep -o '"state":"[^"]*"'
```
Expected: `"state":"publish"` for at least one connection.

**Step 2: Find the stream path name**

```bash
curl -s http://localhost:9997/v3/rtmpconns/list | python3 -m json.tool | grep '"path"'
```
Note the path value (e.g. `s/abc123def456/mystream`).

**Step 3: Try the thumbnail endpoint from inside the app container**

```bash
docker compose exec app wget -qO /tmp/thumb.jpg \
  "http://mediamtx:9997/v3/paths/get/s%2Fabc123def456%2Fmystream/thumbnail" \
  && echo "OK — endpoint exists" || echo "FAIL"
```

If that fails (non-zero exit), try without the `get/` segment:
```bash
docker compose exec app wget -qO /tmp/thumb.jpg \
  "http://mediamtx:9997/v3/paths/s%2Fabc123def456%2Fmystream/thumbnail" \
  && echo "OK — endpoint exists" || echo "FAIL"
```

**Step 4: Note the working URL pattern**

Record which of these two worked:
- `http://mediamtx:9997/v3/paths/get/{name}/thumbnail`  ← matches pattern in `app/mediamtx.js:getPathInfo`
- `http://mediamtx:9997/v3/paths/{name}/thumbnail`

Use that pattern in Task 2.

---

## Task 2: Backend thumbnail proxy route

**Files:**
- Modify: `app/routes/public.js`

**Step 1: Add the route**

In `app/routes/public.js`, add this route after the `/streams/:name/live` route (around line 96):

```js
router.get('/streams/:name/thumbnail', async (req, res) => {
  try {
    const streamName = decodeURIComponent(req.params.name);
    if (!validSessionStreamPath(streamName)) return res.status(400).end();
    // Use the URL pattern confirmed in Task 1
    const r = await mtxFetch(`/v3/paths/get/${encodeURIComponent(streamName)}/thumbnail`);
    if (!r.ok) return res.status(404).end();
    const buf = Buffer.from(await r.arrayBuffer());
    res
      .set('Content-Type', 'image/jpeg')
      .set('Cache-Control', 'public, max-age=55')
      .send(buf);
  } catch {
    res.status(404).end();
  }
});
```

Note: `Cache-Control: public, max-age=55` lets the browser cache the image for 55s — just under the 60s client refresh interval. This prevents the thumbnail from flashing on every 3s SSE re-render (the browser serves from cache immediately).

**Step 2: Restart app**

```bash
make restart s=app
```

**Step 3: Test with curl**

With a stream active (same stream name from Task 1):

```bash
curl -v "http://localhost/api/streams/s%2Fabc123def456%2Fmystream/thumbnail" \
  --output /tmp/test-thumb.jpg
```

Expected:
- HTTP 200
- `Content-Type: image/jpeg`
- `/tmp/test-thumb.jpg` is a valid JPEG (open it to confirm)

With no stream active, expect HTTP 404.

**Step 4: Commit**

```bash
git add app/routes/public.js
git commit -m "feat: proxy MediaMTX thumbnail endpoint as GET /api/streams/:name/thumbnail"
```

---

## Task 3: Add shared thumbnail helpers to common.js

**Files:**
- Modify: `html/js/common.js`

The current `SFCommon` object (lines 40-45) exports `copyText`, `esc`, `formatTracks`, `formatUptime`. We add three thumbnail helpers.

**Step 1: Add helpers inside the IIFE, before the `global.SFCommon = {` line**

```js
  // --- Thumbnail helpers ---
  // Stable URL for 60s per stream — prevents re-requests on every 3s SSE re-render
  const _thumbTs = new Map();

  function thumbUrl(name) {
    if (!_thumbTs.has(name)) _thumbTs.set(name, Date.now());
    return `/api/streams/${encodeURIComponent(name)}/thumbnail?t=${_thumbTs.get(name)}`;
  }

  // Call once on page init. Sets up event delegation for load/error and 60s refresh.
  function initThumbs() {
    // load/error don't bubble — use capture phase for delegation
    document.addEventListener('load', e => {
      if (!e.target.matches('img[data-thumb]')) return;
      e.target.style.opacity = '1';
      const ph = document.querySelector(`[data-thumb-ph="${CSS.escape(e.target.dataset.thumb)}"]`);
      if (ph) ph.style.display = 'none';
      const ts = document.querySelector(`[data-thumb-ts="${CSS.escape(e.target.dataset.thumb)}"]`);
      if (ts) ts.textContent = 'just now';
    }, true);
    document.addEventListener('error', e => {
      if (!e.target.matches('img[data-thumb]')) return;
      e.target.style.opacity = '0';
      const ph = document.querySelector(`[data-thumb-ph="${CSS.escape(e.target.dataset.thumb)}"]`);
      if (ph) ph.style.display = 'flex';
    }, true);
    // Every 60s: expire cached timestamps so next render fetches fresh thumbnails
    setInterval(() => {
      _thumbTs.clear();
      document.querySelectorAll('img[data-thumb]').forEach(img => {
        img.src = thumbUrl(img.dataset.thumb);
      });
    }, 60_000);
  }
```

**Step 2: Export from SFCommon**

Update the `global.SFCommon = {` block to include the new helpers:

```js
  global.SFCommon = {
    copyText,
    esc,
    formatTracks,
    formatUptime,
    thumbUrl,
    initThumbs,
  };
```

**Step 3: Verify in browser console**

Open any page and in the console:
```js
SFCommon.thumbUrl('s/abc/test')
// Expected: "/api/streams/s%2Fabc%2Ftest/thumbnail?t=1234567890123"
SFCommon.thumbUrl('s/abc/test')
// Expected: same URL (cached timestamp, no new t= value)
```

**Step 4: Commit**

```bash
git add html/js/common.js
git commit -m "feat: add thumbUrl and initThumbs thumbnail helpers to SFCommon"
```

---

## Task 4: Update live.js and live.html

**Files:**
- Modify: `html/js/live.js`
- Modify: `html/live.html`

**Step 1: Remove the old thumbnail system from live.js**

Delete lines 1–74 entirely:
```
// --- Thumbnail system (reused from admin dashboard) ---
const thumbCache = new Map();
... (all the way through)
function thumbAgeLabel(capturedAt) { ... }
```

These are: `thumbCache`, `thumbPending`, `THUMB_TTL_MS`, `requestThumb()`, `captureThumb()`, `thumbAgeLabel()`.

**Step 2: Update streamCard() to use SFCommon.thumbUrl**

In the `streamCard(s)` function, replace the old thumbnail block with the new approach.

Remove these lines (they reference the deleted cache):
```js
const cached = thumbCache.get(s.name);
const thumbSrc = cached?.dataUrl || '';
const thumbAge = thumbAgeLabel(cached?.capturedAt);
```

Remove the `hlsUrl` variable from `streamCard` (it was only used for thumbnail capture):
```js
// DELETE this line:
const hlsUrl = `${window.location.protocol}//${window.location.host}/hls/${s.name}/index.m3u8`;
```

Replace the `<img>` and placeholder block inside the card template:
```js
// OLD:
`<img class="stream-thumb" data-thumb="${esc(s.name)}"
     src="${thumbSrc}" alt="" style="opacity:${thumbSrc ? '1' : '0'}" />
<div class="thumb-placeholder" data-thumb-ph="${esc(s.name)}"
     style="display:${thumbSrc ? 'none' : 'flex'}">
  ...
</div>
<div class="thumb-overlay">
  <span class="live-badge-pill"><span class="live-dot"></span>LIVE</span>
  <span class="thumb-ts" data-thumb-ts="${esc(s.name)}">${thumbAge}</span>
</div>`

// NEW:
`<img class="stream-thumb" data-thumb="${esc(s.name)}"
     src="${SFCommon.thumbUrl(s.name)}" alt="" style="opacity:0" />
<div class="thumb-placeholder" data-thumb-ph="${esc(s.name)}" style="display:flex">
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.2">
    <rect x="2" y="4" width="20" height="16" rx="2"/>
    <path d="M10 9l5 3-5 3V9z"/>
  </svg>
  <span style="font-size:11px">Loading preview...</span>
</div>
<div class="thumb-overlay">
  <span class="live-badge-pill"><span class="live-dot"></span>LIVE</span>
  <span class="thumb-ts" data-thumb-ts="${esc(s.name)}"></span>
</div>`
```

**Step 3: Update renderStreams() to remove requestThumb calls**

In `renderStreams(streams)`, remove the thumb-request loop at lines 159–163:
```js
// DELETE:
// Trigger thumbnail capture for each stream
for (const s of streams) {
  const hlsUrl = `${window.location.protocol}//${window.location.host}/hls/${s.name}/index.m3u8`;
  requestThumb(s.name, hlsUrl);
}
```

**Step 4: Call initThumbs() once at startup**

At the bottom of live.js, just before `connect();`, add:
```js
SFCommon.initThumbs();
connect();
```

**Step 5: Remove hls.js from live.html**

In `html/live.html`, delete the entire `<script>` tag for hls.js (lines 35–37):
```html
<!-- DELETE this block: -->
<script src="https://cdn.jsdelivr.net/npm/hls.js@1.6.15/dist/hls.min.js"
        integrity="sha256-QTqD4rsMd+0L8L4QXVOdF+9F39mEoLE+zTsUqQE4OTg="
        crossorigin="anonymous"></script>
```

**Step 6: Verify in browser**

Open `http://localhost/live.html` with a stream active. Expect:
- Thumbnail appears quickly (under 1s, as fast as an image load)
- Placeholder disappears when thumbnail loads
- Placeholder stays visible if stream is offline
- Browser DevTools Network tab: no `hls.js` loaded, no HLS segment requests from this page

**Step 7: Commit**

```bash
git add html/js/live.js html/live.html
git commit -m "feat: replace client-side HLS thumbnail capture with backend proxy in live.html"
```

---

## Task 5: Update dashboard.js

**Files:**
- Modify: `html/js/dashboard.js`

**Step 1: Remove the old thumbnail system**

Delete the entire thumbnail section (lines 1222–1298 approximately):
```
// --- Thumbnail system ---
const thumbCache = new Map();
const thumbPending = new Set();
const THUMB_TTL_MS = 60_000;
function requestThumb(...) { ... }
function captureThumb(...) { ... }
function thumbAgeLabel(...) { ... }
```

**Step 2: Update streamCard() in dashboard.js**

Remove these lines from `streamCard(s)`:
```js
// DELETE:
const cached = thumbCache.get(s.name);
const thumbSrc = cached?.dataUrl || '';
const thumbAge = thumbAgeLabel(cached?.capturedAt);
```

Update the thumbnail section of the card template (same pattern as Task 4 Step 2):
```js
// OLD img + placeholder block → NEW:
`<img class="stream-thumb" data-thumb="${esc(s.name)}"
     src="${SFCommon.thumbUrl(s.name)}" alt="" style="opacity:0" />
<div class="thumb-placeholder" data-thumb-ph="${esc(s.name)}" style="display:flex">
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.2">
    <rect x="2" y="4" width="20" height="16" rx="2"/>
    <path d="M10 9l5 3-5 3V9z"/>
  </svg>
  <span style="font-size:11px">Loading preview...</span>
</div>
<div class="thumb-overlay">
  <span class="live-badge-pill"><span class="live-dot"></span>LIVE</span>
  <span class="thumb-ts" data-thumb-ts="${esc(s.name)}"></span>
</div>`
```

**Step 3: Remove requestThumb calls from the SSE handler**

In the SSE `onmessage` handler (around line 1128), delete the thumb-request loop:
```js
// DELETE:
for (const s of (d.streams || [])) {
  const hlsUrl = `${window.location.protocol}//${window.location.host}/hls/${s.name}/index.m3u8`;
  requestThumb(s.name, hlsUrl);
}
```

**Step 4: Call initThumbs() once at startup**

Find where the SSE connection is first established (the `connect()` call or equivalent at the bottom of the dashboard IIFE). Add `SFCommon.initThumbs()` before it — just once, not inside the SSE handler.

**Step 5: Verify in browser**

Open `http://localhost/` (dashboard) with a stream active. Expect:
- Thumbnail loads quickly on stream cards
- Placeholder shows for offline streams
- Existing player (hls.js) still works when clicking "Watch" — hls.js is still loaded in `index.html`, only removed from `live.html`
- No console errors

**Step 6: Commit**

```bash
git add html/js/dashboard.js
git commit -m "feat: replace client-side HLS thumbnail capture with backend proxy in dashboard"
```

---

## Verification checklist

- [ ] `GET /api/streams/:name/thumbnail` returns 200 + JPEG for an active stream
- [ ] Returns 404 for an inactive/unknown stream
- [ ] `live.html` — thumbnail appears fast, no hls.js network request
- [ ] `dashboard.html` — thumbnail appears fast, inline player still works
- [ ] Thumbnails refresh ~60s (check by waiting and watching Network tab)
- [ ] No duplicate thumbnail logic between live.js and dashboard.js
- [ ] No `thumbCache`, `thumbPending`, `captureThumb`, `requestThumb` remain in either file
