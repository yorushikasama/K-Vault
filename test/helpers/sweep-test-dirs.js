const fs = require('node:fs');
const path = require('node:path');

// Two levels up: this file lives in test/helpers, and the suites put their
// scratch directories in the repo's top-level data/.
const DATA_DIR = path.join(__dirname, '..', '..', 'data');
const POLL_MS = 300;
const MAX_WAIT_MS = 15000;

// Suites build their scratch database under data/tmp-<name>-<rand>, because
// DATA_DIR is what the config loader reads and a real path keeps the tests
// honest. The directories are gitignored and hold nothing but a throwaway db.
//
// Cleaning them per suite does not work. The SQLite handle belongs to the
// module that opened it (the container), not to the test, so on Windows the
// database stays locked with EPERM until that handle closes — which only
// happens as the process exits. A per-suite rmSync therefore always loses the
// race, and every run deposits a few hundred more. Two weeks of that had piled
// up in the deployment's data directory before this was found.
//
// Nor can the test process clean up after itself: the locks are released exactly
// when there is no code left running to do the unlink. This is therefore a
// separate step, run after mocha has exited — see scripts/run-tests.js.
//
// Even then the locks take a moment to drop: a sweep started the instant the
// runner returns still sees them, while the same sweep run a second later
// succeeds on everything first try. Hence the retry loop rather than a single
// pass.
function sweepOnce() {
  let entries;
  try {
    entries = fs.readdirSync(DATA_DIR, { withFileTypes: true });
  } catch {
    return { total: 0, removed: 0 };
  }

  let removed = 0;
  let total = 0;
  for (const entry of entries) {
    if (!entry.isDirectory() || !entry.name.startsWith('tmp-')) continue;
    total += 1;
    try {
      fs.rmSync(path.join(DATA_DIR, entry.name), { recursive: true, force: true });
      removed += 1;
    } catch {
      // Still locked; the next pass picks it up.
    }
  }
  return { total, removed };
}

function sweep() {
  const deadline = Date.now() + MAX_WAIT_MS;

  for (;;) {
    const { total, removed } = sweepOnce();
    if (total === 0) return 0;
    if (removed === total) {
      console.log(`[k-vault] test tmp sweep: removed ${removed}`);
      return removed;
    }
    if (Date.now() > deadline) {
      console.warn(
        `[k-vault] test tmp sweep: removed ${removed}/${total}, ${total - removed} still locked`
      );
      return removed;
    }
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, POLL_MS);
  }
}

// Suites still tidy up after themselves so a run does not accumulate garbage
// while it is still going; this is best-effort, and the runner above is what
// actually guarantees an empty directory.
function removeTmpDir(dir) {
  if (!dir) return;
  try {
    fs.rmSync(dir, { recursive: true, force: true, maxRetries: 15, retryDelay: 200 });
  } catch {
    // Locked; the post-run sweep gets it.
  }
}

if (require.main === module) {
  sweep();
  process.exit(0);
}

module.exports = {
  removeTmpDir,
  sweep,
};