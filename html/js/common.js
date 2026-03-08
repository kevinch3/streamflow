(function attachStreamFlowCommon(global) {
  function esc(str) {
    return String(str)
      .replace(/&/g, '&amp;')
      .replace(/"/g, '&quot;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;');
  }

  function formatUptime(seconds) {
    const h = Math.floor(seconds / 3600);
    const m = Math.floor((seconds % 3600) / 60);
    const s = seconds % 60;
    if (h > 0) return `${h}h ${m}m`;
    if (m > 0) return `${m}m ${s}s`;
    return `${s}s`;
  }

  function copyText(text) {
    return navigator.clipboard.writeText(text).catch(() => {
      const el = document.createElement('textarea');
      el.value = text;
      document.body.appendChild(el);
      el.select();
      document.execCommand('copy');
      document.body.removeChild(el);
    });
  }

  function formatTracks(tracks) {
    if (!tracks || tracks.length === 0) return null;
    const video = tracks.find(t => /H264|H265|VP8|VP9|AV1/i.test(t));
    const audio = tracks.find(t => /AAC|MPEG-4 Audio|Opus|MP3/i.test(t));
    const parts = [];
    if (video) parts.push(video);
    if (audio) parts.push(audio === 'MPEG-4 Audio' ? 'AAC' : audio);
    return parts.length ? parts.join(' · ') : tracks.slice(0, 2).join(', ');
  }

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

  global.SFCommon = {
    copyText,
    esc,
    formatTracks,
    formatUptime,
    thumbUrl,
    initThumbs,
  };
})(window);
