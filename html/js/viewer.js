  // --- Read and validate stream name from URL ---
  // Strict format: s/<session-id>/<stream-key>
  const rawStream  = new URLSearchParams(window.location.search).get('stream') || '';
  const streamName = decodeURIComponent(rawStream).slice(0, 200);

  // --- HLS player ---
  let hlsInstance = null;

  function startPlayer() {
    const video  = document.getElementById('video');
    const hlsUrl = `${window.location.protocol}//${window.location.host}/hls/${streamName}/index.m3u8`;

    if (hlsInstance) { hlsInstance.destroy(); hlsInstance = null; }

    if (Hls.isSupported()) {
      hlsInstance = new Hls({ liveSyncDurationCount: 3, enableWorker: true });
      hlsInstance.loadSource(hlsUrl);
      hlsInstance.attachMedia(video);
    } else if (video.canPlayType('application/vnd.apple.mpegurl')) {
      video.src = hlsUrl;
    }

    video.addEventListener('loadedmetadata', updateResolution, { once: false });
    video.addEventListener('resize', updateResolution);
  }

  function stopPlayer() {
    if (hlsInstance) { hlsInstance.destroy(); hlsInstance = null; }
    const video = document.getElementById('video');
    video.src = '';
  }

  function updateResolution() {
    const video = document.getElementById('video');
    const w = video.videoWidth, h = video.videoHeight;
    if (w && h) {
      let label = `${w}×${h}`;
      if (w >= 3840) label += ' (4K)';
      else if (w >= 1920) label += ' (1080p)';
      else if (w >= 1280) label += ' (720p)';
      else if (w >= 854)  label += ' (480p)';
      document.getElementById('resVal').textContent = label;
    }
  }

  // --- SSE stream status — replaces pollStatus interval ---
  let isLive = false;
  let offlineShown = false;
  let firstEvent = true;
  let viewerSse = null;
  let viewerSseRetry = null;

  function handleStatusEvent(data) {
    const wasLive = isLive;
    isLive = data.live;

    if (data.credits !== undefined) {
      document.getElementById('creditsVal').textContent = `${data.credits} cr`;
    }

    if (isLive) {
      offlineShown = false;
      document.getElementById('offlineOverlay').classList.remove('open');

      const pill = document.getElementById('livePill');
      pill.className = 'live-pill';
      document.getElementById('livePillText').textContent = 'LIVE';

      if (data.tracks?.length) {
        document.getElementById('codecVal').textContent = formatTracks(data.tracks);
      }
      if (data.bitrateKbps) {
        document.getElementById('bitrateVal').textContent = `${data.bitrateKbps} kbps`;
      }
      if (data.uptime !== undefined) {
        document.getElementById('uptimeVal').textContent = formatUptime(data.uptime);
      }

      if (firstEvent || !wasLive) startPlayer();
      firstEvent = false;

    } else if (!offlineShown) {
      offlineShown = true;
      stopPlayer();
      const pill = document.getElementById('livePill');
      pill.className = 'live-pill offline';
      document.getElementById('livePillText').textContent = 'OFFLINE';

      const noCredits = data.credits === 0;
      document.getElementById('offlineIcon').textContent  = noCredits ? '💳' : '📡';
      document.getElementById('offlineTitle').textContent = noCredits ? 'Credits exhausted' : 'Stream ended';
      document.getElementById('offlineMsg').textContent   = noCredits
        ? 'This stream was paused because the broadcaster ran out of credits.'
        : 'The broadcaster has stopped streaming. Check back later.';
      document.getElementById('offlineOverlay').classList.add('open');
    }
  }

  function connectViewerSSE() {
    if (viewerSse) {
      viewerSse.close();
      viewerSse = null;
    }
    if (viewerSseRetry) {
      clearTimeout(viewerSseRetry);
      viewerSseRetry = null;
    }

    const sse = new EventSource(`/api/events/live/${encodeURIComponent(streamName)}`);
    viewerSse = sse;

    sse.onmessage = e => {
      try {
        handleStatusEvent(JSON.parse(e.data));
      } catch {
        // Ignore malformed payloads and wait for next event.
      }
    };

    sse.onerror = () => {
      // Network/proxy restarts are expected for SSE; retry with backoff.
      if (viewerSse !== sse) return;
      sse.close();
      viewerSse = null;
      viewerSseRetry = setTimeout(connectViewerSSE, 1500);
    };
  }

  // --- Ping measurement ---
  async function measurePing() {
    try {
      const t0 = performance.now();
      await fetch('/api/status');
      const ms = Math.round(performance.now() - t0);
      document.getElementById('pingVal').textContent = `${ms} ms`;
    } catch {}
  }

  // --- Viewer count (simulated) ---
  let viewerBase = 2 + Math.floor(Math.random() * 7);
  function updateViewerCount() {
    const delta = Math.floor(Math.random() * 3) - 1;
    viewerBase = Math.max(1, viewerBase + delta);
    document.getElementById('viewerCount').textContent = `${viewerBase} watching`;
  }

  // --- Share ---
  function shareStream() {
    const url = window.location.href;
    const msg = document.getElementById('actionMsg');
    navigator.clipboard.writeText(url).then(() => {
      msg.textContent = '✓ Link copied!';
      setTimeout(() => { msg.textContent = ''; }, 2500);
    }).catch(() => {
      prompt('Copy this link:', url);
    });
  }

  // --- Embed ---
  function openEmbed() {
    const code = `<iframe\n  src="${window.location.href}"\n  width="854"\n  height="480"\n  allow="autoplay; fullscreen"\n  allowfullscreen\n  style="border:none;border-radius:8px"\n></iframe>`;
    document.getElementById('embedCode').textContent = code;
    document.getElementById('embedModal').classList.add('open');
  }
  function closeEmbed() {
    document.getElementById('embedModal').classList.remove('open');
  }
  function copyEmbed() {
    copyText(document.getElementById('embedCode').textContent);
    const btn = document.querySelector('#embedModal .btn-primary');
    btn.textContent = '✓ Copied!';
    setTimeout(() => { btn.textContent = 'Copy code'; }, 1600);
  }

  // --- Chat ---
  const FAKE_USERS = ['Alex_W', 'StreamBot', 'viewer_42', 'ChatLurker', 'Mike_TV', 'Sara.99', 'TechFan', 'w4tcher'];
  const FAKE_MSGS  = [
    'Nice stream! 🔥', 'Is this 1080p?', 'Great quality!', 'LUL', 'first!!',
    'Love the content 👌', '🔥🔥🔥', 'How long have you been streaming?',
    'This is so good', 'gg', 'banger stream fr fr', '👀👀', 'Clip it!',
    'What software are you using?', 'Hi from Brazil 🇧🇷', '😄', 'Keep it up!',
    'audio sounds great', 'sub hype!', 'true!', 'agreed!'
  ];

  function nowTime() {
    const d = new Date();
    return `${d.getHours().toString().padStart(2,'0')}:${d.getMinutes().toString().padStart(2,'0')}`;
  }

  function addChatMsg(user, text, type = '') {
    const container = document.getElementById('chatMessages');
    const div = document.createElement('div');
    div.className = `chat-msg ${type}`;
    const initial = user.replace(/[^a-zA-Z]/g, '')[0]?.toUpperCase() || '?';
    div.innerHTML = `
      <div class="chat-avatar">${initial}</div>
      <div class="chat-body">
        <div class="chat-meta">
          <span class="chat-user">${esc(user)}</span>
          <span class="chat-time">${nowTime()}</span>
        </div>
        <div class="chat-text">${esc(text)}</div>
      </div>`;
    container.appendChild(div);
    container.scrollTop = container.scrollHeight;
  }

  function seedChat() {
    const seed = [
      ['StreamBot', 'Welcome to the stream! 👋', 'bot'],
      ['viewer_42',  'first!!', ''],
      ['Alex_W',     'Is this live?', ''],
      ['StreamBot',  'Yes, streaming live now 🎥', 'bot'],
      ['Mike_TV',    'Nice quality 👌', ''],
      ['Sara.99',    '🔥🔥🔥', ''],
    ];
    seed.forEach(([u, t, type]) => addChatMsg(u, t, type));
  }

  function sendChat() {
    const input = document.getElementById('chatInput');
    const text  = input.value.trim();
    if (!text) return;
    addChatMsg('You', text, 'you');
    input.value = '';
    // Occasional bot reply
    if (Math.random() < 0.35) {
      const delay = 900 + Math.random() * 2000;
      setTimeout(() => {
        const responses = ['😄', '👍', 'lol', 'true!', 'fr fr', 'agreed!', '💯', 'nice one'];
        const user = FAKE_USERS[Math.floor(Math.random() * FAKE_USERS.length)];
        const resp = responses[Math.floor(Math.random() * responses.length)];
        addChatMsg(user, resp);
      }, delay);
    }
  }

  function scheduleRandomMsg() {
    const delay = 12000 + Math.random() * 25000;
    setTimeout(() => {
      if (!document.getElementById('offlineOverlay').classList.contains('open')) {
        const user = FAKE_USERS[Math.floor(Math.random() * FAKE_USERS.length)];
        const text = FAKE_MSGS[Math.floor(Math.random() * FAKE_MSGS.length)];
        addChatMsg(user, text);
      }
      scheduleRandomMsg();
    }, delay);
  }

  // --- Helpers ---
  function formatTracks(tracks) {
    if (!tracks || tracks.length === 0) return '—';
    const video = tracks.find(t => /H264|H265|VP8|VP9|AV1/i.test(t));
    const audio = tracks.find(t => /AAC|MPEG-4 Audio|Opus|MP3/i.test(t));
    const parts = [];
    if (video) parts.push(video);
    if (audio) parts.push(audio === 'MPEG-4 Audio' ? 'AAC' : audio);
    return parts.length ? parts.join(' · ') : tracks.slice(0,2).join(', ');
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
    navigator.clipboard.writeText(text).catch(() => {
      const el = document.createElement('textarea');
      el.value = text; document.body.appendChild(el);
      el.select(); document.execCommand('copy');
      document.body.removeChild(el);
    });
  }

  function esc(str) {
    return String(str)
      .replace(/&/g,'&amp;').replace(/"/g,'&quot;')
      .replace(/</g,'&lt;').replace(/>/g,'&gt;');
  }

  // --- Init ---
  function init() {
    seedChat();
    scheduleRandomMsg();
    updateViewerCount();

    connectViewerSSE();
    measurePing();

    setInterval(measurePing,      10000);
    setInterval(updateViewerCount, 8000);
  }

  window.addEventListener('beforeunload', () => {
    if (viewerSseRetry) {
      clearTimeout(viewerSseRetry);
      viewerSseRetry = null;
    }
    if (viewerSse) {
      viewerSse.close();
      viewerSse = null;
    }
  });

  // Startup — must be AFTER all let/const declarations to avoid TDZ errors
  // Validate strict session-bound stream path (s/<session-id>/<stream-key>)
  const validName = streamName && /^s\/[a-f0-9]{16}\/[A-Za-z0-9_-]{3,64}$/.test(streamName);
  if (!validName) {
    document.getElementById('errorPage').classList.add('show');
  } else {
    document.getElementById('viewerLayout').style.display = 'grid';
    document.getElementById('streamTitle').textContent = streamName;
    document.title = `StreamFlow — ${streamName}`;
    init();
  }
