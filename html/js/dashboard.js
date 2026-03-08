  let hlsInstance = null;
  let watchingStream = null;
  let selectedPackage = null;
  let selectedPaymentMethod = 'paypal';
  let paypalEnabled = false;
  let paypalConfig = { enabled: false, env: 'sandbox', clientId: '', currency: 'USD', flow: 'popup-first' };
  let paypalSdkPromise = null;
  let paypalButtonsInstance = null;
  let redirectFallbackInProgress = false;
  let sseConn = null;
  let preparedPublish = null;
  let prepareTimer = null;
  let prepareSeq = 0;
  let latestStreamsByName = new Map();

  const STREAM_KEY_RE = /^[A-Za-z0-9_-]{3,64}$/;
  const qualityTone = { excellent: 'ok', good: 'ok', fair: 'warn', poor: 'bad', unknown: 'neutral' };
  const CHECKOUT_STORAGE_KEY = 'sf_paypal_checkout_v1';
  const CHECKOUT_TTL_MS = 30 * 60 * 1000;
  const CHECKOUT_PENDING_STATUSES = new Set(['creating', 'awaiting_approval', 'capturing', 'returning']);
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

  function getCookie(name) {
    const source = document.cookie || '';
    const chunks = source.split(';');
    for (const chunk of chunks) {
      const idx = chunk.indexOf('=');
      if (idx <= 0) continue;
      const key = chunk.slice(0, idx).trim();
      if (key !== name) continue;
      return decodeURIComponent(chunk.slice(idx + 1).trim());
    }
    return '';
  }

  function getCspNonce() {
    const nonce = String(getCookie('sf_csp_nonce') || '').trim();
    return /^[A-Za-z0-9_-]{16,128}$/.test(nonce) ? nonce : '';
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

  function nowTs() {
    return Date.now();
  }

  function isCheckoutPending(status) {
    return CHECKOUT_PENDING_STATUSES.has(String(status || ''));
  }

  function readCheckoutSessionRaw() {
    try {
      const raw = localStorage.getItem(CHECKOUT_STORAGE_KEY);
      if (!raw) return null;
      const parsed = JSON.parse(raw);
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null;
      return parsed;
    } catch {
      return null;
    }
  }

  function isCheckoutExpired(session) {
    const startedAt = Number(session?.startedAt || 0);
    if (!startedAt) return false;
    return nowTs() - startedAt > CHECKOUT_TTL_MS;
  }

  function readCheckoutSession() {
    const parsed = readCheckoutSessionRaw();
    if (!parsed) return null;
    if (isCheckoutExpired(parsed)) {
      localStorage.removeItem(CHECKOUT_STORAGE_KEY);
      return null;
    }
    return parsed;
  }

  function writeCheckoutSession(next) {
    localStorage.setItem(CHECKOUT_STORAGE_KEY, JSON.stringify(next));
    return next;
  }

  function setCheckoutSession(patch = {}) {
    const prev = readCheckoutSession() || {};
    const startedAt = Number(prev.startedAt || patch.startedAt || nowTs());
    const next = {
      status: 'idle',
      package: '',
      flow: paypalConfig.flow === 'redirect-first' ? 'redirect' : 'popup',
      orderId: '',
      approvalUrl: '',
      lastError: '',
      startedAt,
      updatedAt: nowTs(),
      ...prev,
      ...patch,
      startedAt,
      updatedAt: nowTs(),
    };
    return writeCheckoutSession(next);
  }

  function clearCheckoutSession() {
    localStorage.removeItem(CHECKOUT_STORAGE_KEY);
  }

  function hydrateCheckoutSession() {
    const raw = readCheckoutSessionRaw();
    if (!raw) return;
    if (!isCheckoutExpired(raw)) return;
    clearCheckoutSession();
    alert('Payment session expired, please start again.');
  }

  function resetPackageSelection() {
    selectedPackage = null;
    ['starter', 'standard', 'pro'].forEach((p) => {
      document.getElementById(`pkg-${p}`).classList.remove('selected');
    });
  }

  function resetPayModalSteps() {
    ['step1', 'step2', 'step3'].forEach((id) => {
      const el = document.getElementById(id);
      el.className = 'pay-step';
      el.querySelector('.pay-step-icon').textContent = id.slice(-1);
    });
  }

  function setPayModalStep(id, state) {
    const el = document.getElementById(id);
    if (!el) return;
    if (state === 'active') {
      el.className = 'pay-step active';
      el.querySelector('.pay-step-icon').textContent = '↻';
      return;
    }
    if (state === 'done') {
      el.className = 'pay-step done';
      el.querySelector('.pay-step-icon').textContent = '✓';
      return;
    }
    el.className = 'pay-step';
    el.querySelector('.pay-step-icon').textContent = id.slice(-1);
  }

  function payModalIsOpen() {
    return document.getElementById('payModal').classList.contains('open');
  }

  function setPayStatusMessage(text, color = '#94a3b8') {
    const el = document.getElementById('payStatusMsg');
    el.textContent = text || '';
    el.style.color = color;
  }

  function setPayActionVisibility({ resume = false, retry = false, restart = false, cancel = false }) {
    document.getElementById('payResumeExternalBtn').style.display = resume ? '' : 'none';
    document.getElementById('payRetryCaptureBtn').style.display = retry ? '' : 'none';
    document.getElementById('payRestartBtn').style.display = restart ? '' : 'none';
    document.getElementById('payCancelBtn').style.display = cancel ? '' : 'none';
  }

  function openPayModal(amount = '') {
    const modal = document.getElementById('payModal');
    document.getElementById('payProcessing').style.display = 'block';
    document.getElementById('paySuccess').style.display = 'none';
    if (amount) document.getElementById('payAmount').textContent = amount;
    modal.classList.add('open');
  }

  function closePayModal() {
    document.getElementById('payModal').classList.remove('open');
    updateResumeBanner();
  }

  function checkoutStatusLabel(status) {
    if (status === 'creating') return 'Creating your PayPal order…';
    if (status === 'awaiting_approval') return 'Waiting for PayPal approval…';
    if (status === 'capturing') return 'Capturing payment and crediting account…';
    if (status === 'returning') return 'Finishing payment after PayPal return…';
    if (status === 'failed') return 'Payment needs your attention.';
    if (status === 'cancelled') return 'Payment was canceled.';
    return 'Payment is in progress.';
  }

  function updateResumeBanner() {
    const banner = document.getElementById('paymentResumeBanner');
    const text = document.getElementById('paymentResumeText');
    const checkout = readCheckoutSession();
    if (checkout && isCheckoutPending(checkout.status) && !payModalIsOpen()) {
      text.textContent = `\u{1F4B3} ${checkoutStatusLabel(checkout.status)}`;
      banner.style.display = 'flex';
      return;
    }
    banner.style.display = 'none';
  }

  function renderCheckoutState() {
    const checkout = readCheckoutSession();
    const wrap = document.getElementById('paypalButtonsWrap');
    const processing = document.getElementById('payProcessing');
    const success = document.getElementById('paySuccess');
    const amount = checkout?.package ? (PKG_PRICES[checkout.package] || '') : (PKG_PRICES[selectedPackage] || '');

    document.getElementById('payAmount').textContent = amount;
    wrap.style.display = 'none';
    resetPayModalSteps();
    setPayActionVisibility({ resume: false, retry: false, restart: false });
    processing.style.display = 'block';
    success.style.display = 'none';
    setPayStatusMessage('');

    if (!checkout) {
      updateResumeBanner();
      updatePurchaseButtonState();
      return;
    }

    if (checkout.status === 'creating') {
      setPayModalStep('step1', 'active');
      setPayStatusMessage('Creating your PayPal order…', '#f59e0b');
    } else if (checkout.status === 'awaiting_approval') {
      setPayModalStep('step1', 'done');
      setPayModalStep('step2', 'active');
      setPayStatusMessage(
        checkout.flow === 'redirect'
          ? 'Click "Open PayPal" below to complete your purchase, then return here.'
          : 'Click the PayPal button below to approve in a popup.',
        '#f59e0b',
      );
      if (checkout.flow === 'popup') wrap.style.display = '';
      setPayActionVisibility({
        resume: !!checkout.approvalUrl,
        retry: false,
        restart: true,
        cancel: true,
      });
    } else if (checkout.status === 'capturing' || checkout.status === 'returning') {
      setPayModalStep('step1', 'done');
      setPayModalStep('step2', 'done');
      setPayModalStep('step3', 'active');
      setPayStatusMessage('Capturing payment and crediting account…', '#f59e0b');
    } else if (checkout.status === 'success') {
      setPayModalStep('step1', 'done');
      setPayModalStep('step2', 'done');
      setPayModalStep('step3', 'done');
      processing.style.display = 'none';
      success.style.display = 'block';
      document.getElementById('paySuccessMsg').textContent = checkout.successMessage || 'Payment successful.';
    } else if (checkout.status === 'cancelled') {
      setPayModalStep('step1', 'done');
      setPayModalStep('step2', 'active');
      setPayStatusMessage(checkout.lastError || 'PayPal checkout was canceled.', '#ef4444');
      setPayActionVisibility({
        resume: !!checkout.approvalUrl,
        retry: false,
        restart: true,
        cancel: true,
      });
    } else if (checkout.status === 'failed') {
      clearPopupApprovalWatchdog();
      if (checkout.orderId) {
        setPayModalStep('step1', 'done');
        setPayModalStep('step2', 'done');
        setPayModalStep('step3', 'active');
      } else {
        setPayModalStep('step1', 'active');
      }
      setPayStatusMessage(checkout.lastError || 'Payment failed. Please try again.', '#ef4444');
      setPayActionVisibility({
        resume: !!checkout.approvalUrl,
        retry: !!checkout.orderId,
        restart: true,
        cancel: true,
      });
    }

    updateResumeBanner();
    updatePurchaseButtonState();
  }

  function requestClosePayModal() {
    closePayModal();
  }

  function abandonPayment() {
    clearCheckoutSession();
    closePayModal();
    resetPackageSelection();
    updatePurchaseButtonState();
  }

  async function resumePaymentModal() {
    openPayModal();
    renderCheckoutState();
    const checkout = readCheckoutSession();
    if (
      checkout
      && checkout.status === 'awaiting_approval'
      && checkout.flow === 'popup'
      && checkout.package
      && paypalEnabled
    ) {
      try {
        await renderPayPalButtonsForPackage(checkout.package);
      } catch {
        await startRedirectFallback(checkout.package, 'PayPal popup is unavailable. Use the link below to complete payment.');
      }
    }
  }

  function clearPayPalReturnParams() {
    const url = new URL(window.location.href);
    url.searchParams.delete('paypal');
    url.searchParams.delete('token');
    url.searchParams.delete('PayerID');
    url.searchParams.delete('ba_token');
    window.history.replaceState({}, '', `${url.pathname}${url.search}${url.hash}`);
  }

  async function requestCreateOrder(packageName) {
    const tok = getToken();
    if (!tok) throw new Error('Session token missing. Redeem a promo code and retry.');

    const r = await fetch('/api/credits/purchase', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${tok}`
      },
      body: JSON.stringify({
        action: 'create',
        method: 'paypal',
        package: packageName
      })
    });
    const data = await r.json();
    if (!r.ok) throw new Error(data.error || 'Payment failed');
    if (!data.orderId || !data.approvalUrl) throw new Error('Missing PayPal order details');
    return data;
  }

  async function requestCaptureOrder(orderId) {
    const tok = getToken();
    if (!tok) throw new Error('Session token missing. Redeem a promo code and retry.');

    const r = await fetch('/api/credits/purchase', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${tok}`
      },
      body: JSON.stringify({
        action: 'capture',
        method: 'paypal',
        orderId
      })
    });
    const data = await r.json();
    if (!r.ok) throw new Error(data.error || 'Failed to capture PayPal payment');
    return data;
  }

  async function loadPayPalSdk() {
    if (window.paypal?.Buttons) return window.paypal;
    if (!paypalConfig.clientId) throw new Error('PayPal client ID is unavailable');

    if (paypalSdkPromise) return paypalSdkPromise;

    paypalSdkPromise = new Promise((resolve, reject) => {
      const script = document.createElement('script');
      const cspNonce = getCspNonce();
      script.src = `https://www.paypal.com/sdk/js?client-id=${encodeURIComponent(paypalConfig.clientId)}&currency=${encodeURIComponent(paypalConfig.currency || 'USD')}&intent=capture&components=buttons`;
      script.async = true;
      if (cspNonce) {
        script.nonce = cspNonce;
        script.setAttribute('data-csp-nonce', cspNonce);
      }
      script.onload = () => {
        if (window.paypal?.Buttons) {
          resolve(window.paypal);
        } else {
          reject(new Error('PayPal SDK loaded without Buttons API'));
        }
      };
      script.onerror = () => reject(new Error('Failed to load PayPal SDK'));
      document.head.appendChild(script);
    }).catch((err) => {
      paypalSdkPromise = null;
      throw err;
    });

    return paypalSdkPromise;
  }

  async function startRedirectFallback(packageName, reason = '') {
    if (redirectFallbackInProgress) return;
    redirectFallbackInProgress = true;
    try {
      const existing = readCheckoutSession();
      if (
        existing
        && existing.package === packageName
        && existing.orderId
        && existing.approvalUrl
      ) {
        setCheckoutSession({
          status: 'awaiting_approval',
          package: packageName,
          flow: 'redirect',
          orderId: existing.orderId,
          approvalUrl: existing.approvalUrl,
          lastError: reason || '',
        });
        renderCheckoutState();
        return;
      }

      const checkout = setCheckoutSession({
        status: 'creating',
        package: packageName,
        flow: 'redirect',
        orderId: '',
        approvalUrl: '',
        lastError: reason || '',
      });
      openPayModal(PKG_PRICES[checkout.package] || '');
      renderCheckoutState();

      const created = await requestCreateOrder(packageName);
      setCheckoutSession({
        status: 'awaiting_approval',
        package: packageName,
        flow: 'redirect',
        orderId: created.orderId,
        approvalUrl: created.approvalUrl,
        lastError: reason || '',
      });
      renderCheckoutState();
    } catch (err) {
      setCheckoutSession({
        status: 'failed',
        package: packageName,
        flow: 'redirect',
        lastError: err.message || 'Redirect fallback failed',
      });
      renderCheckoutState();
    } finally {
      redirectFallbackInProgress = false;
    }
  }

  async function captureCheckoutOrder(orderId) {
    if (!orderId) {
      setCheckoutSession({ status: 'failed', lastError: 'Missing PayPal order ID for capture.' });
      renderCheckoutState();
      return;
    }

    const current = readCheckoutSession();
    setCheckoutSession({
      status: 'capturing',
      orderId,
      package: current?.package || selectedPackage || '',
      flow: current?.flow || 'redirect',
      lastError: '',
    });
    openPayModal();
    renderCheckoutState();

    try {
      const data = await requestCaptureOrder(orderId);
      updateCredits(data.credits);
      if (data.token) {
        saveSession(data);
        connectSSE();
      }
      schedulePreparePublishCredentials(true);

      setCheckoutSession({
        status: 'success',
        orderId,
        successMessage: data.alreadyApplied
          ? `Payment already applied. Current balance: ${data.credits} credits.`
          : `+${data.added} credits added. New balance: ${data.credits} credits.`,
        lastError: '',
      });
      clearPayPalReturnParams();
      renderCheckoutState();
      resetPackageSelection();
      setTimeout(() => {
        clearCheckoutSession();
        closePayModal();
        renderCheckoutState();
      }, 2600);
    } catch (err) {
      setCheckoutSession({
        status: 'failed',
        orderId,
        lastError: err.message || 'Payment capture failed',
      });
      renderCheckoutState();
    }
  }

  async function renderPayPalButtonsForPackage(packageName) {
    const paypal = await loadPayPalSdk();
    if (!paypal?.Buttons) return false;

    const container = document.getElementById('paypalButtons');
    if (!container) return false;
    if (paypalButtonsInstance && typeof paypalButtonsInstance.close === 'function') {
      try { paypalButtonsInstance.close(); } catch {}
    }
    paypalButtonsInstance = null;
    container.innerHTML = '';
    paypalButtonsInstance = paypal.Buttons({
      style: {
        layout: 'vertical',
        shape: 'rect',
        label: 'paypal',
      },
      createOrder: async () => {
        try {
          setCheckoutSession({
            status: 'creating',
            package: packageName,
            flow: 'popup',
            orderId: '',
            approvalUrl: '',
            lastError: '',
          });
          renderCheckoutState();

          const created = await requestCreateOrder(packageName);
          setCheckoutSession({
            status: 'awaiting_approval',
            package: packageName,
            flow: 'popup',
            orderId: created.orderId,
            approvalUrl: created.approvalUrl,
            lastError: '',
          });
          renderCheckoutState();
          return created.orderId;
        } catch (err) {
          const message = err?.message || 'Could not create PayPal order.';
          setCheckoutSession({
            status: 'failed',
            package: packageName,
            flow: 'popup',
            lastError: message,
          });
          renderCheckoutState();
          await startRedirectFallback(packageName, 'Popup createOrder failed. Redirecting to PayPal…');
          throw err;
        }
      },
      onClick: () => {
        setCheckoutSession({
          status: 'awaiting_approval',
          package: packageName,
          flow: 'popup',
          lastError: '',
        });
        renderCheckoutState();
      },
      onApprove: async (data) => {
        const orderId = data?.orderID || readCheckoutSession()?.orderId || '';
        await captureCheckoutOrder(orderId);
      },
      onCancel: () => {
        setCheckoutSession({
          status: 'cancelled',
          package: packageName,
          flow: 'popup',
          lastError: 'Checkout was canceled at PayPal.',
        });
        renderCheckoutState();
      },
      onError: async (err) => {
        const message = err?.message || 'PayPal popup failed.';
        console.error('[paypal] popup onError:', err);
        setCheckoutSession({
          status: 'failed',
          package: packageName,
          flow: 'popup',
          lastError: message,
        });
        renderCheckoutState();
        await startRedirectFallback(packageName, 'Popup unavailable. Redirecting to PayPal…');
      },
    });

    if (typeof paypalButtonsInstance.isEligible === 'function' && !paypalButtonsInstance.isEligible()) {
      return false;
    }

    await paypalButtonsInstance.render('#paypalButtons');
    return true;
  }

  function updatePurchaseButtonState() {
    const btn = document.getElementById('purchaseBtn');
    const checkout = readCheckoutSession();
    const hasPendingCheckout = !!checkout && isCheckoutPending(checkout.status);
    const ready = !!selectedPackage
      && selectedPaymentMethod === 'paypal'
      && paypalEnabled
      && !hasPendingCheckout;

    btn.disabled = !ready;

    if (hasPendingCheckout) {
      btn.textContent = 'Payment in progress';
      return;
    }
    if (!selectedPackage) {
      btn.textContent = 'Select a package';
      return;
    }
    if (!paypalEnabled) {
      btn.textContent = 'PayPal not configured';
      return;
    }
    btn.textContent = 'Add Credits with PayPal';
  }

  // --- Package selection ---
  function selectPackage(pkg) {
    selectedPackage = pkg;
    ['starter', 'standard', 'pro'].forEach(p => {
      document.getElementById(`pkg-${p}`).classList.toggle('selected', p === pkg);
    });
    updatePurchaseButtonState();
  }
  function selectPaymentMethod(method) {
    const btn = document.getElementById(`pm-${method}`);
    if (!btn || btn.disabled) return;
    selectedPaymentMethod = method;
    document.querySelectorAll('.pm-btn:not(:disabled)').forEach(b => b.classList.remove('selected'));
    document.getElementById(`pm-${method}`)?.classList.add('selected');
    updatePurchaseButtonState();
  }

  async function refreshPaymentConfig() {
    paypalEnabled = false;
    paypalConfig = { enabled: false, env: 'sandbox', clientId: '', currency: 'USD', flow: 'popup-first' };

    try {
      const r = await fetch('/api/payments/paypal/config');
      const data = await r.json();
      paypalEnabled = !!data?.enabled;
      paypalConfig = {
        enabled: !!data?.enabled,
        env: data?.env || 'sandbox',
        clientId: data?.clientId || '',
        currency: data?.currency || 'USD',
        flow: data?.flow || 'popup-first',
      };
    } catch {
      paypalEnabled = false;
    }

    const paypalBtn = document.getElementById('pm-paypal');
    const paypalTag = document.getElementById('pm-paypal-tag');
    paypalBtn.disabled = !paypalEnabled;
    paypalBtn.classList.toggle('selected', paypalEnabled);
    if (!paypalEnabled && selectedPaymentMethod === 'paypal') {
      selectedPaymentMethod = '';
    }
    if (paypalEnabled) {
      selectedPaymentMethod = 'paypal';
    }

    if (paypalTag) {
      paypalTag.className = `pm-tag ${paypalEnabled ? 'active' : 'soon'}`;
      paypalTag.textContent = paypalEnabled
        ? (paypalConfig.flow === 'popup-first' ? 'popup' : 'redirect')
        : 'setup';
    }

    updatePurchaseButtonState();
  }

  // --- Purchase flow ---
  const PKG_PRICES = { starter: '$5.00', standard: '$20.00', pro: '$50.00' };

  async function purchase() {
    if (!selectedPackage || selectedPaymentMethod !== 'paypal') return;
    if (!paypalEnabled) {
      alert('PayPal is not configured on this server yet.');
      return;
    }
    if (!getToken()) {
      alert('Redeem a promo code first to create a session token.');
      return;
    }

    const existing = readCheckoutSession();
    if (existing && isCheckoutPending(existing.status)) {
      openPayModal(PKG_PRICES[existing.package] || '');
      renderCheckoutState();
      if (existing.status === 'awaiting_approval' && existing.flow === 'popup' && existing.package && paypalEnabled) {
        try {
          await renderPayPalButtonsForPackage(existing.package);
        } catch {
          await startRedirectFallback(existing.package, 'PayPal popup is unavailable. Redirecting…');
        }
      }
      return;
    }

    setCheckoutSession({
      status: 'awaiting_approval',
      package: selectedPackage,
      flow: paypalConfig.flow === 'redirect-first' ? 'redirect' : 'popup',
      orderId: '',
      approvalUrl: '',
      lastError: '',
    });
    openPayModal(PKG_PRICES[selectedPackage] || '');
    renderCheckoutState();

    if (paypalConfig.flow === 'redirect-first') {
      await startRedirectFallback(selectedPackage);
      return;
    }

    try {
      const rendered = await renderPayPalButtonsForPackage(selectedPackage);
      if (!rendered) {
        await startRedirectFallback(selectedPackage, 'PayPal popup is unavailable. Redirecting…');
      }
    } catch {
      await startRedirectFallback(selectedPackage, 'PayPal SDK unavailable. Redirecting…');
    }
  }

  async function resumeRedirectApproval() {
    const checkout = readCheckoutSession();
    if (!checkout || !checkout.package) return;
    if (checkout.approvalUrl) {
      window.open(checkout.approvalUrl, '_blank', 'noopener');
      return;
    }
    await startRedirectFallback(checkout.package, 'Recreating checkout link…');
  }

  async function retryPaymentCapture() {
    const checkout = readCheckoutSession();
    if (!checkout?.orderId) return;
    await captureCheckoutOrder(checkout.orderId);
  }

  async function restartPaymentFlow() {
    const checkout = readCheckoutSession();
    const pkg = checkout?.package || selectedPackage;
    clearCheckoutSession();
    renderCheckoutState();
    if (!pkg) return;
    selectPackage(pkg);
    await purchase();
  }

  async function handlePaypalReturn() {
    const url = new URL(window.location.href);
    const paypalState = url.searchParams.get('paypal');
    const orderIdFromReturn = String(url.searchParams.get('token') || '').trim();
    const hasReturnParams = !!paypalState || !!orderIdFromReturn || !!url.searchParams.get('PayerID');

    if (hasReturnParams) {
      clearPayPalReturnParams();
      if (paypalState === 'cancelled') {
        const current = readCheckoutSession();
        setCheckoutSession({
          status: 'cancelled',
          package: current?.package || selectedPackage || '',
          flow: current?.flow || 'redirect',
          orderId: current?.orderId || '',
          approvalUrl: current?.approvalUrl || '',
          lastError: 'PayPal checkout was canceled.',
        });
        openPayModal();
        renderCheckoutState();
        return;
      }

      if (!orderIdFromReturn) {
        setCheckoutSession({
          status: 'failed',
          lastError: 'PayPal return is missing order token.',
        });
        openPayModal();
        renderCheckoutState();
        return;
      }

      const current = readCheckoutSession();
      setCheckoutSession({
        status: 'returning',
        package: current?.package || selectedPackage || '',
        flow: current?.flow || 'redirect',
        orderId: orderIdFromReturn,
      });
      openPayModal();
      renderCheckoutState();
      await captureCheckoutOrder(orderIdFromReturn);
      return;
    }

    const checkout = readCheckoutSession();
    if (checkout && isCheckoutPending(checkout.status)) {
      openPayModal(PKG_PRICES[checkout.package] || '');
      renderCheckoutState();
      if (checkout.status === 'awaiting_approval' && checkout.flow === 'popup' && checkout.package && paypalEnabled) {
        try {
          await renderPayPalButtonsForPackage(checkout.package);
        } catch {
          await startRedirectFallback(checkout.package, 'PayPal popup is unavailable. Redirecting…');
        }
      }
      if ((checkout.status === 'returning' || checkout.status === 'capturing') && checkout.orderId) {
        await captureCheckoutOrder(checkout.orderId);
      }
    } else {
      renderCheckoutState();
    }
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
    document.getElementById('paymentResumeBanner').style.display = 'none';
    document.getElementById('zeroCreditOverlay').style.display = 'none';
  }
  function hideGate() {
    document.getElementById('welcomeGate').style.display = 'none';
    document.querySelector('header').style.display = '';
    document.querySelector('main').style.display = '';
    updateResumeBanner();
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
  hydrateCheckoutSession();
  updateRtmpUrl();
  updateStreamUrls({ schedulePrepare: false });
  updatePurchaseButtonState();
  refreshPaymentConfig().then(() => {
    if (getToken()) {
      connectSSE();
      schedulePreparePublishCredentials(true);
      handlePaypalReturn();
    } else {
      showGate();
    }
  });
