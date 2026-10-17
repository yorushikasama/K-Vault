const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

/**
 * /file/<id> 直链的响应头加固契约。
 *
 * 上传的 .html/.svg 若以 text/html、image/svg+xml 这类可脚本化类型 inline 返回，
 * 脚本会在站点自身源下执行（存储型 XSS）：能读 localStorage、带着 cookie 调
 * /api/manage/**。两套部署各有自己的响应头构造代码（Pages 的 functions/file/[id].js
 * 与 Docker 的 server/app.js），任何一侧漏加固，同一份上传物在另一种部署下就恢复成
 * XSS 载体，所以这里双端一起锁，并强制两份危险类型清单完全一致。
 *
 * 加固手段对子资源无副作用：nosniff 只堵 MIME 嗅探；CSP sandbox 只作用于「把该
 * 响应当文档打开」的场景，img/video 加载 SVG、视频照常工作，PDF 不属危险类型、
 * 不受影响——所以图库展示与预览功能不因加固受损。
 */
describe('/file/ response hardening contract', function () {
  const root = path.resolve(__dirname, '..');
  const pagesSource = fs.readFileSync(path.join(root, 'functions', 'file', '[id].js'), 'utf8');
  const serverSource = fs.readFileSync(path.join(root, 'server', 'app.js'), 'utf8');

  function extractScriptableTypes(source, label) {
    const block = source.match(/SCRIPTABLE_DOCUMENT_TYPES\s*=\s*new Set\(\[([\s\S]*?)\]\)/);
    assert.ok(block, `${label} 找不到 SCRIPTABLE_DOCUMENT_TYPES 清单`);
    return block[1]
      .match(/'([^']+)'/g)
      .map((token) => token.slice(1, -1))
      .sort();
  }

  it('lists the scriptable document types identically on both deployments', function () {
    const pages = extractScriptableTypes(pagesSource, 'functions/file/[id].js');
    const docker = extractScriptableTypes(serverSource, 'server/app.js');
    assert.deepStrictEqual(
      pages,
      docker,
      '两端的可脚本化类型清单漂移了：同一份上传物在一种部署下被 sandbox、另一种没有'
    );
    for (const required of ['text/html', 'image/svg+xml', 'text/xml', 'application/xml']) {
      assert.ok(pages.includes(required), `危险类型清单缺 ${required}`);
    }
    assert.ok(!pages.includes('image/png'), '普通图片不该进危险清单，否则 img 加载被误伤');
    assert.ok(!pages.includes('application/pdf'), 'PDF 不该进危险清单，否则内置查看器被沙箱禁用');
  });

  it('sets nosniff and sandboxes scriptable types on Cloudflare Pages', function () {
    assert.match(pagesSource, /headers\.set\('X-Content-Type-Options', 'nosniff'\)/,
      'Pages 端 /file/ 响应没有 nosniff');
    assert.match(pagesSource, /headers\.set\('Content-Security-Policy', 'sandbox'\)/,
      'Pages 端没有对危险类型施加 CSP sandbox');
    const at = pagesSource.indexOf('function addResponseHeaders');
    assert.notStrictEqual(at, -1, '找不到 addResponseHeaders');
    const body = pagesSource.slice(at, pagesSource.indexOf('\n}', at));
    assert.match(body, /hardenFileResponse\(headers\)/,
      'addResponseHeaders 没调用 hardenFileResponse，加固没接进响应路径');
  });

  it('routes every content response through the hardened header builder', function () {
    // addResponseHeaders 是 Pages 端唯一的内容响应头出口；绕过它就等于漏加固。
    const contentResponses = pagesSource.match(/new Response\([^)]*upstream\.body|new Response\([^)]*object\.body/g) || [];
    const builderCalls = pagesSource.match(/addResponseHeaders\(headers/g) || [];
    assert.ok(contentResponses.length > 0, '前提变了：找不到 /file/ 内容响应构造');
    assert.ok(
      builderCalls.length >= contentResponses.length,
      `存在未经 addResponseHeaders 的内容响应：响应 ${contentResponses.length} 个，构造器只调用 ${builderCalls.length} 次`
    );
  });

  it('sets nosniff and sandboxes scriptable types on the Docker server', function () {
    assert.match(serverSource, /headers\.set\('X-Content-Type-Options', 'nosniff'\)/,
      'Docker 端 /file/ 响应没有 nosniff');
    assert.match(serverSource, /headers\.set\('Content-Security-Policy', 'sandbox'\)/,
      'Docker 端没有对危险类型施加 CSP sandbox');
    const calls = serverSource.match(/hardenFileResponseHeaders\(headers\)/g) || [];
    assert.ok(
      calls.length >= 2,
      `hardenFileResponseHeaders 应同时接进代理与签名直链两条路径，实际调用 ${calls.length} 次`
    );
  });

  it('judges the final content type, not the requested extension', function () {
    for (const [source, label] of [[pagesSource, 'Pages'], [serverSource, 'Docker']]) {
      assert.match(
        source,
        /String\(headers\.get\('Content-Type'\)[^)]*\)\.split\(';'\)/,
        `${label} 端应从实际写入的 Content-Type 判定，带 charset 的 text/html; charset=utf-8 也要命中`
      );
    }
  });
});