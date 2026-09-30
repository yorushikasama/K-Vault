const assert = require('assert');

const {
  createJobRegistry,
  JobNotFoundError,
} = require('../server/lib/utils/job-registry');

// Polling beats a fixed sleep: the registry settles on microtasks, and a fixed
// delay makes these tests flaky on a loaded machine.
async function waitFor(predicate, { timeoutMs = 2000, intervalMs = 5 } = {}) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = predicate();
    if (value) return value;
    if (Date.now() > deadline) return null;
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }
}

describe('job-registry lifecycle', function () {
  it('starts a job in the running state', function () {
    const registry = createJobRegistry();
    const job = registry.start({ url: 'https://example.com/v' }, () => new Promise(() => {}));
    assert.strictEqual(job.state, 'running');
    assert.ok(job.id.startsWith('job_'));
    assert.strictEqual(job.url, 'https://example.com/v');
    registry.clear();
  });

  it('captures the runner result and marks success', async function () {
    const registry = createJobRegistry();
    const job = registry.start({}, async () => ({ src: '/file/a' }));

    const settled = await waitFor(() => {
      const current = registry.get(job.id);
      return current && current.state !== 'running' ? current : null;
    });

    assert.strictEqual(settled.state, 'succeeded');
    assert.deepStrictEqual(settled.result, { src: '/file/a' });
    assert.strictEqual(settled.progress.percent, 100);
    assert.ok(settled.finishedAt >= settled.startedAt);
    registry.clear();
  });

  it('records a failure with its code and retriable flag', async function () {
    const registry = createJobRegistry();
    const job = registry.start({}, async () => {
      const error = new Error('platform refused');
      error.code = 'MEDIA_RESOLVE_FORBIDDEN';
      error.detail = 'cookies stale';
      error.retriable = false;
      throw error;
    });

    const settled = await waitFor(() => {
      const current = registry.get(job.id);
      return current && current.state !== 'running' ? current : null;
    });

    assert.strictEqual(settled.state, 'failed');
    assert.strictEqual(settled.error.code, 'MEDIA_RESOLVE_FORBIDDEN');
    assert.strictEqual(settled.error.detail, 'cookies stale');
    assert.strictEqual(settled.error.retriable, false);
    registry.clear();
  });

  it('publishes progress while the job runs', async function () {
    const registry = createJobRegistry();
    const job = registry.start({}, async (api) => {
      api.setProgress({ stage: 'download', percent: 42 });
      await new Promise((resolve) => setTimeout(resolve, 20));
      return 'done';
    });

    const midway = await waitFor(() => {
      const current = registry.get(job.id);
      return current && current.progress.percent === 42 ? current : null;
    });
    assert.ok(midway, 'progress update must be observable while running');
    assert.strictEqual(midway.progress.stage, 'download');
    registry.clear();
  });
});

describe('job-registry cancellation', function () {
  it('marks a job cancelled when the runner observes the signal', async function () {
    const registry = createJobRegistry();
    const job = registry.start({}, async (api) => {
      await new Promise((resolve, reject) => {
        api.signal.addEventListener('abort', () => reject(new Error('aborted')));
      });
    });

    // Let the runner install its listener before cancelling.
    await new Promise((resolve) => setTimeout(resolve, 10));
    assert.strictEqual(registry.cancel(job.id), true);

    const settled = await waitFor(() => {
      const current = registry.get(job.id);
      return current && current.state !== 'running' ? current : null;
    });
    assert.strictEqual(settled.state, 'cancelled');
    assert.strictEqual(settled.error.code, 'JOB_CANCELLED');
    registry.clear();
  });

  it('cancels a job that was aborted before the runner got a turn', async function () {
    // A listener added to an already-aborted signal never fires, so the registry
    // has to short-circuit rather than hand the runner a dead signal.
    const registry = createJobRegistry();
    let runnerRan = false;
    const job = registry.start({}, async () => {
      runnerRan = true;
      return 'should not happen';
    });
    registry.cancel(job.id);

    const settled = await waitFor(() => {
      const current = registry.get(job.id);
      return current && current.state !== 'running' ? current : null;
    });
    assert.strictEqual(settled.state, 'cancelled');
    assert.strictEqual(runnerRan, false, 'the runner must not have started');
    registry.clear();
  });

  it('reports false when cancelling an unknown or finished job', async function () {
    const registry = createJobRegistry();
    assert.strictEqual(registry.cancel('job_nope'), false);

    const job = registry.start({}, async () => 'ok');
    await waitFor(() => {
      const current = registry.get(job.id);
      return current && current.state !== 'running';
    });
    assert.strictEqual(registry.cancel(job.id), false, 'a finished job cannot be cancelled');
    registry.clear();
  });

  it('fails a job that overruns its timeout', async function () {
    const registry = createJobRegistry();
    const job = registry.start({ timeoutMs: 1000 }, async () => new Promise(() => {}));

    const settled = await waitFor(() => {
      const current = registry.get(job.id);
      return current && current.state !== 'running' ? current : null;
    }, { timeoutMs: 3000 });

    assert.ok(settled, 'the job must settle rather than sit in running forever');
    assert.strictEqual(settled.state, 'failed');
    assert.strictEqual(settled.error.code, 'JOB_TIMEOUT');
    registry.clear();
  });
});

describe('job-registry history bounds', function () {
  it('throws a 404 for an unknown id', function () {
    const registry = createJobRegistry();
    assert.strictEqual(registry.get('job_missing'), null);
    assert.throws(() => registry.require('job_missing'), (error) => {
      assert.ok(error instanceof JobNotFoundError);
      assert.strictEqual(error.status, 404);
      return true;
    });
    registry.clear();
  });

  it('trims finished jobs oldest-first once the cap is reached', async function () {
    const registry = createJobRegistry({ historySize: 3 });
    const ids = [];
    for (let index = 0; index < 6; index += 1) {
      ids.push(registry.start({ url: `u${index}` }, async () => index).id);
    }
    await waitFor(() => registry.stats().running === 0);

    const stats = registry.stats();
    assert.ok(stats.tracked <= 3, `expected at most 3 tracked jobs, got ${stats.tracked}`);
    // The newest survive; the oldest are the ones dropped.
    assert.ok(registry.get(ids[5]) !== null, 'newest job must be retained');
    assert.strictEqual(registry.get(ids[0]), null, 'oldest job must be evicted');
    registry.clear();
  });

  it('never evicts a running job, however many finish around it', async function () {
    const registry = createJobRegistry({ historySize: 2 });
    const long = registry.start({}, async (api) => {
      await new Promise((resolve) => api.signal.addEventListener('abort', () => resolve()));
    });
    await new Promise((resolve) => setTimeout(resolve, 10));

    for (let index = 0; index < 10; index += 1) {
      registry.start({}, async () => index);
    }
    await waitFor(() => registry.stats().running === 1);

    const survivor = registry.get(long.id);
    assert.ok(survivor, 'a running job must survive trimming');
    assert.strictEqual(survivor.state, 'running');
    registry.clear();
  });

  it('lists newest first and honours a state filter', async function () {
    const registry = createJobRegistry();
    registry.start({ url: 'old' }, async () => 'a');
    await waitFor(() => registry.stats().running === 0);
    registry.start({ url: 'new' }, async () => 'b');
    await waitFor(() => registry.stats().running === 0);

    const all = registry.list();
    assert.strictEqual(all[0].url, 'new', 'newest first');
    assert.strictEqual(registry.list({ state: 'running' }).length, 0);
    assert.strictEqual(registry.list({ state: 'succeeded' }).length, 2);
    assert.strictEqual(registry.list({ limit: 1 }).length, 1);
    registry.clear();
  });

  it('aborts running jobs on clear', async function () {
    const registry = createJobRegistry();
    const job = registry.start({}, async (api) => {
      await new Promise((resolve) => api.signal.addEventListener('abort', () => resolve()));
      return 'done';
    });
    await new Promise((resolve) => setTimeout(resolve, 10));
    assert.strictEqual(registry.stats().running, 1);

    registry.clear();
    assert.strictEqual(registry.stats().tracked, 0);
    assert.strictEqual(registry.get(job.id), null);
  });
});
