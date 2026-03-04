const { withClient } = require('./db/client');
const { getPublishers, kickUrl, mtxFetch } = require('./mediamtx');
const { extractSessionIdFromPath } = require('./sessions');
const { deductCredits } = require('./repo/creditsRepo');

const CREDIT_BURN_ADVISORY_LOCK_KEY = 700321;

function groupActiveStreamsBySession(publishers) {
  const counts = new Map();
  for (const conn of publishers) {
    const sessionId = extractSessionIdFromPath(conn.path);
    if (!sessionId) continue;
    counts.set(sessionId, (counts.get(sessionId) || 0) + 1);
  }
  return counts;
}

async function kickSessionStreamsByPrefix(sessionId, prefix) {
  try {
    const publishers = await getPublishers();
    const owned = publishers.filter((conn) => conn.path.startsWith(prefix));
    await Promise.all(owned.map((conn) => mtxFetch(kickUrl(conn), { method: 'POST' })));
    console.log(`[credits] Session ${sessionId}: ${owned.length} stream(s) disconnected (credits exhausted)`);
  } catch (err) {
    console.error(`[credits] Session ${sessionId}: Failed to kick streams:`, err.message);
  }
}

async function tryAcquireBurnLock(client) {
  const result = await client.query('SELECT pg_try_advisory_lock($1) AS locked', [CREDIT_BURN_ADVISORY_LOCK_KEY]);
  return Boolean(result.rows[0]?.locked);
}

async function releaseBurnLock(client) {
  await client.query('SELECT pg_advisory_unlock($1)', [CREDIT_BURN_ADVISORY_LOCK_KEY]);
}

function startCreditDeductionInterval() {
  setInterval(async () => {
    try {
      await withClient(async (client) => {
        const locked = await tryAcquireBurnLock(client);
        if (!locked) return;

        try {
          const publishers = await getPublishers();
          const activeBySession = groupActiveStreamsBySession(publishers);

          for (const [sessionId, active] of activeBySession) {
            if (active <= 0) continue;

            try {
              const mutation = await deductCredits(sessionId, active, {
                eventType: 'burn',
                meta: { activeStreams: active },
              });

              if (!mutation) continue;

              if (mutation.delta !== 0) {
                console.log(
                  `[credits] Session ${sessionId}: ${mutation.delta} (${active} stream${active > 1 ? 's' : ''}), balance: ${mutation.credits}`,
                );
              }

              if (mutation.credits === 0) await kickSessionStreamsByPrefix(sessionId, mutation.prefix);
            } catch (err) {
              console.error(`[credits] Session ${sessionId}: failed to deduct credits:`, err.message);
            }
          }
        } finally {
          await releaseBurnLock(client);
        }
      });
    } catch {
      // MediaMTX or database not reachable yet
    }
  }, 60_000);
}

module.exports = {
  groupActiveStreamsBySession,
  startCreditDeductionInterval,
};
