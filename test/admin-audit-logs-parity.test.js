const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const { createApp } = require('../server/app');
const { removeTmpDir } = require('./helpers/sweep-test-dirs');
const { makeScratchDir } = require('./helpers/scratch-dir');

/**
 * 审计日志读取端点（requirement #12）双端 parity 契约。
 *
 * 背景：审计写入两端早就对齐（Pages 写 KV `audit:*`，Docker 写
 * `audit_logs` 表），但读取端点只有 Docker 端有——Pages 部署的审计事件
 * 写进 KV 后没有任何 API 途径读回，与 openapi.yaml 自我声明的
 * "Identical behavior on Docker and Cloudflare Pages deployments" 相悖。
 * functions/api/admin/audit-logs.js 补上缺的那半，本文件钉住两端同形。
 */

// ── Cloudflare 端 ──────────────────────────────────────────────────────────

/** 内存 KV：只实现 audit.js 用到的 get/put/delete/list 子集。 */
function makeKV() {
  const store = new Map();
  return {
    store,
    async put(key, value) { store.set(key, value); },
    async get(key, opts) {
      const value = store.get(key);
      if (value == null) return null;
      return opts?.type === 'json' ? JSON.parse(value) : value;
    },
    async delete(key) { store.delete(key); },
    async list({ prefix = '', limit = 1000, cursor } = {}) {
      const names = [...store.keys()].filter((k) => k.startsWith(prefix)).sort();
      const start = cursor ? Number(cursor) : 0;
      const page = names.slice(start, start + limit);
      const complete = start + limit >= names.length;
      return {
        keys: page.map((name) => ({ name })),
        list_complete: complete,
        cursor: complete ? undefined : String(start + limit),
      };
    },
  };
}

async function callFunctionsEndpoint(env, { method = 'GET', url, headers = {} } = {}) {
  const { onRequest: middleware } = await import('../functions/api/admin/_middleware.js');
  const { onRequest: endpoint } = await import('../functions/api/admin/audit-logs.js');
  const request = new Request(url, { method, headers });
  // Pages 运行时里中间件包住端点；这里手动串同一条链。
  return middleware({ request, env, next: () => endpoint({ request, env }) });
}

describe('audit-logs read endpoint parity (Cloudflare Pages)', function () {
  const seededRecords = [
    { event: 'TOKEN_CREATED', tokenId: 'tok-a', operation: 'admin.tokens.create', timestamp: 1000, success: true, client: 'ua-1', detail: 'name="a"' },
    { event: 'TOKEN_ROTATED', tokenId: 'tok-b', operation: 'admin.tokens.rotate', timestamp: 2000, success: true, client: 'ua-2', detail: null },
    { event: 'TOKEN_DELETED', tokenId: 'tok-c', operation: 'admin.tokens.delete', timestamp: 3000, success: false, client: null, detail: null },
  ];

  function makeEnv() {
    return {
      img_url: makeKV(),
      BASIC_USER: 'admin',
      BASIC_PASS: 'secret123',
    };
  }

  function seed(env) {
    // KV 键按字典序 = 时间序（base36 时间戳等长），listAuditLogs 依赖这一点。
    seed.recordKeys = seededRecords.map((record, i) => {
      const key = `audit:${(i + 1).toString(36)}:aabbcc`;
      env.img_url.store.set(key, JSON.stringify(record));
      return key;
    });
  }

  const authHeader = () => `Basic ${Buffer.from('admin:secret123').toString('base64')}`;

  it('middleware 链：未配置凭据 fail-closed 返回 503', async function () {
    const env = { img_url: makeKV(), BASIC_USER: '', BASIC_PASS: '' };
    const response = await callFunctionsEndpoint(env, { url: 'https://x.test/api/admin/audit-logs' });
    assert.strictEqual(response.status, 503);
    const payload = await response.json();
    assert.strictEqual(payload.error.code, 'ADMIN_AUTH_NOT_CONFIGURED');
  });

  it('middleware 链：凭据错误返回 401', async function () {
    const env = makeEnv();
    seed(env);
    const response = await callFunctionsEndpoint(env, {
      url: 'https://x.test/api/admin/audit-logs',
      headers: { Authorization: `Basic ${Buffer.from('admin:nope').toString('base64')}` },
    });
    assert.strictEqual(response.status, 401);
    const payload = await response.json();
    assert.strictEqual(payload.error.code, 'UNAUTHORIZED');
  });

  it('GET 返回 { success, logs }，按 timestamp 倒序，字段与 Docker 端同名', async function () {
    const env = makeEnv();
    seed(env);
    const response = await callFunctionsEndpoint(env, {
      url: 'https://x.test/api/admin/audit-logs',
      headers: { Authorization: authHeader() },
    });
    assert.strictEqual(response.status, 200);
    const payload = await response.json();
    assert.strictEqual(payload.success, true);
    assert.strictEqual(payload.logs.length, 3);
    assert.deepStrictEqual(
      payload.logs.map((log) => log.timestamp),
      [3000, 2000, 1000],
      '必须按 timestamp 倒序'
    );
    assert.deepStrictEqual(
      Object.keys(payload.logs[0]).sort(),
      ['client', 'detail', 'event', 'operation', 'success', 'timestamp', 'tokenId']
    );
    assert.strictEqual(typeof payload.logs[0].success, 'boolean');
  });

  it('limit 语义与 Docker 端一致：默认 100、min 1、max 500、非法回默认', async function () {
    const env = makeEnv();
    seed(env);
    const get = (query) => callFunctionsEndpoint(env, {
      url: `https://x.test/api/admin/audit-logs${query}`,
      headers: { Authorization: authHeader() },
    }).then((r) => r.json().then((p) => p.logs.length));

    assert.strictEqual(await get(''), 3, '无 limit → 默认 100，全部返回');
    assert.strictEqual(await get('?limit=2'), 2, 'limit=2 → 只取最新 2 条');
    assert.strictEqual(await get('?limit=0'), 1, 'limit=0 → 钳到 min 1，只返回最新 1 条');
    assert.strictEqual(await get('?limit=99999'), 3, 'limit=99999 → 钳到 max 500');
    assert.strictEqual(await get('?limit=abc'), 3, 'limit=abc → 回默认值 100');
  });

  it('非 GET 返回 405 METHOD_NOT_ALLOWED', async function () {
    const env = makeEnv();
    seed(env);
    const response = await callFunctionsEndpoint(env, {
      method: 'POST',
      url: 'https://x.test/api/admin/audit-logs',
      headers: { Authorization: authHeader(), 'Content-Type': 'application/json' },
      body: '{}',
    });
    assert.strictEqual(response.status, 405);
    const payload = await response.json();
    assert.strictEqual(payload.error.code, 'METHOD_NOT_ALLOWED');
  });

  it('KV 里的记录按 180 天 TTL 语义可读（writeAuditLog → listAuditLogs 回路）', async function () {
    const env = makeEnv();
    const { writeAuditLog, AUDIT_EVENTS } = await import('../functions/utils/audit.js');
    await writeAuditLog(env, {
      event: AUDIT_EVENTS.TOKEN_VERIFY_FAILED,
      tokenId: 'tok-x',
      operation: 'v1.verify',
      success: false,
      client: 'ua-test',
      detail: 'secret=yoruvault_1_abcdef should be redacted',
    });
    const response = await callFunctionsEndpoint(env, {
      url: 'https://x.test/api/admin/audit-logs',
      headers: { Authorization: authHeader() },
    });
    const payload = await response.json();
    assert.strictEqual(payload.logs.length, 1);
    assert.strictEqual(payload.logs[0].event, 'TOKEN_VERIFY_FAILED');
    assert.strictEqual(payload.logs[0].success, false);
    assert.ok(!/yoruvault_1_abcdef/.test(payload.logs[0].detail), '密钥必须被 redact');
  });
});

// ── Docker 端 + 双端 parity ────────────────────────────────────────────────

describe('audit-logs read endpoint parity (Docker)', function () {
  const originalEnv = { ...process.env };
  let tmpDir;

  beforeEach(function () {
    tmpDir = makeScratchDir('audit-parity');
    fs.mkdirSync(tmpDir, { recursive: true });
    process.env.CONFIG_ENCRYPTION_KEY = 'audit_parity_key_123456';
    process.env.SESSION_SECRET = 'audit_parity_secret_123456';
    process.env.DATA_DIR = tmpDir;
    process.env.DB_PATH = path.join(tmpDir, 'audit-parity.db');
    process.env.BASIC_USER = 'admin';
    process.env.BASIC_PASS = 'secret123';
    process.env.TG_BOT_TOKEN = '';
    process.env.TG_CHAT_ID = '';
    process.env.DEFAULT_STORAGE_TYPE = 'telegram';
  });

  afterEach(function () {
    for (const key of Object.keys(process.env)) {
      if (!(key in originalEnv)) delete process.env[key];
    }
    for (const [key, value] of Object.entries(originalEnv)) {
      process.env[key] = value;
    }
    removeTmpDir(tmpDir);
  });

  it('GET /api/admin/audit-logs 返回与 Pages 端同形的 { success, logs }', async function () {
    const app = createApp();
    const authHeader = `Basic ${Buffer.from('admin:secret123').toString('base64')}`;

    // 造一条真实审计事件（创建 token 会写 TOKEN_CREATED）。
    const createResponse = await app.fetch(new Request('http://localhost/api/admin/tokens', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: authHeader },
      body: JSON.stringify({ name: 'ci-bot', scopes: ['read'] }),
    }));
    assert.strictEqual(createResponse.status, 201);

    const response = await app.fetch(new Request('http://localhost/api/admin/audit-logs', {
      headers: { Authorization: authHeader },
    }));
    assert.strictEqual(response.status, 200);
    const payload = await response.json();
    assert.strictEqual(payload.success, true);
    assert.ok(Array.isArray(payload.logs) && payload.logs.length >= 1);
    const entry = payload.logs[0];
    assert.strictEqual(entry.event, 'TOKEN_CREATED');
    assert.strictEqual(typeof entry.success, 'boolean');

    // Parity 核心：两端记录的键集合必须完全一致。
    const dockerKeys = Object.keys(entry).sort();
    const pagesKeys = ['client', 'detail', 'event', 'operation', 'success', 'timestamp', 'tokenId'];
    assert.deepStrictEqual(dockerKeys, pagesKeys,
      `Docker 端记录字段 ${JSON.stringify(dockerKeys)} 与 Pages 端 ${JSON.stringify(pagesKeys)} 不一致`);
  });

  it('limit 语义与 Pages 端一致（非法值回默认、上限 500）', async function () {
    const app = createApp();
    const authHeader = `Basic ${Buffer.from('admin:secret123').toString('base64')}`;

    // 先造一条真实审计事件，否则 logs 为空、limit 语义无从区分。
    const createResponse = await app.fetch(new Request('http://localhost/api/admin/tokens', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: authHeader },
      body: JSON.stringify({ name: 'ci-bot', scopes: ['read'] }),
    }));
    assert.strictEqual(createResponse.status, 201);

    const get = (query) => app.fetch(new Request(`http://localhost/api/admin/audit-logs${query}`, {
      headers: { Authorization: authHeader },
    })).then((r) => r.json().then((p) => p.logs.length));

    assert.strictEqual(await get(''), 1, '无 limit → 默认 100');
    assert.strictEqual(await get('?limit=abc'), 1, '非法 limit 回默认 100');
    assert.strictEqual(await get('?limit=0'), 1, 'limit=0 钳到 min 1');
    assert.strictEqual(await get('?limit=99999'), 1, '超上限钳到 500，事件不足时全返回');
  });
});
