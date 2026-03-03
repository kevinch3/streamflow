  // --- Thumbnail system (reused from admin dashboard) ---
  const thumbCache = new Map();
  const thumbPending = new Set();
  const THUMB_TTL_MS = 60000;

  function requestThumb(name, hlsUrl) {
    if (thumbPending.has(name)) return;
    const cached = thumbCache.get(name);
    if (cached && Date.now() - cached.capturedAt < THUMB_TTL_MS) return;
    thumbPending.add(name);
    captureThumb(name, hlsUrl).finally(() => thumbPending.delete(name));
  }

  function captureThumb(name, hlsUrl) {
    return new Promise(resolve => {
      const video = document.createElement('video');
      video.muted = true;
      video.playsInline = true;
      video.crossOrigin = 'anonymous';
      Object.assign(video.style, { position: 'fixed', top: '-9999px', width: '320px', height: '180px', pointerEvents: 'none' });
      document.body.appendChild(video);

      let hls = null;
      let done = false;
      const cleanup = () => { if (hls) hls.destroy(); video.remove(); };
      const finish = (dataUrl) => {
        if (done) return; done = true;
        if (dataUrl) {
          thumbCache.set(name, { dataUrl, capturedAt: Date.now() });
          const img = document.querySelector(`img[data-thumb="${CSS.escape(name)}"]`);
          if (img) { img.src = dataUrl; img.style.opacity = '1'; }
          const ph = document.querySelector(`[data-thumb-ph="${CSS.escape(name)}"]`);
          if (ph) ph.style.display = 'none';
          const ts = document.querySelector(`[data-thumb-ts="${CSS.escape(name)}"]`);
          if (ts) ts.textContent = 'just now';
        }
        cleanup(); resolve();
      };

      const timeout = setTimeout(() => finish(null), 12000);
      video.addEventListener('timeupdate', () => {
        if (video.currentTime < 0.1) return;
        clearTimeout(timeout);
        try {
          const canvas = document.createElement('canvas');
          canvas.width = 320; canvas.height = 180;
          canvas.getContext('2d').drawImage(video, 0, 0, 320, 180);
          finish(canvas.toDataURL('image/jpeg', 0.82));
        } catch { finish(null); }
      }, { once: true });
      video.addEventListener('error', () => { clearTimeout(timeout); finish(null); });

      if (Hls.isSupported()) {
        hls = new Hls({ maxBufferLength: 4, startPosition: -1 });
        hls.loadSource(hlsUrl);
        hls.attachMedia(video);
        hls.on(Hls.Events.MANIFEST_PARSED, () => video.play().catch(() => {}));
        hls.on(Hls.Events.ERROR, (_e, d) => { if (d.fatal) { clearTimeout(timeout); finish(null); } });
      } else if (video.canPlayType('application/vnd.apple.mpegurl')) {
        video.src = hlsUrl;
        video.play().catch(() => {});
      } else {
        clearTimeout(timeout); finish(null);
      }
    });
  }

  function thumbAgeLabel(capturedAt) {
    if (!capturedAt) return '';
    const s = Math.floor((Date.now() - capturedAt) / 1000);
    if (s < 5) return 'just now';
    if (s < 60) return `${s}s ago`;
    return `${Math.floor(s / 60)}m ago`;
  }

  // --- Helpers ---
  function formatUptime(seconds) {
    const h = Math.floor(seconds / 3600);
    const m = Math.floor((seconds % 3600) / 60);
    const s = seconds % 60;
    if (h > 0) return `${h}h ${m}m`;
    if (m > 0) return `${m}m ${s}s`;
    return `${s}s`;
  }

  function formatTracks(tracks) {
    if (!tracks || tracks.length === 0) return null;
    const video = tracks.find(t => /H264|H265|VP8|VP9|AV1/i.test(t));
    const audio = tracks.find(t => /AAC|MPEG-4 Audio|Opus|MP3/i.test(t));
    const parts = [];
    if (video) parts.push(video);
    if (audio) parts.push(audio === 'MPEG-4 Audio' ? 'AAC' : audio);
    return parts.length ? parts.join(' \u00b7 ') : tracks.slice(0, 2).join(', ');
  }

  function esc(str) {
    return String(str)
      .replace(/&/g, '&amp;')
      .replace(/"/g, '&quot;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;');
  }

  // --- Stream card with thumbnails ---
  function streamCard(s) {
    const viewerUrl = `/viewer.html?stream=${encodeURIComponent(s.name)}`;
    const hlsUrl = `${window.location.protocol}//${window.location.host}/hls/${s.name}/index.m3u8`;
    const codec = formatTracks(s.tracks);
    const bitrate = s.bitrateKbps ? `${s.bitrateKbps} kbps` : null;
    const quality = s.quality || 'unknown';
    const cached = thumbCache.get(s.name);
    const thumbSrc = cached?.dataUrl || '';
    const thumbAge = thumbAgeLabel(cached?.capturedAt);

    return `
      <div class="stream-card">
        <div class="stream-thumb-wrap">
          <img class="stream-thumb" data-thumb="${esc(s.name)}"
               src="${thumbSrc}" alt="" style="opacity:${thumbSrc ? '1' : '0'}" />
          <div class="thumb-placeholder" data-thumb-ph="${esc(s.name)}"
               style="display:${thumbSrc ? 'none' : 'flex'}">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.2">
              <rect x="2" y="4" width="20" height="16" rx="2"/>
              <path d="M10 9l5 3-5 3V9z"/>
            </svg>
            <span style="font-size:11px">Capturing preview...</span>
          </div>
          <div class="thumb-overlay">
            <span class="live-badge-pill"><span class="live-dot"></span>LIVE</span>
            <span class="thumb-ts" data-thumb-ts="${esc(s.name)}">${thumbAge}</span>
          </div>
        </div>
        <div class="stream-card-body">
          <div class="name">${esc(s.name)}</div>
          <div class="stream-chips">
            <span class="chip uptime">\u23F1 ${formatUptime(s.uptime || 0)}</span>
            ${codec ? `<span class="chip codec">\uD83C\uDFAC ${esc(codec)}</span>` : ''}
            ${bitrate ? `<span class="chip bitrate">\uD83D\uDCF6 ${esc(bitrate)}</span>` : ''}
            <span class="chip quality-${esc(quality)}">${esc(quality)}</span>
          </div>
          <div class="stream-actions">
            <a class="btn btn-primary" href="${esc(viewerUrl)}" target="_blank">Watch</a>
          </div>
        </div>
      </div>`;
  }

  function renderStreams(streams) {
    const el = document.getElementById('streamsList');
    const count = document.getElementById('streamCount');
    if (!streams || streams.length === 0) {
      count.textContent = '';
      el.innerHTML = '<div class="empty-state"><strong>No live streams</strong><p>Streams will appear here automatically when someone goes live.</p></div>';
      return;
    }
    count.textContent = `${streams.length} live`;
    el.innerHTML = `<div class="streams-grid">${streams.map(streamCard).join('')}</div>`;

    // Trigger thumbnail capture for each stream
    for (const s of streams) {
      const hlsUrl = `${window.location.protocol}//${window.location.host}/hls/${s.name}/index.m3u8`;
      requestThumb(s.name, hlsUrl);
    }
  }

  // --- SSE connection ---
  function connect() {
    const dot = document.getElementById('statusDot');
    const text = document.getElementById('statusText');
    const sse = new EventSource('/api/events/public');

    sse.onmessage = e => {
      const d = JSON.parse(e.data);
      if (d.status === 'ok') {
        dot.className = 'dot online';
        text.textContent = `Online \u00b7 up ${formatUptime(d.uptime || 0)}`;
      } else {
        dot.className = 'dot offline';
        text.textContent = 'Server unreachable';
      }
      renderStreams(d.streams || []);
    };

    sse.onerror = () => {
      dot.className = 'dot offline';
      text.textContent = 'Reconnecting...';
    };
  }

  connect();
