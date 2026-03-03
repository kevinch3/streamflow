const { sessions } = require('./sessions');
const { getPublishers, kickUrl, mtxFetch } = require('./mediamtx');

async function kickSessionStreams(session) {
  try {
    const publishers = await getPublishers();
    const owned = publishers.filter(c => c.path.startsWith(session.prefix));
    await Promise.all(owned.map(c => mtxFetch(kickUrl(c), { method: 'POST' })));
    console.log(`[credits] Session ${session.id}: ${owned.length} stream(s) disconnected (credits exhausted)`);
  } catch (e) {
    console.error(`[credits] Session ${session.id}: Failed to kick streams:`, e.message);
  }
}

function startCreditDeductionInterval() {
  setInterval(async () => {
    try {
      const publishers = await getPublishers();
      for (const session of sessions.values()) {
        const owned = publishers.filter(c => c.path.startsWith(session.prefix));
        const active = owned.length;
        if (active > 0 && session.credits > 0) {
          session.credits = Math.max(0, session.credits - active);
          console.log(`[credits] Session ${session.id}: -${active} (${active} stream${active > 1 ? 's' : ''}), balance: ${session.credits}`);
          if (session.credits === 0) await kickSessionStreams(session);
        }
      }
    } catch {
      // MediaMTX not reachable yet
    }
  }, 60_000);
}

module.exports = {
  kickSessionStreams,
  startCreditDeductionInterval,
};
