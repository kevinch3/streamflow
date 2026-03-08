# Backend Thumbnails Design

**Date:** 2026-03-08
**Status:** Approved

## Problem

The current thumbnail system captures frames entirely client-side: each browser loads the full HLS stream into a hidden `<video>`, waits for playback to begin, then canvas-captures a frame. This takes 3–12 seconds per client, per stream, every 60 seconds. The logic is also duplicated verbatim between `dashboard.js` and `live.js`.

## Approach: MediaMTX thumbnail proxy (Option A)

MediaMTX (`latest-ffmpeg` image) exposes `/v3/paths/{name}/thumbnail` on its internal API, returning a server-side JPEG snapshot of the live stream. Express proxies this as a public endpoint. The frontend becomes a plain `<img>` tag — no HLS loading, no canvas, no hidden video elements.

## Architecture

```
Browser  →  GET /api/streams/:name/thumbnail
Express  →  GET http://mediamtx:9997/v3/paths/{name}/thumbnail
MediaMTX →  200 image/jpeg  (or non-200 if stream offline / no frame yet)
Express  →  200 image/jpeg  (or 404)  →  Browser
```

## Components

### 1. Backend proxy route

- **File:** `app/routes/public.js`
- **Endpoint:** `GET /api/streams/:name/thumbnail`
- Path validated with `validSessionStreamPath` (reuses existing guard).
- Proxies to `mtxFetch('/v3/paths/{name}/thumbnail')`.
- On success: pipes JPEG body with `Content-Type: image/jpeg`.
- On non-200 from MediaMTX: returns 404.
- No auth required — same visibility level as `GET /api/streams/:name/live`.

### 2. Frontend thumbnail loading

- **Shared helper in `common.js`:** `thumbUrl(name)` → `/api/streams/${encodeURIComponent(name)}/thumbnail?t=<timestamp>`
- **Shared helper in `common.js`:** `initThumbs()` — sets a 60s interval that updates all `[data-thumb]` img `src` with a new timestamp, no re-render needed.
- Stream cards render `<img data-thumb="{name}" src="{thumbUrl(name)}">` immediately — browser fetches and displays as fast as any image load.
- `onerror` on the img shows the placeholder (for offline streams or streams where MediaMTX hasn't captured a frame yet).
- The `thumbAgeLabel` timestamp tracks when `src` was last set (`Date.now()` at each 60s cycle).

### 3. Unified logic

- Remove all of: `captureThumb`, `requestThumb`, `thumbCache` Map, `thumbPending` Set from both `dashboard.js` and `live.js`.
- Both pages call `initThumbs()` after initial render.
- `live.html` drops the hls.js `<script>` tag (it was only used for thumbnail capture).

## Error handling

- MediaMTX non-200 → Express returns 404 → `<img onerror>` fires → placeholder shown.
- Stream goes offline mid-session → next 60s refresh gets 404 → placeholder shown again.

## Out of scope

- Auth-gated thumbnails (admin-only streams are already unlisted from public SSE).
- Thumbnail caching layer in Express (MediaMTX handles generation; browser cache handles repeated loads).
- Configurable refresh interval.
