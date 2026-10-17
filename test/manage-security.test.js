const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const { createApp } = require('../server/app');
const { removeTmpDir } = require('./helpers/sweep-test-dirs');
const { makeScratchDir } = require('./helpers/scratch-dir');

/**
 * Manage API fail-closed security (SEC-03).
 *
 * /api/manage/** used to be fail-open on both runtimes: with no
 * BASIC_USER/BASIC_PASS configured, anonymous callers could reach write
 * endpoints (delete, editName, toggleLike, block, white, move-folder) and the
 * read endpoints alike. These tests pin the fail-closed contract — 503
 * ADMIN_AUTH_NOT_CONFIGURED, the same envelope /api/admin/** already uses —
 * on both the Docker server (Hono app.use middleware) and the Pages Functions
 * middleware chain. Session endpoints (login/logout/check) are part of the
 * auth flow and must stay reachable.
 */
describe('Manage API fail-closed security', function () {
  this.timeout(10000);

  describe('Docker server', function () {
    const originalEnv = { ...process.env };
    let tmpDir;

    beforeEach(function () {
      tmpDir = makeScratchDir('manage-sec');
      fs.mkdirSync(tmpDir, { recursive: true });

      process.env.CONFIG_ENCRYPTION_KEY = 'manage_sec_key_123456';
      process.env.SESSION_SECRET = 'manage_sec_secret_123456';
      process.env.DATA_DIR = tmpDir;
      process.env.DB_PATH = path.join(tmpDir, 'manage-sec.db');
      process.env.BASIC_USER = '';
      process.env.BASIC_PASS = '';
      process.env.TG_BOT_TOKEN = '';
      process.env.TG_CHAT_ID = '';
      process.env.DEFAULT_STORAGE_TYPE = 'telegram';
    });

    afterEach(function () {
      for (const key of Object.keys(process.env)) {
        if (!(key in originalEnv)) {
          delete process.env[key];
        }
      }
      for (const [key, value] of Object.entries(originalEnv)) {
        process.env[key] = value;
      }
      removeTmpDir(tmpDir);
    });

    const manageRoutes = [
      ['GET', '/api/manage/list', null],
      ['GET', '/api/manage/folders', null],
      ['POST', '/api/manage/folders', JSON.stringify({ name: 'x' })],
      ['PUT', '/api/manage/folders', JSON.stringify({ path: 'x' })],
      ['DELETE', '/api/manage/folders?path=x', null],
      ['POST', '/api/manage/files/move-folder', JSON.stringify({ ids: ['a'], targetFolderPath: 'b' })],
      ['GET', '/api/manage/toggleLike/some-id', null],
      ['GET', '/api/manage/editName/some-id?newName=x', null],
      ['GET', '/api/manage/block/some-id', null],
      ['GET', '/api/manage/white/some-id', null],
      ['GET', '/api/manage/delete/some-id', null],
      ['GET', '/api/manage/settings', null],
      ['POST', '/api/manage/settings', JSON.stringify({})],
    ];

    it('returns 503 ADMIN_AUTH_NOT_CONFIGURED on every manage route when auth is unconfigured', async function () {
      const app = createApp();
      for (const [method, url, body] of manageRoutes) {
        const response = await app.fetch(new Request(`http://localhost${url}`, {
          method,
          headers: body ? { 'Content-Type': 'application/json' } : {},
          body: body || undefined,
        }));
        const payload = await response.json();
        assert.strictEqual(response.status, 503, `${method} ${url} -> ${response.status}`);
        assert.strictEqual(payload.error?.code, 'ADMIN_AUTH_NOT_CONFIGURED', `${method} ${url}`);
      }
    });

    it('keeps the session endpoints reachable when auth is unconfigured', async function () {
      const app = createApp();
      for (const url of ['/api/manage/check', '/api/manage/login', '/api/manage/logout']) {
        const response = await app.fetch(new Request(`http://localhost${url}`));
        assert.notStrictEqual(response.status, 503, `${url} must not be blocked by the fail-closed gate`);
      }
    });

    it('returns 401 when auth is configured but credentials are missing (existing semantics)', async function () {
      process.env.BASIC_USER = 'admin';
      process.env.BASIC_PASS = 'secret123';
      const app = createApp();
      const response = await app.fetch(new Request('http://localhost/api/manage/list'));
      assert.strictEqual(response.status, 401);
    });

    it('still serves the manage list with valid credentials', async function () {
      process.env.BASIC_USER = 'admin';
      process.env.BASIC_PASS = 'secret123';
      const authHeader = `Basic ${Buffer.from('admin:secret123').toString('base64')}`;
      const app = createApp();
      const response = await app.fetch(new Request('http://localhost/api/manage/list', {
        headers: { Authorization: authHeader },
      }));
      assert.strictEqual(response.status, 200);
      const payload = await response.json();
      assert.ok(payload && typeof payload === 'object', 'the list payload keeps its existing shape');
    });
  });

  describe('Pages Functions middleware', function () {
    function createMockKv() {
      return {
        async getWithMetadata() {
          return { value: null, metadata: null };
        },
        async put() {},
        async delete() {},
        async list() {
          return { list_complete: true, keys: [] };
        },
      };
    }

    async function runMiddleware(request, env) {
      const { onRequest } = await import('../functions/api/manage/_middleware.js');
      const dispatch = (i) => {
        if (i >= onRequest.length) return Promise.resolve(new Response('endpoint reached'));
        return onRequest[i]({ request, env, next: () => dispatch(i + 1) });
      };
      return dispatch(0);
    }

    const unconfiguredEnv = () => ({ img_url: createMockKv() });
    const configuredEnv = () => ({
      img_url: createMockKv(),
      BASIC_USER: 'admin',
      BASIC_PASS: 'secret123',
    });

    const protectedPaths = [
      '/api/manage/delete/some-id',
      '/api/manage/editName/some-id?newName=x',
      '/api/manage/toggleLike/some-id',
      '/api/manage/block/some-id',
      '/api/manage/white/some-id',
      '/api/manage/files/move-folder',
      '/api/manage/list',
      '/api/manage/folders',
    ];

    for (const url of protectedPaths) {
      it(`blocks ${url} with 503 when auth is unconfigured`, async function () {
        const response = await runMiddleware(
          new Request(`https://example.com${url}`, { method: 'POST' }),
          unconfiguredEnv()
        );
        const payload = await response.json();

        assert.strictEqual(response.status, 503, `${url} should fail closed`);
        assert.strictEqual(payload.error?.code, 'ADMIN_AUTH_NOT_CONFIGURED');
      });
    }

    for (const url of ['/api/manage/login', '/api/manage/logout', '/api/manage/check']) {
      it(`keeps ${url} reachable when auth is unconfigured`, async function () {
        const response = await runMiddleware(
          new Request(`https://example.com${url}`),
          unconfiguredEnv()
        );
        assert.notStrictEqual(response.status, 503, `${url} is part of the auth flow itself`);
        assert.notStrictEqual(response.status, 401, `${url} must not require an authenticated session`);
      });
    }

    it('returns 401 when auth is configured but credentials are missing', async function () {
      const response = await runMiddleware(
        new Request('https://example.com/api/manage/list'),
        configuredEnv()
      );
      assert.strictEqual(response.status, 401);
    });

    it('passes valid credentials through to the endpoint', async function () {
      const authHeader = `Basic ${Buffer.from('admin:secret123').toString('base64')}`;
      const response = await runMiddleware(
        new Request('https://example.com/api/manage/list', {
          headers: { Authorization: authHeader },
        }),
        configuredEnv()
      );
      assert.strictEqual(response.status, 200);
      assert.strictEqual(await response.text(), 'endpoint reached');
    });

    it('keeps the informational response when no KV namespace is bound', async function () {
      const response = await runMiddleware(
        new Request('https://example.com/api/manage/list'),
        {}
      );
      assert.strictEqual(response.status, 200);
      assert.match(await response.text(), /Dashboard is disabled/);
    });
  });
});