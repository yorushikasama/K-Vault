#!/usr/bin/env node
/**
 * Runs the test suite, then sweeps the scratch directories it leaves in data/.
 *
 * The sweep has to be a separate step rather than something the test process
 * does for itself: the SQLite handle behind each scratch database belongs to
 * the container module, so on Windows the file stays locked until that process
 * is gone — the locks drop exactly as the code that could unlink them exits.
 *
 * mocha is launched as `node node_modules/mocha/bin/mocha.js` rather than
 * through node_modules/.bin or npx: those add a .cmd or shell layer that stays
 * alive as a child of this process and keeps holding the very files the sweep
 * is trying to remove.
 *
 * The sweep runs whether or not the tests passed, and mocha's exit code is
 * what this script exits with, so a failure still fails the command.
 */
const { spawnSync } = require('node:child_process');
const path = require('node:path');

const root = path.join(__dirname, '..');

const mocha = spawnSync(process.execPath, [path.join(root, 'node_modules', 'mocha', 'bin', 'mocha.js')], {
  cwd: root,
  stdio: 'inherit',
});

const sweep = spawnSync(process.execPath, [path.join(root, 'test', 'helpers', 'sweep-test-dirs.js')], {
  cwd: root,
  stdio: 'inherit',
});

process.exit(mocha.status === null ? 1 : mocha.status);