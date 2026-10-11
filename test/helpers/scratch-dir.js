const fs = require('node:fs');
const path = require('node:path');

// Scratch root for the suites, deliberately outside the repo's data/.
//
// data/ is the deployment's DATA_DIR — on the live box it holds k-vault.db and
// the cookies, and it is what an operator looks at when judging disk usage.
// Having the suites drop a throwaway database per test into it meant a test run
// on the server mixed its garbage into production state, which is how 560
// stale directories accumulated there unnoticed. Keeping tests out of data/
// means a stray leftover is harmless by construction rather than by cleanup.
//
// node's own temp dir is not used: it is per-user and gets pruned by the OS at
// unpredictable moments, and these databases need to outlive a single test
// without vanishing underneath a slow Windows filesystem.
const SCRATCH_ROOT = path.join(__dirname, '..', '..', '.test-scratch');

/**
 * Returns a fresh, empty directory for one test to scribble in.
 *
 * The name is unique per call, so a leaked directory from an earlier run is
 * never reused or clobbered — a new run simply makes another one, and
 * sweep-test-dirs.js clears the whole root when it is done.
 */
function makeScratchDir(label) {
  const unique = `${label}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  const dir = path.join(SCRATCH_ROOT, unique);
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

module.exports = {
  SCRATCH_ROOT,
  makeScratchDir,
};