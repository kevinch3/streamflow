  let hlsInstance = null;
  let watchingStream = null;
  let selectedPackage = null;
  let selectedPaymentMethod = 'simulate';
  let sseConn = null;
  let preparedPublish = null;
  let prepareTimer = null;
  let prepareSeq = 0;
  let latestStreamsByName = new Map();

  const STREAM_KEY_RE = /^[A-Za-z0-9_-]{3,64}$/;
  const qualityTone = { excellent: 'ok', good: 'ok', fair: 'warn', poor: 'bad', unknown: 'neutral' };

  // --- Token & session prefix ---
  function getToken() {
    return localStorage.getItem('sf_token') || '';
  }
  function getPrefix() {
    return localStorage.getItem('sf_prefix') || '';
  }
  function getBrowserId() {
    let browserId = localStorage.getItem('sf_browser_id');
    if (!browserId) {
      browserId = 'b_' + Math.random().toString(36).slice(2, 10);
      localStorage.setItem('sf_browser_id', browserId);
    }
    return browserId;
  }
  function saveSession(data) {
    localStorage.setItem('sf_token', data.token);
    if (data.prefix) localStorage.setItem('sf_prefix', data.prefix);
  }
  function clearSession() {
    localStorage.removeItem('sf_token');
    localStorage.removeItem('sf_prefix');
  }

  function getStreamKey() {
    return document.getElementById('streamKey').value.trim();
  }
  function isValidStreamKey(key) {
    return STREAM_KEY_RE.test(key);
  }
  function getPreparedForCurrentKey() {
    const key = getStreamKey();
    if (!preparedPublish) return null;
    if (preparedPublish.streamKey !== key) return null;
    if (preparedPublish.expiresAt <= Date.now()) return null;
    return preparedPublish;
  }
  function getCurrentPathCandidate() {
    const key = getStreamKey();
    const prefix = getPrefix();
    if (!prefix || !isValidStreamKey(key)) return '';
    return `${prefix}${key}`;
  }
  function getCurrentStreamPath() {
    const prepared = getPreparedForCurrentKey();
    return prepared ? prepared.streamPath : getCurrentPathCandidate();
  }

  function setConnectMsg(text, color = '#64748b') {
    const el = document.getElementById('connectFeedbackMsg');
    el.textContent = text;
    el.style.color = color;
  }
  function setDiagChip(id, value, tone = 'neutral') {
    const chip = document.getElementById(id);
    chip.className = `diag-chip ${tone}`;
    chip.querySelector('.diag-value').textContent = value;
  }

  function updateRtmpUrl() {
    const prepared = getPreparedForCurrentKey();
    const server = prepared?.obsServer || `rtmp://${window.location.hostname}:1935`;
    document.getElementById('rtmpUrl').value = server;
  }

  function setKey(key) {
    document.getElementById('streamKey').value = key;
    updateStreamUrls();
  }
  function randomKey() {
    const chars = 'abcdefghijklmnopqrstuvwxyz0123456789';
    return 'stream_' + Array.from({ length: 6 }, () => chars[Math.floor(Math.random() * chars.length)]).join('');
  }

  async function refreshPublishCredentials(force = false) {
    const tok = getToken();
    const key = getStreamKey();
    if (!tok || !isValidStreamKey(key)) {
      preparedPublish = null;
      updateRtmpUrl();
      updateStreamUrls({ schedulePrepare: false });
      return;
    }

    if (!force) {
      const prepared = getPreparedForCurrentKey();
      if (prepared && prepared.expiresAt - Date.now() > 60_000) {
        updateRtmpUrl();
        updateStreamUrls({ schedulePrepare: false });
        return;
      }
    }

    const reqId = ++prepareSeq;
    setConnectMsg('Preparing secure stream credentials…', '#f59e0b');
    try {
      const r = await fetch('/api/publish/prepare', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${tok}`
        },
        body: JSON.stringify({ streamKey: key, browserId: getBrowserId() })
      });
      const data = await r.json();
      if (reqId !== prepareSeq) return;
      if (!r.ok) throw new Error(data.error || 'Could not prepare stream credentials');

      const qs = data.obsStreamKey.split('?')[1] || '';
      const pt = new URLSearchParams(qs).get('pt') || '';
      preparedPublish = { ...data, streamKey: key, publishToken: pt };
      updateRtmpUrl();
      updateStreamUrls({ schedulePrepare: false });
      setConnectMsg(`Secure key ready (expires ${new Date(data.expiresAt).toLocaleTimeString()})`, '#22c55e');
    } catch (e) {
      if (reqId !== prepareSeq) return;
      preparedPublish = null;
      updateRtmpUrl();
      updateStreamUrls({ schedulePrepare: false });
      setConnectMsg(e.message, '#ef4444');
    }
  }

  function schedulePreparePublishCredentials(force = false) {
    clearTimeout(prepareTimer);
    prepareTimer = setTimeout(() => {
      refreshPublishCredentials(force);
    }, force ? 0 : 400);
  }

  function refreshSecureCredentials() {
    schedulePreparePublishCredentials(true);
  }

  function updateFfmpegDemo() {
    const row = document.getElementById('ffmpegDemoRow');
    const cmd = document.getElementById('ffmpegCmd');
    const prepared = getPreparedForCurrentKey();
    if (!prepared || !prepared.obsServer || !prepared.obsStreamKey) {
      row.style.display = 'none';
      return;
    }
    row.style.display = 'block';
    const rtmpUrl = `${prepared.obsServer}/${prepared.obsStreamKey}`;
    cmd.textContent = `ffmpeg -re -f lavfi -i "testsrc=size=1280x720:rate=30" \\\n  -f lavfi -i "sine=frequency=440:sample_rate=44100" \\\n  -c:v libx264 -preset ultrafast -tune zerolatency -b:v 2500k \\\n  -c:a aac -ar 44100 -f flv \\\n  "${rtmpUrl}"`;
  }

  function updateActionButtons() {
    const hasToken = !!getToken();
    const keyValid = isValidStreamKey(getStreamKey());
    const prepared = !!getPreparedForCurrentKey();
    const path = getCurrentStreamPath();
    document.getElementById('copyObsServerBtn').disabled = !hasToken;
    document.getElementById('copyObsKeyBtn').disabled = !prepared;
    document.getElementById('refreshSecureBtn').disabled = !hasToken || !keyValid;
    document.getElementById('openViewerBtn').disabled = !path;
    updateFfmpegDemo();
  }

  function updateConnectFeedback() {
    const key = getStreamKey();
    const keyValid = isValidStreamKey(key);
    const prepared = getPreparedForCurrentKey();
    const streamPath = getCurrentStreamPath();
    const stream = streamPath ? latestStreamsByName.get(streamPath) : null;

    setDiagChip('diagPath', keyValid ? 'valid' : 'invalid', keyValid ? 'ok' : 'bad');

    if (stream) {
      setDiagChip('diagDiscovery', 'live', 'ok');
      const quality = stream.quality || 'unknown';
      setDiagChip('diagQuality', quality, qualityTone[quality] || 'neutral');
      const codec = formatTracks(stream.tracks) || '—';
      setDiagChip('diagCodec', codec, codec === '—' ? 'neutral' : 'ok');
      setDiagChip('diagBitrate', stream.bitrateKbps ? `${stream.bitrateKbps} kbps` : '—', stream.bitrateKbps ? 'ok' : 'neutral');
      setDiagChip('diagUptime', formatUptime(stream.uptime || 0), 'neutral');
      setConnectMsg(`Publishing on ${streamPath}`, '#22c55e');
    } else {
      setDiagChip('diagDiscovery', prepared ? 'discovered' : 'not discovered', prepared ? 'ok' : 'warn');
      setDiagChip('diagQuality', 'unknown', 'neutral');
      setDiagChip('diagCodec', '—', 'neutral');
      setDiagChip('diagBitrate', '—', 'neutral');
      setDiagChip('diagUptime', '—', 'neutral');
      if (!keyValid) {
        setConnectMsg('Stream key must be 3-64 chars using letters, numbers, "_" or "-".', '#ef4444');
      } else if (!getToken()) {
        setConnectMsg('Redeem a promo code to create a session before preparing stream credentials.', '#f59e0b');
      } else if (!prepared) {
        setConnectMsg('Waiting for secure credentials…', '#f59e0b');
      }
    }

    updateActionButtons();
  }

  function updateStreamUrls(options = {}) {
    const { schedulePrepare = true } = options;
    const path = getCurrentStreamPath();
    const base = `${window.location.protocol}//${window.location.host}`;
    const prepared = getPreparedForCurrentKey();

    document.getElementById('obsStreamKey').value = prepared ? prepared.obsStreamKey : '';
    document.getElementById('previewHls').textContent = path ? `${base}/hls/${path}/index.m3u8` : '';
    document.getElementById('previewViewer').textContent = path ? `${base}/viewer.html?stream=${encodeURIComponent(path)}` : '';

    if (schedulePrepare) schedulePreparePublishCredentials(false);
    updateConnectFeedback();
  }

  function copyObsServer() {
    copyText(document.getElementById('rtmpUrl').value);
  }
  function copyObsStreamKey() {
    copyText(document.getElementById('obsStreamKey').value);
  }
  function openCurrentViewer() {
    const path = getCurrentStreamPath();
    if (!path) return;
    window.open(`/viewer.html?stream=${encodeURIComponent(path)}`, '_blank');
  }

  // --- Promo code redemption ---
  async function redeemPromo() {
    const code = document.getElementById('promoInput').value.trim().toUpperCase();
    if (!code) return;
    const status = document.getElementById('promoStatus');
    status.textContent = 'Redeeming...';
    status.style.color = '#f59e0b';
    try {
      const headers = { 'Content-Type': 'application/json' };
      const tok = getToken();
      if (tok) headers['Authorization'] = `Bearer ${tok}`;
      const r = await fetch('/api/credits/redeem', {
        method: 'POST',
        headers,
        body: JSON.stringify({ code })
      });
      const data = await r.json();
      if (!r.ok) throw new Error(data.error || 'Invalid code');
      saveSession(data);
      updateCredits(data.credits);
      updateRtmpUrl();
      updateStreamUrls({ schedulePrepare: false });
      schedulePreparePublishCredentials(true);
      connectSSE();
      status.textContent = `+${data.added} credits added!`;
      status.style.color = '#22c55e';
      document.getElementById('promoInput').value = '';
    } catch (e) {
      status.textContent = e.message;
      status.style.color = '#ef4444';
    }
  }

  // --- Credits ---
  function creditClass(n) {
    if (n <= 5)  return 'critical';
    if (n <= 20) return 'low';
    return 'ok';
  }
  function updateCredits(n) {
    const cls = creditClass(n);
    document.getElementById('creditsHeader').textContent = n;
    document.getElementById('creditsDisplay').textContent = n;
    document.getElementById('creditsBadge').className = `credits-badge ${cls}`;
    document.getElementById('creditsDisplay').className = `balance-num ${cls}`;

    const banner = document.getElementById('lowCreditsBanner');
    if (n > 0 && n <= 10) {
      document.getElementById('lowCreditsCount').textContent = n;
      banner.style.display = 'flex';
    } else {
      banner.style.display = 'none';
    }

    updateZeroOverlay(n);
    updateFfmpegDemo();
  }

  // --- Package selection ---
  function selectPackage(pkg) {
    selectedPackage = pkg;
    ['starter', 'standard', 'pro'].forEach(p => {
      document.getElementById(`pkg-${p}`).classList.toggle('selected', p === pkg);
    });
    const btn = document.getElementById('purchaseBtn');
    btn.disabled = false;
    btn.textContent = 'Add Credits';
  }
  function selectPaymentMethod(method) {
    selectedPaymentMethod = method;
    document.querySelectorAll('.pm-btn:not(:disabled)').forEach(b => b.classList.remove('selected'));
    document.getElementById(`pm-${method}`)?.classList.add('selected');
  }

  // --- Purchase flow ---
  const PKG_PRICES = { starter: '$5.00', standard: '$20.00', pro: '$50.00' };
  async function purchase() {
    if (!selectedPackage) return;
    const modal = document.getElementById('payModal');
    document.getElementById('payProcessing').style.display = 'block';
    document.getElementById('paySuccess').style.display = 'none';
    document.getElementById('payAmount').textContent = PKG_PRICES[selectedPackage] || '';
    ['step1','step2','step3'].forEach(id => {
      const el = document.getElementById(id);
      el.className = 'pay-step';
      el.querySelector('.pay-step-icon').textContent = id.slice(-1);
    });
    modal.classList.add('open');

    try {
      await animateStep('step1', 800);
      await animateStep('step2', 900);
      const r = await fetch('/api/credits/purchase', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${getToken()}`
        },
        body: JSON.stringify({ package: selectedPackage })
      });
      const data = await r.json();
      if (!r.ok) throw new Error(data.error || 'Payment failed');
      await animateStep('step3', 500);
      document.getElementById('payProcessing').style.display = 'none';
      document.getElementById('paySuccess').style.display = 'block';
      document.getElementById('paySuccessMsg').textContent =
        `+${data.added} credits added. New balance: ${data.credits} credits.`;

      updateCredits(data.credits);
      if (data.token) {
        saveSession(data);
        connectSSE();
      }
      schedulePreparePublishCredentials(true);

      setTimeout(() => {
        modal.classList.remove('open');
        selectedPackage = null;
        ['starter', 'standard', 'pro'].forEach(p =>
          document.getElementById(`pkg-${p}`).classList.remove('selected')
        );
        document.getElementById('purchaseBtn').disabled = true;
        document.getElementById('purchaseBtn').textContent = 'Select a package';
      }, 2800);
    } catch (e) {
      modal.classList.remove('open');
      alert(`Payment failed: ${e.message}`);
    }
  }
  function animateStep(id, duration) {
    return new Promise(resolve => {
      const el = document.getElementById(id);
      el.className = 'pay-step active';
      el.querySelector('.pay-step-icon').textContent = '↻';
      setTimeout(() => {
        el.className = 'pay-step done';
        el.querySelector('.pay-step-icon').textContent = '✓';
        resolve();
      }, duration);
    });
  }

  // --- SSE connection ---
  function connectSSE() {
    if (sseConn) { sseConn.close(); sseConn = null; }
    const tok = getToken();
    if (!tok) { showGate(); return; }

    let everConnected = false;
    sseConn = new EventSource(`/api/events?token=${encodeURIComponent(tok)}`);
    sseConn.onmessage = e => {
      everConnected = true;
      const d = JSON.parse(e.data);
      const dot = document.getElementById('statusDot');
      const text = document.getElementById('statusText');
      if (d.status === 'ok') {
        dot.className = 'dot online';
        text.textContent = `Online · up ${formatUptime(d.uptime)}`;
      } else {
        dot.className = 'dot offline';
        text.textContent = 'Server unreachable';
      }
      if (d.version) document.getElementById('appVersion').textContent = 'v' + d.version;

      renderStreams(d.streams);
      latestStreamsByName = new Map((d.streams || []).map(s => [s.name, s]));
      const activeNames = new Set((d.streams || []).map(s => s.name));

      for (const s of (d.streams || [])) {
        const hlsUrl = `${window.location.protocol}//${window.location.host}/hls/${s.name}/index.m3u8`;
        requestThumb(s.name, hlsUrl);
      }

      if (watchingStream && !activeNames.has(watchingStream)) closePlayer();

      if (d.credits !== undefined) updateCredits(d.credits);
      if (d.resources) renderResources(d.resources);
      updateConnectFeedback();
    };

    sseConn.onerror = () => {
      if (!everConnected) {
        sseConn.close();
        sseConn = null;
        clearSession();
        showGate();
      }
    };
  }

  function renderResources(r) {
    const card = document.getElementById('resourcesCard');
    if (!r) { card.style.display = 'none'; return; }
    card.style.display = '';

    function tone(pct) {
      if (pct > 90) return 'crit';
      if (pct >= 70) return 'warn';
      return 'ok';
    }

    // CPU
    const cpuTone = tone(r.cpuPercent);
    const cpuEl = document.getElementById('resCpuValue');
    cpuEl.textContent = r.cpuPercent + '%';
    cpuEl.className = 'metric-value ' + cpuTone;
    const cpuBar = document.getElementById('resCpuBar');
    cpuBar.style.width = r.cpuPercent + '%';
    cpuBar.className = 'resource-bar ' + cpuTone;

    // Memory (RSS vs 256 MB container limit)
    const memLimitMb = 256;
    const memPct = Math.min(100, Math.round((r.memRssMb / memLimitMb) * 100));
    const memTone = tone(memPct);
    const memEl = document.getElementById('resMemValue');
    memEl.textContent = r.memRssMb + ' / ' + memLimitMb + ' MB';
    memEl.className = 'metric-value ' + memTone;
    const memBar = document.getElementById('resMemBar');
    memBar.style.width = memPct + '%';
    memBar.className = 'resource-bar ' + memTone;

    // Counters
    const totalConns = (r.connections.admin || 0) + (r.connections.viewer || 0) + (r.connections.public || 0);
    function chip(label, value, state) {
      return '<div class="diag-chip ' + state + '"><span class="diag-label">' + label + '</span><span class="diag-value">' + value + '</span></div>';
    }
    document.getElementById('resCounters').innerHTML =
      chip('Connections', totalConns, 'neutral') +
      chip('Admin', r.connections.admin, 'neutral') +
      chip('Viewers', r.connections.viewer, 'neutral') +
      chip('Public', r.connections.public, 'neutral') +
      chip('Sessions', r.sessions, 'neutral') +
      chip('Streams', r.streams, 'neutral') +
      chip('Heap', r.memHeapMb + '/' + r.memHeapTotalMb + ' MB', 'neutral');
  }

  function renderStreams(streams, errorCode) {
    const el = document.getElementById('streamsList');
    if (!streams) {
      const msg = errorCode === 401
        ? 'Redeem a promo code or add credits to get started.'
        : 'Could not reach the API.';
      el.innerHTML = `<div class="empty-state"><strong>Error</strong><p>${msg}</p></div>`;
      return;
    }
    if (streams.length === 0) {
      el.innerHTML = `<div class="empty-state"><strong>No active streams</strong><p>Start streaming from OBS to see your stream here.</p></div>`;
      return;
    }
    el.innerHTML = `<div class="streams-grid">${streams.map(streamCard).join('')}</div>`;
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

  // --- Thumbnail system ---
  const thumbCache = new Map();
  const thumbPending = new Set();
  const THUMB_TTL_MS = 60_000;
  function requestThumb(name, hlsUrl) {
    const cached = thumbCache.get(name);
    if (thumbPending.has(name)) return;
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
        if (done) return;
        done = true;
        if (dataUrl) {
          thumbCache.set(name, { dataUrl, capturedAt: Date.now() });
          const img = document.querySelector(`img[data-thumb="${CSS.escape(name)}"]`);
          if (img) { img.src = dataUrl; img.style.opacity = '1'; }
          const ph = document.querySelector(`[data-thumb-ph="${CSS.escape(name)}"]`);
          if (ph) ph.style.display = 'none';
          const ts = document.querySelector(`[data-thumb-ts="${CSS.escape(name)}"]`);
          if (ts) ts.textContent = 'just now';
        }
        cleanup();
        resolve();
      };

      const timeout = setTimeout(() => finish(null), 12000);
      video.addEventListener('timeupdate', () => {
        if (video.currentTime < 0.1) return;
        clearTimeout(timeout);
        try {
          const canvas = document.createElement('canvas');
          canvas.width = 320;
          canvas.height = 180;
          canvas.getContext('2d').drawImage(video, 0, 0, 320, 180);
          finish(canvas.toDataURL('image/jpeg', 0.82));
        } catch {
          finish(null);
        }
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
        clearTimeout(timeout);
        finish(null);
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

  function streamCard(s) {
    const hlsUrl = `${window.location.protocol}//${window.location.host}/hls/${s.name}/index.m3u8`;
    const viewerUrl = `/viewer.html?stream=${encodeURIComponent(s.name)}`;
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
            <span style="font-size:11px">Capturing preview…</span>
          </div>
          <div class="thumb-overlay">
            <span class="live-badge-pill"><span class="live-dot"></span>LIVE</span>
            <span class="thumb-ts" data-thumb-ts="${esc(s.name)}">${thumbAge}</span>
          </div>
        </div>
        <div class="stream-card-body">
          <div class="name">${esc(s.name)}</div>
          <div class="stream-chips">
            <span class="chip uptime">&#x23F1; ${formatUptime(s.uptime)}</span>
            ${codec ? `<span class="chip codec">&#x1F3AC; ${esc(codec)}</span>` : ''}
            ${bitrate ? `<span class="chip bitrate">&#x1F4F6; ${esc(bitrate)}</span>` : ''}
            <span class="chip ${qualityTone[quality] === 'bad' ? 'cost' : 'uptime'}">${esc(quality)}</span>
            <span class="chip cost">&#x1F4B3; 1 cr/min</span>
            <span class="chip ${s.listed !== false ? 'listed' : 'unlisted'}">${s.listed !== false ? 'Listed' : 'Unlisted'}</span>
          </div>
          <div class="hls-url">
            <span>${esc(hlsUrl)}</span>
            <button class="copy-btn" onclick="copyText(${esc(JSON.stringify(hlsUrl))})">Copy</button>
          </div>
          <div class="stream-actions">
            <button class="btn btn-primary" onclick="watchStream(${esc(JSON.stringify(s.name))}, ${esc(JSON.stringify(hlsUrl))})">Watch</button>
            <a class="btn btn-ghost" href="${esc(viewerUrl)}" target="_blank">Viewer &#x2197;</a>
            <button class="btn btn-visibility ${s.listed !== false ? 'listed' : 'unlisted'}" onclick="toggleVisibility(${esc(JSON.stringify(s.name))}, ${s.listed === false})">${s.listed !== false ? '&#x1F441; Hide' : '&#x1F441; Show'}</button>
            <button class="btn btn-danger" onclick="disconnectStream(${esc(JSON.stringify(s.name))})">Disconnect</button>
          </div>
        </div>
      </div>`;
  }

  // --- Player ---
  function watchStream(name, hlsPath) {
    watchingStream = name;
    const video = document.getElementById('videoPlayer');
    document.getElementById('playerName').textContent = name;
    document.getElementById('playerCard').classList.add('active');
    document.getElementById('playerCard').scrollIntoView({ behavior: 'smooth' });
    if (hlsInstance) { hlsInstance.destroy(); hlsInstance = null; }
    if (Hls.isSupported()) {
      hlsInstance = new Hls({ liveSyncDurationCount: 3 });
      hlsInstance.loadSource(hlsPath);
      hlsInstance.attachMedia(video);
    } else if (video.canPlayType('application/vnd.apple.mpegurl')) {
      video.src = hlsPath;
    }
  }
  function closePlayer() {
    watchingStream = null;
    const video = document.getElementById('videoPlayer');
    if (hlsInstance) { hlsInstance.destroy(); hlsInstance = null; }
    video.src = '';
    document.getElementById('playerCard').classList.remove('active');
  }

  // --- Disconnect ---
  async function disconnectStream(name) {
    if (!confirm(`Disconnect stream "${name}"?`)) return;
    try {
      const r = await fetch(`/api/streams/${encodeURIComponent(name)}`, {
        method: 'DELETE',
        headers: { 'Authorization': `Bearer ${getToken()}` }
      });
      if (!r.ok) {
        const d = await r.json().catch(() => ({}));
        alert(d.error || 'Failed to disconnect stream.');
        return;
      }
      if (watchingStream === name) closePlayer();
    } catch {
      alert('Request failed.');
    }
  }

  // --- Visibility toggle ---
  async function toggleVisibility(name, listed) {
    try {
      const r = await fetch(`/api/streams/${encodeURIComponent(name)}/visibility`, {
        method: 'PATCH',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${getToken()}`
        },
        body: JSON.stringify({ listed })
      });
      if (!r.ok) {
        const d = await r.json().catch(() => ({}));
        alert(d.error || 'Failed to change visibility.');
      }
    } catch {
      alert('Request failed.');
    }
  }

  // --- Helpers ---
  function copyText(text) {
    if (!text) return;
    function fallback() {
      const el = document.createElement('textarea');
      el.value = text;
      el.style.position = 'fixed';
      el.style.opacity = '0';
      document.body.appendChild(el);
      el.select();
      document.execCommand('copy');
      document.body.removeChild(el);
    }
    if (navigator.clipboard?.writeText) {
      navigator.clipboard.writeText(text).catch(fallback);
    } else {
      fallback();
    }
  }
  function formatUptime(seconds) {
    const h = Math.floor(seconds / 3600);
    const m = Math.floor((seconds % 3600) / 60);
    const s = seconds % 60;
    if (h > 0) return `${h}h ${m}m`;
    if (m > 0) return `${m}m ${s}s`;
    return `${s}s`;
  }
  function esc(str) {
    return String(str)
      .replace(/&/g, '&amp;')
      .replace(/"/g, '&quot;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;');
  }



  // --- Welcome gate ---
  function showGate() {
    document.getElementById('welcomeGate').style.display = 'flex';
    document.querySelector('header').style.display = 'none';
    document.querySelector('main').style.display = 'none';
    document.getElementById('lowCreditsBanner').style.display = 'none';
    document.getElementById('zeroCreditOverlay').style.display = 'none';
  }
  function hideGate() {
    document.getElementById('welcomeGate').style.display = 'none';
    document.querySelector('header').style.display = '';
    document.querySelector('main').style.display = '';
  }

  async function gateRedeem() {
    const input = document.getElementById('gatePromoInput');
    const status = document.getElementById('gatePromoStatus');
    const code = input.value.trim().toUpperCase();
    if (!code) return;
    status.textContent = 'Redeeming...';
    status.style.color = '#f59e0b';
    try {
      const r = await fetch('/api/credits/redeem', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ code })
      });
      const data = await r.json();
      if (!r.ok) throw new Error(data.error || 'Invalid code');
      saveSession(data);
      status.textContent = `+${data.added} credits added!`;
      status.style.color = '#22c55e';
      hideGate();
      updateCredits(data.credits);
      updateRtmpUrl();
      updateStreamUrls({ schedulePrepare: false });
      schedulePreparePublishCredentials(true);
      connectSSE();
    } catch (e) {
      status.textContent = e.message;
      status.style.color = '#ef4444';
    }
  }

  // --- Zero credits overlay ---
  function updateZeroOverlay(n) {
    const overlay = document.getElementById('zeroCreditOverlay');
    const tok = getToken();
    overlay.style.display = n === 0 && tok ? 'flex' : 'none';
  }

  async function zeroRedeemPromo() {
    const input = document.getElementById('zeroPromoInput');
    const status = document.getElementById('zeroPromoStatus');
    const code = input.value.trim().toUpperCase();
    if (!code) return;
    status.textContent = 'Redeeming...';
    status.style.color = '#f59e0b';
    try {
      const headers = { 'Content-Type': 'application/json' };
      const tok = getToken();
      if (tok) headers['Authorization'] = `Bearer ${tok}`;
      const r = await fetch('/api/credits/redeem', {
        method: 'POST',
        headers,
        body: JSON.stringify({ code })
      });
      const data = await r.json();
      if (!r.ok) throw new Error(data.error || 'Invalid code');
      saveSession(data);
      updateCredits(data.credits);
      updateRtmpUrl();
      updateStreamUrls({ schedulePrepare: false });
      schedulePreparePublishCredentials(true);
      connectSSE();
      input.value = '';
    } catch (e) {
      status.textContent = e.message;
      status.style.color = '#ef4444';
    }
  }

  // --- Init ---
  updateRtmpUrl();
  updateStreamUrls({ schedulePrepare: false });
  if (getToken()) {
    connectSSE();
    schedulePreparePublishCredentials(true);
  } else {
    showGate();
  }
