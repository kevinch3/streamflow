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

  global.SFCommon = {
    copyText,
    esc,
    formatTracks,
    formatUptime,
  };
})(window);
