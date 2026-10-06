const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

/**
 * 第三方 CDN 的供应链约束。
 *
 * 没有打包步骤意味着 Vue / Element / 预览引擎都是运行时从别人家服务器拉的，
 * 拉到什么就在本站源上执行什么。所以两件事必须成立：版本写死，内容校验。
 */
describe('CDN supply chain', function () {
  const root = path.resolve(__dirname, '..');
  const pages = fs.readdirSync(root).filter((f) => f.endsWith('.html'));
  const read = (p) => fs.readFileSync(path.join(root, p), 'utf8');

  it('pins every CDN dependency to an exact version', function () {
    // @latest 意味着上游任何一次发布都会立刻改变本站执行的代码。
    const offenders = [];
    for (const page of pages) {
      for (const m of read(page).matchAll(/https:\/\/(?:cdn\.jsdelivr\.net|unpkg\.com)\/npm\/([^"'`\s]+)/g)) {
        if (/@latest|@\^|@~|@next|@beta/.test(m[1])) offenders.push(`${page}: ${m[1]}`);
        else if (!/@\d+\.\d+\.\d+/.test(m[1]) && !/@\$\{/.test(m[1])) offenders.push(`${page}: ${m[1]} 未写死版本`);
      }
    }
    assert.deepStrictEqual(offenders, [], '这些依赖没有锁定版本');
  });

  it('attaches SRI to every static CDN script and stylesheet', function () {
    const offenders = [];
    for (const page of pages) {
      const src = read(page);
      const tags = src.match(/<(?:script|link)\b[^>]*https:\/\/(?:cdn\.jsdelivr\.net|unpkg\.com)[^>]*>/g) || [];
      for (const tag of tags) {
        // preconnect / dns-prefetch 只是提前建连，没有内容可校验。
        if (/rel="(?:preconnect|dns-prefetch)"/.test(tag)) continue;
        if (!/integrity="sha(?:256|384|512)-/.test(tag)) offenders.push(`${page}: ${tag.slice(0, 90)}`);
        // 跨源资源要校验内容就必须带 CORS，否则浏览器拿不到字节，直接拦掉。
        else if (!/crossorigin=/.test(tag)) offenders.push(`${page}: 有 integrity 但缺 crossorigin`);
      }
    }
    assert.deepStrictEqual(offenders, [], '这些 CDN 标签缺 SRI');
  });

  describe('preview.html enhanced viewer engine', function () {
    const src = read('preview.html');

    it('does not load the engine from jsDelivr', function () {
      // 该包解包后超过 150 MB，jsDelivr 会返回 200 + 一段纯文本错误，
      // 脚本"加载成功"却什么都没注册，增强预览因此一直是坏的。
      assert.doesNotMatch(src, /cdn\.jsdelivr\.net\/npm\/@file-viewer/,
        'jsDelivr 无法提供这个包，会让增强预览静默失效');
    });

    it('pins the version and carries an SRI hash', function () {
      assert.match(src, /const FILE_VIEWER_VERSION = "\d+\.\d+\.\d+"/);
      assert.match(src, /const FILE_VIEWER_INTEGRITY = "sha384-[A-Za-z0-9+/=]+"/);
    });

    it('sets crossOrigin whenever it sets integrity', function () {
      const block = src.slice(src.indexOf('const engine = resolveEngineUrl()'));
      const guarded = block.slice(0, block.indexOf('script.async'));
      assert.match(guarded, /script\.integrity = engine\.integrity/);
      assert.match(guarded, /script\.crossOrigin = "anonymous"/);
    });

    it('does not let ?engineCdn point the script tag anywhere', function () {
      // 改前这里是 `script.src = params.get("engineCdn") || FILE_VIEWER_CDN`，
      // 等于一条链接就能在本站源上执行任意脚本。
      assert.doesNotMatch(src, /script\.src = params\.get\("engineCdn"\)/,
        'engineCdn 又回到了直接赋给 script.src');
      assert.match(src, /const ENGINE_HOST_ALLOWLIST = \[/, '缺少 engineCdn 的来源白名单');
      assert.match(src, /if \(!sameOrigin && !trusted\)/, '白名单没有真正拦截');
    });

    it('only applies the pinned hash to the pinned URL', function () {
      // 自托管构建的字节必然不同，给它套默认哈希会把合法的覆盖也拦掉。
      assert.match(src, /integrity: parsed\.href === FILE_VIEWER_CDN \? FILE_VIEWER_INTEGRITY : ""/);
    });
  });

  it('documents why the Sentry loader is exempt from SRI', function () {
    // Sentry 的 loader 内容随后台配置变化，钉死哈希会在改配置时把它拦掉。
    // 这是有意的例外，必须写明原因，否则下一个人会以为是漏了。
    for (const page of pages) {
      const src = read(page);
      // 只看真正加载脚本的那个标签，preconnect 的那条不算。
      const at = src.search(/<script src="https:\/\/js\.sentry-cdn\.com/);
      if (at === -1) continue;
      const preceding = src.slice(Math.max(0, at - 400), at);
      assert.match(preceding, /SRI/, `${page} 的 Sentry 标签没说明为什么不加 SRI`);
    }
  });
});
