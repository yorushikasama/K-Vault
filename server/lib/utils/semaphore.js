/**
 * Counting semaphore with a bounded queue.
 *
 * Extracted because two places now need the same thing: media resolution
 * (already had it inline) and the upload paths (had nothing at all). Keeping one
 * implementation means the release-on-throw discipline cannot drift between them.
 *
 * `buildBusyError` lets each caller keep its own error type: the media resolver
 * throws a MediaResolveError, the upload gate throws a plain coded error that the
 * route turns into a 503.
 */

function createSemaphore({ limit = 1, queueLimit = 0, buildBusyError } = {}) {
  const maxConcurrency = Math.max(1, Number(limit) || 1);
  const maxQueue = Math.max(0, Number(queueLimit) || 0);

  let active = 0;
  const waiters = [];

  const busyError = () => {
    const info = { limit: maxConcurrency, queued: waiters.length };
    return typeof buildBusyError === 'function' ? buildBusyError(info) : new Error('Semaphore busy.');
  };

  return {
    /**
     * Resolves once a slot is held. Callers MUST release in a `finally` — a
     * missed release permanently shrinks the pool.
     */
    async acquire() {
      if (active < maxConcurrency) {
        active += 1;
        return;
      }
      if (waiters.length >= maxQueue) throw busyError();
      await new Promise((resolve) => waiters.push(resolve));
      // The slot was handed straight over by release(); it was never decremented,
      // so nothing to increment here.
    },

    release() {
      const next = waiters.shift();
      if (next) {
        next();
        return;
      }
      active = Math.max(0, active - 1);
    },

    snapshot() {
      return { active, queued: waiters.length, limit: maxConcurrency, queueLimit: maxQueue };
    },
  };
}

module.exports = { createSemaphore };
