const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert');
const { createApp } = require('../server/app');
const { initDatabase } = require('../server/db');
const { loadConfig } = require('../server/lib/config');
const { StorageConfigRepository } = require('../server/lib/repos/storage-config-repo');
const { UploadService } = require('../server/lib/services/upload-service');
const { removeTmpDir } = require('./helpers/sweep-test-dirs');
const { makeScratchDir } = require('./helpers/scratch-dir');

/**
 * 转存与直传共用同一条上限链的回归。
 *
 * 症状：同一个 26MB 文件直传 Discord 立刻 413（「上限 25MB」），从 URL
 * 转存却要等服务器把 26MB 全部拉完、写进 Discord API 被打回才失败 ——
 * 用户看到的是「上传方式不同、上限不同」。根因是 /api/upload-from-url
 * 只做了 min(URL_IMPORT_MAX_SIZE, UPLOAD_MAX_SIZE)，漏了 per-backend
 * 叠加，而直传（/upload、/api/v1/upload、chunked）和视频解析
 * （/api/resolve-url）三条路径都有。这里钉住四件事：
 *
 *  1. 同一文件、同一后端，直传 413 时转存也必须 413（Discord 25MB）；
 *  2. 换一个上限更宽的后端（Telegram 云 50MB）同一个文件要放行 ——
 *     证明 25MB 是 Discord 的物理限制，不是转存被全局压低；
 *  3. UploadService.uploadFromUrl 忘传 maxBytes 时回落 config 的
 *     min(URL_IMPORT, UPLOAD)，而不是旧的魔法 20MB；
 *  4. Pages 侧 status.js 与 upload-from-url.js 引用同一份
 *     functions/utils/upload-limits.js（数值单一来源，不再三处各自维护）。
 */
describe('URL import size caps match the direct-upload caps (Docker)', function () {
  this.timeout(20000);

  const originalEnv = { ...process.env };
  const originalFetch = globalThis.fetch;
  const dnsPromises = require('node:dns').promises;
  const originalLookup = dnsPromises.lookup;

  const MB = 1024 * 1024;
  const OVER_DISCORD = Buffer.alloc(26 * MB, 7);
  const REMOTE_URL = 'https://cdn.example.com/big.bin';
  const TG_API_PREFIX = 'https://api.telegram.org/bot';

  let tmpDir;
  let app;
  let authHeader;

  function remoteFileResponse() {
    return new Response(OVER_DISCORD, {
      status: 200,
      headers: {
        'Content-Type': 'application/octet-stream',
        'Content-Length': String(OVER_DISCORD.byteLength),
      },
    });
  }

  beforeEach(async function () {
    tmpDir = makeScratchDir('importcap');
    fs.mkdirSync(tmpDir, { recursive: true });

    process.env.CONFIG_ENCRYPTION_KEY = 'importcap_key_123456';
    process.env.SESSION_SECRET = 'importcap_secret_123456';
    process.env.DATA_DIR = tmpDir;
    process.env.DB_PATH = path.join(tmpDir, 'importcap.db');
    process.env.BASIC_USER = 'admin';
    process.env.BASIC_PASS = 'secret123';
    process.env.TG_BOT_TOKEN = '123456:importcap';
    process.env.TG_CHAT_ID = 'importcap-chat';
    process.env.DEFAULT_STORAGE_TYPE = 'telegram';
    process.env.API_CORS_ORIGINS = '';
    delete process.env.UPLOAD_MAX_SIZE;
    delete process.env.URL_IMPORT_MAX_SIZE;

    // DNS is stubbed so the SSRF guard sees a public address without any
    // network access; fetch is stubbed per URL below.
    dnsPromises.lookup = async () => [{ address: '93.184.216.34', family: 4 }];
    globalThis.fetch = async (input) => {
      const url = String(input instanceof Request ? input.url : input);
      if (url === REMOTE_URL) return remoteFileResponse();
      if (url.startsWith(TG_API_PREFIX)) {
        return new Response(
          JSON.stringify({ ok: true, result: { message_id: 1, document: { file_id: 'FAKE_FILE_ID' } } }),
          { status: 200, headers: { 'Content-Type': 'application/json' } },
        );
      }
      return new Response('not found', { status: 404 });
    };

    authHeader = `Basic ${Buffer.from('admin:secret123').toString('base64')}`;
    app = createApp();

    // The Discord case needs an enabled Discord config: resolveStorageSelection
    // falls back to the default (Telegram) when the requested type has no
    // enabled entry, which would make the cap 50MB instead of 25MB.
    const db = initDatabase(process.env.DB_PATH);
    const storageRepo = new StorageConfigRepository(db, loadConfig(process.env));
    storageRepo.create({
      name: 'Discord Cap Test',
      type: 'discord',
      config: { webhookUrl: 'https://discord.com/api/webhooks/x/y' },
      enabled: true,
    });
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
    globalThis.fetch = originalFetch;
    dnsPromises.lookup = originalLookup;
    removeTmpDir(tmpDir);
  });

  it('direct upload of a 26MB file to Discord is rejected with the backend cap', async function () {
    const form = new FormData();
    form.append('file', new File([OVER_DISCORD], 'big.bin', { type: 'application/octet-stream' }));
    form.append('storageMode', 'discord');

    const response = await app.fetch(new Request('http://localhost/upload', {
      method: 'POST',
      headers: { Authorization: authHeader },
      body: form,
    }));

    assert.strictEqual(response.status, 413);
    const payload = await response.json();
    assert.strictEqual(payload.errorCode || payload.code, 'STORAGE_FILE_TOO_LARGE');
  });

  it('the same 26MB URL import to Discord is rejected the same way, before the fetch finishes', async function () {
    const response = await app.fetch(new Request('http://localhost/api/upload-from-url', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: authHeader },
      body: JSON.stringify({ url: REMOTE_URL, storageMode: 'discord' }),
    }));

    assert.strictEqual(response.status, 413);
    const payload = await response.json();
    assert.strictEqual(payload.errorCode || payload.code, 'FILE_TOO_LARGE');
    // The message must name the real ceiling (Discord 25MB), not the 100MB global.
    const ceiling = String(payload.errorDetail || payload.error || payload.message || '');
    assert.ok(/25MB/.test(ceiling), JSON.stringify(payload));
  });

  it('the same 26MB URL import to Telegram passes its 50MB cloud cap and succeeds', async function () {
    const response = await app.fetch(new Request('http://localhost/api/upload-from-url', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: authHeader },
      body: JSON.stringify({ url: REMOTE_URL, storageMode: 'telegram' }),
    }));

    assert.strictEqual(response.status, 200);
    const payload = await response.json();
    // Envelope shape differs by API version (v2 wraps in data.items, legacy is
    // a bare array); the item with src is what both carry.
    const item = Array.isArray(payload)
      ? payload[0]
      : (Array.isArray(payload?.data?.items) ? payload.data.items[0] : payload?.data || payload);
    assert.ok(item && String(item.src || '').startsWith('/file/'), JSON.stringify(payload));
  });
});

describe('UploadService.uploadFromUrl default cap follows config, not a magic 20MB', function () {
  const originalFetch = globalThis.fetch;
  const dnsPromises = require('node:dns').promises;
  const originalLookup = dnsPromises.lookup;

  beforeEach(function () {
    dnsPromises.lookup = async () => [{ address: '93.184.216.34', family: 4 }];
  });

  afterEach(function () {
    globalThis.fetch = originalFetch;
    dnsPromises.lookup = originalLookup;
  });

  function makeService(config) {
    const uploaded = [];
    const service = new UploadService({
      storageRepo: {
        resolveStorageSelection: () => ({ id: 'sc_tg', name: 'TG', type: 'telegram', enabled: true, config: {} }),
      },
      fileRepo: {
        create(payload) {
          return { id: payload.id, file_name: payload.fileName, metadata: payload.extra || {} };
        },
      },
      storageFactory: {
        createAdapter: () => ({
          supportsStreamingUpload: true,
          async upload(args) {
            uploaded.push(args);
            return { storageKey: args.storageKey, metadata: {} };
          },
        }),
      },
      config,
    });
    return { service, uploaded };
  }

  function stubFetch(body, contentType) {
    globalThis.fetch = async () => new Response(body, {
      status: 200,
      headers: { 'Content-Type': contentType, 'Content-Length': String(Buffer.byteLength(body)) },
    });
  }

  const MB = 1024 * 1024;

  it('falls back to min(urlImportMaxSize, uploadMaxSize) when maxBytes is omitted', async function () {
    // 30MB import cap vs a 26MB file: the old magic default (20MB) would have
    // refused it; the config-derived default must let it through.
    const { service, uploaded } = makeService({ urlImportMaxSize: 30 * MB, uploadMaxSize: 100 * MB });
    assert.strictEqual(service.defaultImportMaxBytes, 30 * MB);
    stubFetch('x'.repeat(26 * MB), 'image/png');

    const result = await service.uploadFromUrl({ url: 'https://cdn.example.com/pic.png' });
    assert.ok(result);
    assert.strictEqual(uploaded.length, 1, '26MB 文件在 30MB 导入上限下应当被放行');
  });

  it('still refuses past the config-derived cap', async function () {
    const { service, uploaded } = makeService({ urlImportMaxSize: 10 * MB, uploadMaxSize: 100 * MB });
    stubFetch('x'.repeat(26 * MB), 'image/png');

    await assert.rejects(
      () => service.uploadFromUrl({ url: 'https://cdn.example.com/pic.png' }),
      (error) => error.code === 'FILE_TOO_LARGE' && /10MB/.test(error.message),
    );
    assert.strictEqual(uploaded.length, 0);
  });
});

describe('Pages: status and upload-from-url share one limits source', function () {
  const readSheet = (name) => fs.readFileSync(path.join(__dirname, '..', name), 'utf8');

  it('status.js consumes getUploadLimits from the shared module and declares none of its own', function () {
    const src = readSheet('functions/api/status.js');
    assert.ok(
      /import\s*\{[^}]*getUploadLimits[^}]*\}\s*from\s*['"][^'"]*upload-limits\.js['"]/.test(src),
      'status.js 必须从 functions/utils/upload-limits.js 导入 getUploadLimits',
    );
    assert.ok(!/maxBytes:\s*\d/.test(src), 'status.js 不得再本地定义 maxBytes 数字（回到双源会重新引入转存/直传上限漂移）');
  });

  it('upload-from-url.js consumes validateStorageSize from the shared module', function () {
    const src = readSheet('functions/api/upload-from-url.js');
    assert.ok(
      /import\s*\{[^}]*validateStorageSize[^}]*\}\s*from\s*["'][^"']*upload-limits\.js["']/.test(src),
      'upload-from-url.js 必须从 functions/utils/upload-limits.js 导入 validateStorageSize',
    );
    assert.ok(!/function validateStorageSize/.test(src), 'upload-from-url.js 不得保留本地 validateStorageSize 定义');
  });

  it('the shared module exposes the documented caps', async function () {
    const limits = await import('../functions/utils/upload-limits.js');
    const MB = 1024 * 1024;

    const matrix = limits.getUploadLimits();
    assert.strictEqual(matrix.telegram.maxBytes, 20 * MB);
    assert.strictEqual(matrix.discord.maxBytes, 25 * MB);
    assert.strictEqual(matrix.huggingface.maxBytes, 35 * MB);
    assert.strictEqual(matrix.r2.maxBytes, 100 * MB);

    assert.strictEqual(limits.validateStorageSize('discord', 25 * MB + 1).ok, false);
    assert.strictEqual(limits.validateStorageSize('discord', 25 * MB).ok, true);
    assert.strictEqual(limits.validateStorageSize('r2', 100 * MB).ok, true);
  });

  it('resolveUrlImportMaxSize falls back to UPLOAD_MAX_SIZE then 100MB', async function () {
    const { resolveUrlImportMaxSize } = await import('../functions/utils/upload-limits.js');
    const MB = 1024 * 1024;

    assert.strictEqual(resolveUrlImportMaxSize({ URL_IMPORT_MAX_SIZE: String(50 * MB) }), 50 * MB);
    assert.strictEqual(resolveUrlImportMaxSize({ UPLOAD_MAX_SIZE: String(20 * MB) }), 20 * MB);
    assert.strictEqual(resolveUrlImportMaxSize({}), 100 * MB);
  });
});