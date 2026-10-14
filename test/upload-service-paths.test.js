const assert = require('assert');
const { UploadService } = require('../server/lib/services/upload-service');

describe('UploadService storage key routing', function () {
  it('preserves folder path for huggingface uploads under uploads/ prefix', async function () {
    let capturedStorageKey = '';

    const storageRepo = {
      resolveStorageSelection() {
        return {
          id: 'sc_hf',
          name: 'HF',
          type: 'huggingface',
          enabled: true,
          config: { token: 'hf_x', repo: 'u/r' },
        };
      },
    };

    const fileRepo = {
      create(payload) {
        return {
          id: payload.id,
          file_name: payload.fileName,
          file_size: payload.fileSize,
          metadata: payload.extra || {},
        };
      },
    };

    const storageFactory = {
      createAdapter() {
        return {
          async upload({ storageKey }) {
            capturedStorageKey = storageKey;
            return {
              storageKey,
              metadata: { hfPath: storageKey },
            };
          },
        };
      },
    };

    const service = new UploadService({ storageRepo, fileRepo, storageFactory });

    await service.uploadFile({
      fileName: 'photo.png',
      mimeType: 'image/png',
      fileSize: 10,
      buffer: new Uint8Array([1, 2, 3]).buffer,
      folderPath: 'album/2026',
    });

    assert.ok(capturedStorageKey.startsWith('uploads/album/2026/huggingface_'));
    assert.ok(capturedStorageKey.endsWith('.png'));
  });
});

/**
 * uploadFromUrl 的「这是网页」闸门。
 *
 * 2026-10-14 线上：分享链接在能力探测落地前被前端判成普通直链，
 * 服务端按 URL 末段 + Content-Type 命名，把抖音视频页存成了
 * 7696026443508451931.html（72914 字节，text/html）—— 库里多了一个
 * 「看起来像文件、其实是网页」的条目。
 *
 * 服务端这道闸门是最后一道防线：不管前端怎么判错，HTML 响应都不许落库。
 * 显式指向 .html/.htm 的链接是唯一的例外（那是有意抓网页）。
 */
describe('UploadService refuses to store a web page as a file', function () {
  const originalFetch = globalThis.fetch;

  afterEach(function () {
    globalThis.fetch = originalFetch;
  });

  function makeService({ onUpload } = {}) {
    const uploaded = [];
    const service = new UploadService({
      storageRepo: {
        resolveStorageSelection: () => ({
          id: 'sc_tg',
          name: 'TG',
          type: 'telegram',
          enabled: true,
          config: {},
        }),
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
    });
    if (onUpload) onUpload(uploaded);
    return { service, uploaded };
  }

  function stubFetch(body, contentType, { finalUrl = null, withContentLength = true } = {}) {
    globalThis.fetch = async (url) => {
      const headers = { 'content-type': contentType };
      if (withContentLength) headers['content-length'] = String(Buffer.byteLength(body));
      return new Response(body, {
        status: 200,
        headers,
      });
    };
    return finalUrl;
  }

  it('rejects a text/html response with REMOTE_CONTENT_HTML / 415', async function () {
    const { service, uploaded } = makeService();
    stubFetch('<html><head><meta charset="UTF-8"></head><body></body></html>', 'text/html; charset=utf-8');

    await assert.rejects(
      () => service.uploadFromUrl({ url: 'https://www.douyin.com/video/7696026443508451931' }),
      (error) => {
        assert.strictEqual(error.code, 'REMOTE_CONTENT_HTML');
        assert.strictEqual(error.status, 415);
        return true;
      },
    );
    assert.strictEqual(uploaded.length, 0, '网页仍然被写进了存储');
  });

  it('catches a page mislabelled as octet-stream by the first bytes', async function () {
    const { service, uploaded } = makeService();
    stubFetch('<!DOCTYPE html><html><body>page</body></html>', 'application/octet-stream');

    await assert.rejects(
      () => service.uploadFromUrl({ url: 'https://example.com/watch/12345' }),
      (error) => error.code === 'REMOTE_CONTENT_HTML',
    );
    assert.strictEqual(uploaded.length, 0);
  });

  it('catches a mislabelled page without a declared length too', async function () {
    // 无 Content-Length 时走 stageBodyToTempFile 落盘分支，那条路径也要检。
    const { service, uploaded } = makeService();
    stubFetch('<!DOCTYPE html><html><body>page</body></html>', 'application/octet-stream', {
      withContentLength: false,
    });

    await assert.rejects(
      () => service.uploadFromUrl({ url: 'https://example.com/watch/12345' }),
      (error) => error.code === 'REMOTE_CONTENT_HTML',
    );
    assert.strictEqual(uploaded.length, 0);
  });

  it('still imports a normal binary file', async function () {
    const { service, uploaded } = makeService();
    stubFetch(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), 'image/png');

    // 字面量公网 IP：SSRF 守卫对纯 IP 不做 DNS，测试因此不依赖解析器。
    const result = await service.uploadFromUrl({ url: 'https://8.8.8.8/a.png' });
    assert.ok(result.src, '普通文件被误拦');
    assert.strictEqual(uploaded.length, 1);
  });

  it('trusts a declared non-HTML Content-Type without re-reading the bytes', async function () {
    // 声明为图片就按图片走：不再读字节猜一遍，避免给每次导入加一次多余的读。
    const { service, uploaded } = makeService();
    stubFetch('<!DOCTYPE html><html><body>mislabelled</body></html>', 'image/png');

    const result = await service.uploadFromUrl({ url: 'https://8.8.8.8/a.png' });
    assert.ok(result.src);
    assert.strictEqual(uploaded.length, 1, '声明类型是图片时不该被字节嗅探拦下');
  });

  it('allows an explicit .html target', async function () {
    // 明确要抓网页是合法需求，不能被这道闸门堵死。
    const { service, uploaded } = makeService();
    stubFetch('<html><body>saved page</body></html>', 'text/html');

    const result = await service.uploadFromUrl({ url: 'https://8.8.8.8/report.html' });
    assert.ok(result.src, '显式的 .html 目标被误拦');
    assert.strictEqual(uploaded.length, 1);
  });
});

/**
 * 三道防线的契约。
 *
 * 2026-10-14 的事故是「网页被当成文件存进库」—— 前端误判、服务端照存。
 * 单修一层都不够：前端判定依赖一个几秒才回来的探测，而服务端当时对任何
 * 响应类型都照单全收。这三条把三层各自的防线钉住，任何一层被改掉都会失败。
 */
describe('a web page can never be stored as a file (three layers)', function () {
  const fs = require('node:fs');
  const path = require('node:path');
  const root = path.resolve(__dirname, '..');
  const read = (f) => fs.readFileSync(path.join(root, f), 'utf8');

  it('layer 1: the server importer refuses HTML with a code the client can act on', function () {
    const service = read('server/lib/services/upload-service.js');
    assert.match(service, /error\.code = 'REMOTE_CONTENT_HTML'/, '服务端不再返回 REMOTE_CONTENT_HTML');
    assert.match(service, /error\.status = 415/, 'REMOTE_CONTENT_HTML 必须带 415，否则客户端只看到笼统的失败');
    // 声明了长度的路径与落盘路径都要检 —— 后者是无 Content-Length 时唯一的通道
    const guards = service.match(/HTML_HEAD_RE\.test\(/g) || [];
    assert.ok(guards.length >= 2, '字节级嗅探只覆盖了一条分支，另一条仍可存入网页');
  });

  it('layer 2: the client waits for the capability probe before deciding', function () {
    const media = read('upload-media.js');
    assert.match(media, /ensureMediaResolveStatus\(/, '前端不再等能力探测落地');
    assert.match(
      media,
      /async ensureMediaResolveStatus\(timeoutMs = \d+\)/,
      'ensureMediaResolveStatus 必须带超时：探测挂了也不能把输入框永远卡住',
    );
    // 单例：mounted 已经发起过一次，这里不能重复打请求
    assert.match(media, /this\._mediaResolveStatusPromise = pending/, '没有复用已发起的探测请求');
  });

  it('layer 3: the client turns that code into a resolve attempt', function () {
    const media = read('upload-media.js');
    assert.match(
      media,
      /err\.code === "REMOTE_CONTENT_HTML"[\s\S]{0,160}openQualityPicker/,
      '收到 REMOTE_CONTENT_HTML 后没有改走解析，网页仍会被存成文件',
    );
  });

  it('covers the Cloudflare Pages runtime too, not just Node', function () {
    // 两个运行时各有一份 upload-from-url；只修 Node 会让 Pages 部署保持原病。
    const pages = read('functions/api/upload-from-url.js');
    assert.match(pages, /REMOTE_CONTENT_HTML/, 'Pages 版没有这道闸门');
    assert.match(pages, /isExplicitHtmlTarget/, 'Pages 版缺少显式 .html 目标的例外');
  });
});
