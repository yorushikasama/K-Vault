/**
 * Bounded in-memory registry for long-running jobs.
 *
 * Media resolution is the workload this exists for: a download can take minutes,
 * which is far too long to hold an HTTP request open, so the work runs detached
 * and the caller polls. The registry is deliberately generic — it knows nothing
 * about yt-dlp or storage, it just tracks state, progress and cancellation.
 *
 * Bounded on purpose. Finished jobs are kept so a client that polled a second
 * late still sees the outcome, but the history is capped and trimmed oldest-first
 * so a busy deployment cannot grow this without limit. Nothing here is persisted:
 * a restart loses the history, and a client polling a job that no longer exists
 * is told so rather than being left to hang.
 */

const crypto = require('node:crypto');

const DEFAULT_HISTORY = 64;
const DEFAULT_TIMEOUT_MS = 30 * 60 * 1000;

const TERMINAL_STATES = new Set(['succeeded', 'failed', 'cancelled']);

class JobNotFoundError extends Error {
  constructor(id) {
    super('任务不存在或已过期。');
    this.name = 'JobNotFoundError';
    this.code = 'JOB_NOT_FOUND';
    this.status = 404;
    this.detail = `No job with id ${id} is being tracked.`;
  }
}

function createJobRegistry({ historySize = DEFAULT_HISTORY, now = Date.now } = {}) {
  const maxHistory = Math.max(1, Number(historySize) || DEFAULT_HISTORY);
  const jobs = new Map();

  // Insertion order is oldest-first, so the first non-running entry is the one
  // to drop. Running jobs are never evicted, however old.
  function trim() {
    if (jobs.size <= maxHistory) return;
    for (const [id, job] of jobs) {
      if (jobs.size <= maxHistory) break;
      if (job.state === 'running') continue;
      jobs.delete(id);
    }
  }

  function publicView(job) {
    if (!job) return null;
    const elapsedMs = (job.finishedAt || now()) - job.startedAt;
    return {
      id: job.id,
      state: job.state,
      createdAt: job.createdAt,
      startedAt: job.startedAt,
      finishedAt: job.finishedAt,
      elapsedMs: Math.max(0, elapsedMs),
      url: job.url,
      kind: job.kind,
      progress: job.progress,
      result: job.result,
      error: job.error,
      warnings: job.warnings,
    };
  }

  return {
    /**
     * Registers a job and starts `runner`. The runner receives an object with
     * `setProgress`, `setResult`, `setWarnings` and `signal`; whatever it
     * resolves with becomes the job result unless `setResult` already ran.
     *
     * Errors are captured onto the job rather than rethrown: nothing awaits this
     * promise, so an escaping rejection would be an unhandled one.
     */
    start({ kind = 'media-resolve', url = '', timeoutMs = DEFAULT_TIMEOUT_MS } = {}, runner) {
      const id = `job_${crypto.randomBytes(8).toString('hex')}`;
      const timestamp = now();
      const controller = new AbortController();

      const job = {
        id,
        kind,
        url,
        state: 'running',
        createdAt: timestamp,
        startedAt: timestamp,
        finishedAt: 0,
        progress: { stage: 'queued', percent: 0 },
        result: null,
        error: null,
        warnings: [],
        controller,
      };
      jobs.set(id, job);
      trim();

      const hardStop = setTimeout(() => {
        if (job.state !== 'running') return;
        controller.abort();
        // The runner is responsible for actually killing its child process; this
        // only guarantees a job cannot sit in "running" forever if it does not.
        job.state = 'failed';
        job.finishedAt = now();
        job.error = {
          code: 'JOB_TIMEOUT',
          message: '任务超时。',
          detail: `Job exceeded ${Math.round(timeoutMs / 1000)}s.`,
        };
      }, Math.max(1000, Number(timeoutMs) || DEFAULT_TIMEOUT_MS));
      // Never hold the event loop open for a job.
      if (typeof hardStop.unref === 'function') hardStop.unref();

      const api = {
        id,
        signal: controller.signal,
        setProgress(patch) {
          if (job.state !== 'running') return;
          job.progress = { ...job.progress, ...patch, updatedAt: now() };
        },
        setWarnings(list) {
          if (Array.isArray(list)) job.warnings = list;
        },
        setResult(value) {
          job.result = value;
        },
        isCancelled() {
          return controller.signal.aborted;
        },
      };

      Promise.resolve()
        .then(() => {
          // Cancelled before the runner ever got a turn. Handing it a signal
          // that is already aborted would be a trap: a listener added to an
          // aborted signal never fires, so a runner that waits on one would
          // hang until the hard timeout. Short-circuit instead.
          if (controller.signal.aborted) {
            job.state = 'cancelled';
            job.finishedAt = now();
            job.error = {
              code: 'JOB_CANCELLED',
              message: '任务已取消。',
              detail: 'The job was cancelled before it started.',
            };
            return null;
          }
          return runner(api);
        })
        .then((value) => {
          if (job.state !== 'running') return;
          job.state = 'succeeded';
          job.finishedAt = now();
          if (job.result == null) job.result = value == null ? null : value;
          job.progress = { ...job.progress, stage: 'done', percent: 100 };
        })
        .catch((error) => {
          if (job.state !== 'running') return;
          job.finishedAt = now();
          if (controller.signal.aborted) {
            job.state = 'cancelled';
            job.error = {
              code: 'JOB_CANCELLED',
              message: '任务已取消。',
              detail: 'The job was cancelled before it finished.',
            };
            return;
          }
          job.state = 'failed';
          job.error = {
            code: (error && error.code) || 'JOB_FAILED',
            message: (error && error.message) || '任务失败。',
            detail: (error && error.detail) || String(error && error.message || error || 'unknown'),
            retriable: Boolean(error && error.retriable),
          };
        })
        .finally(() => {
          clearTimeout(hardStop);
          // Trimming has to happen when a job *finishes*, not only when one
          // starts: a burst of jobs that all settle afterwards would otherwise
          // never be reaped, since each new start saw a full complement of
          // running jobs it was not allowed to evict.
          trim();
        });

      return publicView(job);
    },

    get(id) {
      const job = jobs.get(String(id || ''));
      return job ? publicView(job) : null;
    },

    require(id) {
      const view = this.get(id);
      if (!view) throw new JobNotFoundError(id);
      return view;
    },

    list({ state = '', limit = 50 } = {}) {
      const out = [];
      // Newest first: that is the order a caller wants a history in.
      const all = Array.from(jobs.values()).reverse();
      for (const job of all) {
        if (state && job.state !== state) continue;
        out.push(publicView(job));
        if (out.length >= Math.max(1, Number(limit) || 50)) break;
      }
      return out;
    },

    /**
     * Signals cancellation and reports whether a running job was found. The
     * runner is expected to notice `signal` and tear down its child process;
     * the state is only marked cancelled once it actually unwinds, so a caller
     * cannot see "cancelled" while work is still in flight.
     */
    cancel(id) {
      const job = jobs.get(String(id || ''));
      if (!job) return false;
      if (TERMINAL_STATES.has(job.state)) return false;
      job.controller.abort();
      return true;
    },

    stats() {
      let running = 0;
      for (const job of jobs.values()) {
        if (job.state === 'running') running += 1;
      }
      return { tracked: jobs.size, running, historySize: maxHistory };
    },

    // Only for tests and shutdown.
    clear() {
      for (const job of jobs.values()) {
        if (job.state === 'running') job.controller.abort();
      }
      jobs.clear();
    },
  };
}

module.exports = {
  createJobRegistry,
  JobNotFoundError,
  TERMINAL_STATES,
  DEFAULT_HISTORY,
};
