const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert');
const { createApp } = require('../server/app');
const { removeTmpDir } = require('./helpers/sweep-test-dirs');
const { makeScratchDir } = require('./helpers/scratch-dir');

/**
 * 会话时长与「记住登录状态」。
 *
 * 起因是 2026-10-15 的一次线上排查：用户连点 4 次抖音转存，服务端 nginx
 * access log 里 4 条全是
 *   "POST /api/resolve-url" 401
 * UA 是一台安卓手机的浏览器，且那个 IP 在此之前没有任何登录请求。
 * 逐层排除后确认服务端一切正常（cookie jar 每天刷新且校验 16 formats、
 * 五种抖音链接形态都能 resolve、download 也能落盘），卡点在会话过期。
 *
 * 顺带查出两个真实的缺陷：
 *
 *   1. login.html 的「记住登录状态」是摆设。复选框在页面上，提交时
 *      却没有随请求发出，服务端 /api/auth/login 也没读 —— 勾不勾都是
 *      sessionDurationMs（默认 24 小时）。用户勾了「记住我」，第二天照样
 *      被踢回登录页，于是「昨天能转存、今天一直不行」。
 *
 *   2. 401 的文案完全指不出真因。未登录的转存回的是
 *      「Guest upload disabled. Please login first.」（那是访客策略的话术），
 *      前端原样弹给用户，看不出该重新登录，只会反复重试同一件必然失败的事。
 *
 * 这里钉住两件事：记住勾上就真的给长效会话，且 cookie 的 Max-Age 与
 * 服务端 expires_at 来自同一个值；不勾仍是随浏览器关闭即失效的会话 cookie。
 */
describe('session lifetime and "remember me"', function () {
  const originalEnv = { ...process.env };
  let tmpDir;
  let app;

  const DAY_MS = 24 * 60 * 60 * 1000;

  beforeEach(function () {
    tmpDir = makeScratchDir('session');
    fs.mkdirSync(tmpDir, { recursive: true });

    process.env.CONFIG_ENCRYPTION_KEY = 'session_test_key_12345';
    process.env.SESSION_SECRET = 'session_test_secret_12';
    process.env.DATA_DIR = tmpDir;
    process.env.DB_PATH = path.join(tmpDir, 'session.db');
    process.env.BASIC_USER = 'tester';
    process.env.BASIC_PASS = 'pw-123456';
    process.env.TG_BOT_TOKEN = '';
    process.env.TG_CHAT_ID = '';
    process.env.DEFAULT_STORAGE_TYPE = 'telegram';
    // 显式给出短会话与长效会话，避免依赖默认值的偶然。
    process.env.SESSION_DURATION_MS = String(DAY_MS);
    process.env.SESSION_REMEMBERED_DURATION_MS = String(30 * DAY_MS);

    app = createApp();
  });

  afterEach(function () {
    removeTmpDir(tmpDir);
    for (const key of Object.keys(process.env)) {
      if (!(key in originalEnv)) delete process.env[key];
      else process.env[key] = originalEnv[key];
    }
  });

  const login = async (body) => {
    const res = await app.request('/api/auth/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    return { status: res.status, cookie: res.headers.get('set-cookie'), json: await res.json() };
  };

  it('reports the default and remembered durations', function () {
    const { loadConfig } = require('../server/lib/config');
    process.env.DATA_DIR = tmpDir;
    const config = loadConfig();
    assert.strictEqual(config.sessionDurationMs, DAY_MS, '默认会话时长不是一天，测试前提变了');
    assert.strictEqual(
      config.rememberedSessionDurationMs,
      30 * DAY_MS,
      '「记住登录状态」的时长不是 30 天，测试前提变了'
    );
  });

  it('gives a short session when the box is unchecked', async function () {
    const { status, json } = await login({ username: 'tester', password: 'pw-123456', remember: false });
    assert.strictEqual(status, 200);
    assert.strictEqual(json.success, true);
    assert.strictEqual(json.remember, false);
  });

  it('stores a long-lived session when remember is true', async function () {
    const before = Date.now();
    const { status, json } = await login({ username: 'tester', password: 'pw-123456', remember: true });
    assert.strictEqual(status, 200);
    assert.strictEqual(json.remember, true, '服务端忽略了 remember=true');

    // 服务端真正判定的是 DB 里的 expires_at，只看响应里的 remember 标志
    // 会漏掉「只改了 cookie、没改服务端」那种偏差。
    const { DatabaseSync } = require('node:sqlite');
    const db = new DatabaseSync(path.join(tmpDir, 'session.db'));
    const row = db.prepare('SELECT user_name, created_at, expires_at FROM sessions ORDER BY created_at DESC LIMIT 1').get();
    const lifetime = Number(row.expires_at) - Number(row.created_at);
    assert.ok(
      lifetime >= 30 * DAY_MS,
      `记住登录的会话只有 ${Math.round(lifetime / DAY_MS)} 天，应为 30 天`
    );
    assert.ok(Number(row.expires_at) > before, 'expires_at 必须是将来的时间');
    db.close();
  });

  it('keeps the cookie Max-Age in step with the server-side expiry', async function () {
    const { cookie } = await login({ username: 'tester', password: 'pw-123456', remember: true });
    assert.ok(cookie, '登录没有下发 Set-Cookie');

    const maxAge = /Max-Age=(\d+)/.exec(cookie);
    assert.ok(maxAge, '记住登录的会话缺 Max-Age，浏览器重启即丢');
    const maxAgeSeconds = Number(maxAge[1]);
    const expectedSeconds = 30 * DAY_MS / 1000;
    // 允许少量偏差：cookie 与 DB 的写入相差几十毫秒，取整后差 1 秒很正常。
    assert.ok(
      Math.abs(maxAgeSeconds - expectedSeconds) < 60,
      `cookie Max-Age=${maxAgeSeconds}s，与 30 天（${expectedSeconds}s）差太远`
    );
  });

  it('omits Max-Age when not remembering, so the cookie dies with the browser', async function () {
    const { cookie } = await login({ username: 'tester', password: 'pw-123456', remember: false });
    assert.ok(cookie, '登录没有下发 Set-Cookie');
    assert.ok(
      !/Max-Age=/.test(cookie),
      '不勾「记住登录状态」时不应写 Max-Age，那会让它变成 24 小时长效 cookie'
    );
  });

  it('treats only an explicit true as remembering', async function () {
    // "false" 是字符串，真值为真 —— 不显式判型就会把字符串 false 当成勾选，
    // 悄悄给出一个用户没要求的 30 天会话。
    for (const value of ['false', 0, null, undefined]) {
      const res = await app.request('/api/auth/login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ username: 'tester', password: 'pw-123456', remember: value }),
      });
      const json = await res.json().catch(() => ({}));
      assert.strictEqual(
        json.remember,
        false,
        `remember=${JSON.stringify(value)} 被当成了勾选「记住登录状态」`
      );
    }
  });

  it('still rejects bad credentials', async function () {
    const res = await login({ username: 'tester', password: 'wrong' });
    assert.strictEqual(res.status, 401, '错误口令竟然通过了');
  });
});

/**
 * 前端：401 必须说人话。
 *
 * 转存接口对未登录请求回的是访客策略的话术
 * 「Guest upload disabled. Please login first.」（HTTP 401）。前端原先把
 * errorDetail 原样弹出来，用户看不出该重新登录 —— 那次线上排查里就是连续
 * 4 次同样的失败文案。下面钉住 401 的换词与跳转。
 */
describe('expired-session messaging', function () {
  const root = path.resolve(__dirname, '..');
  const read = (f) => fs.readFileSync(path.join(root, f), 'utf8');

  it('rewrites a 401 into an actionable message instead of the guest-policy text', function () {
    const app = read('upload-app.js');
    const media = read('upload-media.js');
    for (const [name, src] of [['upload-app.js', app], ['upload-media.js', media]]) {
      assert.ok(
        src.includes('登录状态已过期'),
        `${name} 没有把 401 换成「登录状态已过期」这类人话，用户仍会看到访客策略文案`
      );
      assert.ok(
        /status\s*===\s*401/.test(src),
        `${name} 没有按 401 分支处理，会把会话过期误报成普通失败`
      );
    }
  });

  it('marks those errors so callers can act on them', function () {
    for (const f of ['upload-app.js', 'upload-media.js']) {
      const src = read(f);
      assert.ok(
        src.includes('unauthorized'),
        `${f} 没有给会话过期错误打 unauthorized 标记，调用方无法区分它与普通失败`
      );
    }
  });

  it('sends the user to the login page, preserving where to come back to', function () {
    const media = read('upload-media.js');
    assert.match(
      media,
      /redirectToLogin\(\)\s*\{[\s\S]{0,400}?\/login\.html\?redirect=/,
      'upload-media.js 缺少 redirectToLogin，或跳转时没带 redirect 参数'
    );
    assert.match(
      media,
      /pathname \+ window\.location\.search/,
      'redirectToLogin 没有带上当前 pathname+search，登录完回不到原页面'
    );
    // 队列里任意一项遇到 401 时也该停下并跳转，否则后面每一项都会以同样
    // 的方式失败，用户看到的是一屏重复报错。
    const app = read('upload-app.js');
    assert.match(
      app,
      /error\.unauthorized\) this\.redirectToLogin\(\)/,
      '上传队列遇到 401 没有停下并跳转登录页'
    );
  });

  it('actually sends the checkbox with the login request', function () {
    const html = read('login.html');
    assert.match(
      html,
      /JSON\.stringify\(\{[\s\S]{0,200}?remember:\s*document\.getElementById\(['"]remember['"]\)\.checked/,
      'login.html 提交时没有带上「记住登录状态」复选框 —— 这正是它变成摆设的原因'
    );
  });
});