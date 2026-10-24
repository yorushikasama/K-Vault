const assert = require('node:assert');

/**
 * Endpoint-level SSRF regression for POST /api/upload-from-url (Pages side).
 *
 * test/pages-ssrf-guard.test.js covers the guard module itself (literal IPs,
 * protocols, redirect targets). These cases cover the endpoint's request flow:
 * the guard must actually be wired into fetchRemote, redirects must be followed
 * hop by hop with re-validation, and the response body must be read under the
 * URL_IMPORT_MAX_SIZE cap. Mirrors the checks the Docker runtime performs in
 * server/lib/services/upload-service.js + server/lib/utils/remote-fetch.js.
 */
describe('Pages /api/upload-from-url SSRF wiring', function () {
  this.timeout(10000);

  function createMockKv() {
    const store = new Map();
    return {
      async put(name, value, options = {}) {
        store.set(name, { value, metadata: { ...(options.metadata || {}) } });
      },
      snapshot() {
        return store;
      },
    };
  }

  function createMockR2() {
    const puts = [];
    return {
      async put(key, body, options) {
        puts.push({ key, body, options });
        return {};
      },
      puts,
    };
  }

  function withMockedFetch(handler) {
    const calls = [];
    const realFetch = globalThis.fetch;
    globalThis.fetch = async (input, init) => {
      const url = String(input instanceof Request ? input.url : input);
      calls.push({ url, init });
      return handler(url, calls.length);
    };
    return {
      calls,
      restore() {
        globalThis.fetch = realFetch;
      },
    };
  }

  function buildRequest(payload, headers = {}) {
    return new Request('https://example.com/api/upload-from-url', {
      method: 'POST',
      headers,
      body: JSON.stringify(payload),
    });
  }

  async function callEndpoint(payload, env, headers = {}) {
    const { onRequestPost } = await import('../functions/api/upload-from-url.js');
    return onRequestPost({
      env,
      request: buildRequest(payload, headers),
    });
  }

  describe('first-hop validation refuses internal targets without any outbound request', function () {
    const internalTargets = [
      'http://169.254.169.254/latest/meta-data',
      'http://10.0.0.1/x',
      'http://127.0.0.1:8080/admin',
      'http://192.168.1.1/router',
      'http://172.16.0.1/x',
      'http://100.64.0.1/x',
      'http://0.0.0.0/x',
      'http://[::1]/x',
      'http://[fe80::1]/x',
      'http://localhost/secret',
      'http://metadata.google.internal/computeMetadata/v1/',
      'http://box.internal/data',
      'http://printer.local/file',
    ];

    for (const target of internalTargets) {
      it(`blocks ${target} with 403 and no outbound request`, async function () {
        const mocked = withMockedFetch(() => Promise.reject(new Error('must not be called')));
        try {
          const response = await callEndpoint(
            { url: target, storageMode: 'r2' },
            { R2_BUCKET: createMockR2() }
          );
          const payload = await response.json();

          assert.strictEqual(response.status, 403, `${target} should be refused`);
          assert.strictEqual(payload.errorCode, 'SSRF_BLOCKED');
          assert.match(String(payload.error || ''), /SSRF/);
          assert.strictEqual(mocked.calls.length, 0, 'no outbound request may leave for a blocked target');
        } finally {
          mocked.restore();
        }
      });
    }

    it('blocks non-whitelisted ports with 403 before any request', async function () {
      const mocked = withMockedFetch(() => Promise.reject(new Error('must not be called')));
      try {
        const response = await callEndpoint(
          { url: 'https://example.com:1234/x', storageMode: 'r2' },
          { R2_BUCKET: createMockR2() }
        );
        const payload = await response.json();

        assert.strictEqual(response.status, 403);
        assert.strictEqual(payload.errorCode, 'SSRF_BLOCKED');
        assert.strictEqual(mocked.calls.length, 0);
      } finally {
        mocked.restore();
      }
    });

    it('rejects non-http(s) protocols with 400 (existing outer check)', async function () {
      const mocked = withMockedFetch(() => Promise.reject(new Error('must not be called')));
      try {
        const response = await callEndpoint(
          { url: 'ftp://example.com/file.zip', storageMode: 'r2' },
          { R2_BUCKET: createMockR2() }
        );
        const payload = await response.json();

        assert.strictEqual(response.status, 400);
        assert.strictEqual(mocked.calls.length, 0);
      } finally {
        mocked.restore();
      }
    });
  });

  describe('redirect handling re-validates every hop', function () {
    it('refuses a public URL that 302-redirects into a private network', async function () {
      const mocked = withMockedFetch(() =>
        Promise.resolve(
          new Response(null, {
            status: 302,
            headers: { location: 'http://10.0.0.1/x' },
          })
        )
      );
      try {
        const response = await callEndpoint(
          { url: 'https://cdn.example.com/a.png', storageMode: 'r2' },
          { R2_BUCKET: createMockR2() }
        );
        const payload = await response.json();

        assert.strictEqual(response.status, 403, 'redirect into a private address must be refused');
        assert.strictEqual(payload.errorCode, 'SSRF_BLOCKED');
        assert.strictEqual(mocked.calls.length, 1, 'only the public first hop may be fetched');
        assert.strictEqual(mocked.calls[0].init.redirect, 'manual', 'redirects must be followed manually, hop by hop');
      } finally {
        mocked.restore();
      }
    });

    it('refuses a redirect chain that exceeds the hop limit', async function () {
      const mocked = withMockedFetch((url) =>
        Promise.resolve(
          new Response(null, {
            status: 302,
            headers: { location: `https://redirect.example.com/hop-${Number(url.split('-').pop() || 0) + 1}` },
          })
        )
      );
      try {
        const response = await callEndpoint(
          { url: 'https://redirect.example.com/hop-0', storageMode: 'r2' },
          { R2_BUCKET: createMockR2() }
        );
        const payload = await response.json();

        assert.strictEqual(response.status, 403, 'too many redirects must be refused');
        assert.strictEqual(payload.errorCode, 'SSRF_BLOCKED');
        // MAX_REDIRECTS is 5: hops 0..5 are fetched, the 7th URL is never requested.
        assert.strictEqual(mocked.calls.length, 6, 'the redirect loop must stop at MAX_REDIRECTS + 1 fetches');
      } finally {
        mocked.restore();
      }
    });

    it('refuses redirects to non-http protocols', async function () {
      const mocked = withMockedFetch(() =>
        Promise.resolve(
          new Response(null, {
            status: 301,
            headers: { location: 'ftp://internal.example.com/x' },
          })
        )
      );
      try {
        const response = await callEndpoint(
          { url: 'https://cdn.example.com/a.png', storageMode: 'r2' },
          { R2_BUCKET: createMockR2() }
        );
        const payload = await response.json();

        assert.strictEqual(response.status, 403);
        assert.strictEqual(payload.errorCode, 'SSRF_BLOCKED');
      } finally {
        mocked.restore();
      }
    });
  });

  describe('the happy path keeps its existing contract', function () {
    it('stores a normal public file and answers with the existing response shape', async function () {
      const bodyBytes = new Uint8Array(16).fill(7);
      const mocked = withMockedFetch(() =>
        Promise.resolve(
          new Response(bodyBytes, {
            status: 200,
            headers: { 'content-type': 'application/octet-stream' },
          })
        )
      );
      const r2 = createMockR2();
      try {
        const response = await callEndpoint(
          { url: 'https://cdn.example.com/file.bin', storageMode: 'r2' },
          { R2_BUCKET: r2 }
        );
        const payload = await response.json();

        assert.strictEqual(response.status, 200);
        assert.ok(Array.isArray(payload), 'success responses stay an array');
        assert.match(payload[0].src, /^\/file\/r2:/, 'the src contract is unchanged');
        assert.strictEqual(r2.puts.length, 1, 'exactly one R2 write happens');
        assert.strictEqual(r2.puts[0].body.byteLength, 16, 'the fetched bytes reach storage intact');
        assert.strictEqual(mocked.calls[0].init.redirect, 'manual');
      } finally {
        mocked.restore();
      }
    });

    it('still surfaces HTML responses as 415 REMOTE_CONTENT_HTML (share-link detection)', async function () {
      const mocked = withMockedFetch(() =>
        Promise.resolve(
          new Response('<html></html>', {
            status: 200,
            headers: { 'content-type': 'text/html; charset=utf-8' },
          })
        )
      );
      try {
        const response = await callEndpoint(
          { url: 'https://cdn.example.com/page', storageMode: 'r2' },
          { R2_BUCKET: createMockR2() }
        );
        const payload = await response.json();

        assert.strictEqual(response.status, 415);
        assert.strictEqual(payload.errorCode, 'REMOTE_CONTENT_HTML');
      } finally {
        mocked.restore();
      }
    });
  });

  describe('response bodies are read under the import size cap', function () {
    it('refuses a body whose declared Content-Length exceeds URL_IMPORT_MAX_SIZE', async function () {
      const mocked = withMockedFetch(() =>
        Promise.resolve(
          new Response(null, {
            status: 200,
            headers: { 'content-type': 'application/zip', 'content-length': '5000' },
          })
        )
      );
      try {
        const response = await callEndpoint(
          { url: 'https://cdn.example.com/big.zip', storageMode: 'r2' },
          { R2_BUCKET: createMockR2(), URL_IMPORT_MAX_SIZE: 100 }
        );
        const payload = await response.json();

        assert.strictEqual(response.status, 413);
        assert.strictEqual(payload.errorCode, 'FILE_TOO_LARGE');
      } finally {
        mocked.restore();
      }
    });

    it('refuses a streaming body that crosses the cap without declaring its length', async function () {
      const stream = new ReadableStream({
        start(controller) {
          controller.enqueue(new Uint8Array(60).fill(1));
          controller.enqueue(new Uint8Array(60).fill(2));
          controller.close();
        },
      });
      const mocked = withMockedFetch(() =>
        Promise.resolve(
          new Response(stream, {
            status: 200,
            headers: { 'content-type': 'application/zip' },
          })
        )
      );
      const r2 = createMockR2();
      try {
        const response = await callEndpoint(
          { url: 'https://cdn.example.com/chunked.zip', storageMode: 'r2' },
          { R2_BUCKET: r2, URL_IMPORT_MAX_SIZE: 100 }
        );
        const payload = await response.json();

        assert.strictEqual(response.status, 413);
        assert.strictEqual(payload.errorCode, 'FILE_TOO_LARGE');
        assert.strictEqual(r2.puts.length, 0, 'an oversized body must never reach storage');
      } finally {
        mocked.restore();
      }
    });

    it('falls back to UPLOAD_MAX_SIZE when URL_IMPORT_MAX_SIZE is not pinned', async function () {
      const stream = new ReadableStream({
        start(controller) {
          controller.enqueue(new Uint8Array(200).fill(1));
          controller.close();
        },
      });
      const mocked = withMockedFetch(() =>
        Promise.resolve(
          new Response(stream, {
            status: 200,
            headers: { 'content-type': 'application/zip' },
          })
        )
      );
      try {
        const response = await callEndpoint(
          { url: 'https://cdn.example.com/chunked.zip', storageMode: 'r2' },
          { R2_BUCKET: createMockR2(), UPLOAD_MAX_SIZE: 100 }
        );
        const payload = await response.json();

        assert.strictEqual(response.status, 413, 'UPLOAD_MAX_SIZE must cap the import when the explicit knob is absent');
        assert.strictEqual(payload.errorCode, 'FILE_TOO_LARGE');
      } finally {
        mocked.restore();
      }
    });
  });
});
/**
 * 鉴权与访客限额闸门（2026-10-21 补）。
 *
 * 此前 Pages 端 /api/upload-from-url 整个裸奔：Docker 端同名端点先认证、
 * 未认证走访客限额（server/app.js 同名路由），Pages 端却没有任何闸门，
 * 任何人可让服务器代为拉取 URL 并写入存储。与已删除的
 * functions/api/r2/upload.js 同类，同一天一并修掉。
 *
 * 闸门语义与主上传端点 /upload 一致：先 checkAuthentication；未配置
 * BASIC_USER/PASS 时全站本就匿名（no-auth-required 放行），配置了则
 * 未认证请求走访客限额——GUEST_UPLOAD 未开启即 401。
 */
describe('Pages /api/upload-from-url auth gate', function () {
  this.timeout(10000);

  const authHeader = () => `Basic ${Buffer.from('admin:secret123').toString('base64')}`;

  // 上一层的 mock fixture 在 SSRF wiring 的 describe 作用域里，这里拿不到，
  // 本块自备同款最小实现（mock fetch 的行为由各用例传入）。
  function createMockR2() {
    return { async put() { return {}; } };
  }

  function withMockedFetch(handler) {
    const calls = [];
    const realFetch = globalThis.fetch;
    globalThis.fetch = async (input, init) => {
      calls.push({ url: String(input instanceof Request ? input.url : input), init });
      return handler(url0(), calls.length);
    };
    return { calls, restore() { globalThis.fetch = realFetch; } };
  }

  function url0() { return 'https://mocked.invalid/'; }

  function buildRequest(payload, headers = {}) {
    return new Request('https://example.com/api/upload-from-url', {
      method: 'POST',
      headers,
      body: JSON.stringify(payload),
    });
  }

  async function callEndpoint(payload, env, headers = {}) {
    const { onRequestPost } = await import('../functions/api/upload-from-url.js');
    return onRequestPost({ env, request: buildRequest(payload, headers) });
  }

  it('配置了凭据时，匿名请求返回 401 且不产生任何外发请求', async function () {
    const mocked = withMockedFetch(() => Promise.reject(new Error('must not be called')));
    try {
      const response = await callEndpoint(
        { url: 'https://example.com/file.zip', storageMode: 'r2' },
        { R2_BUCKET: createMockR2(), BASIC_USER: 'admin', BASIC_PASS: 'secret123' }
      );
      assert.strictEqual(response.status, 401);
      assert.strictEqual(mocked.calls.length, 0, '鉴权拒绝后不得有任何外发请求');
    } finally {
      mocked.restore();
    }
  });

  it('配置了凭据时，带合法 Basic 凭据的请求通过闸门进入 SSRF 流程', async function () {
    const mocked = withMockedFetch(() => Promise.reject(new Error('blocked-host-probe')));
    try {
      // 用一个会被 SSRF 守卫拦下的地址：能走到 403 SSRF_BLOCKED 说明闸门放行了。
      const response = await callEndpoint(
        { url: 'http://169.254.169.254/latest/meta-data', storageMode: 'r2' },
        { R2_BUCKET: createMockR2(), BASIC_USER: 'admin', BASIC_PASS: 'secret123' },
        { Authorization: authHeader() }
      );
      const payload = await response.json();
      assert.strictEqual(response.status, 403);
      assert.strictEqual(payload.errorCode, 'SSRF_BLOCKED');
    } finally {
      mocked.restore();
    }
  });

  it('开启访客上传时，匿名请求放行进 SSRF 流程（与 Docker 端访客语义一致）', async function () {
    const mocked = withMockedFetch(() => Promise.reject(new Error('blocked-host-probe')));
    try {
      const response = await callEndpoint(
        { url: 'http://169.254.169.254/latest/meta-data', storageMode: 'r2' },
        { R2_BUCKET: createMockR2(), BASIC_USER: 'admin', BASIC_PASS: 'secret123', GUEST_UPLOAD: 'true' }
      );
      const payload = await response.json();
      assert.strictEqual(response.status, 403);
      assert.strictEqual(payload.errorCode, 'SSRF_BLOCKED');
    } finally {
      mocked.restore();
    }
  });

  it('关闭访客上传时，匿名请求 401（带引导登录的文案）', async function () {
    const response = await callEndpoint(
      { url: 'https://example.com/file.zip', storageMode: 'r2' },
      { R2_BUCKET: createMockR2(), BASIC_USER: 'admin', BASIC_PASS: 'secret123', GUEST_UPLOAD: 'false' }
    );
    assert.strictEqual(response.status, 401);
    const payload = await response.json();
    assert.match(String(payload.error || ''), /登录/);
  });
});
