const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

/**
 * theme.js 拆成了两半：
 *   theme-core.js    主题切换，必须同步加载在 <head>（首帧前写 data-theme，否则闪白）
 *   theme-effects.js 背景图与特效画布，与首帧无关，defer 加载
 *
 * 两个方向都会错：core 被 defer 会闪白屏，effects 恢复同步会白白挡住解析。
 * 更隐蔽的是 effects 暴露的 UIDesignManager —— defer 之后它在同步内联脚本里
 * 还不存在，调用方如果没等就会静默走进兼容分支。
 */
describe('theme script split', function () {
  const root = path.resolve(__dirname, '..');
  const read = (f) => fs.readFileSync(path.join(root, f), 'utf8');
  const pages = fs.readdirSync(root).filter((f) => f.endsWith('.html'));
  // 曾经这里把 preview.html 排除在外，理由是「它自带一套独立样式」——
  // 而那个假设恰恰就是 bug 本身。preview.html 是全站唯一没加载
  // theme-core.js 的页面：没有 ThemeManager 就没人写 data-theme，
  // 于是它 CSS 里 html[data-theme="dark"] 的规则一条都命中不了，
  // 夜间模式整体失效（实测两模式 body 背景同色）。它明明加载了
  // theme.css，却不理会那份样式表，本身就自相矛盾。
  // 现在每个页面都必须接入主题系统。
  const themedPages = pages;

  it('every page that loads theme.css also loads theme-core.js', function () {
    for (const page of pages) {
      const src = read(page);
      if (!/href="[^"]*theme\.css/.test(src)) continue;
      assert.match(src, /src="\/theme-core\.js/,
        `${page} 加载了 theme.css 却没有 theme-core.js —— 夜间模式在该页完全失效`);
    }
  });

  it('every page can reach the theme switcher', function () {
    // 不要求页面上有显式按钮：theme-core.js 的 ensureAutoToggle 会在没有
    // [data-theme-toggle] 时注入一个浮动按钮，7 个页面靠的就是这条路径
    // （实测 10 页都能点到并切换）。这里只守住前提——必须加载 core，
    // 否则注入逻辑不存在，暗色模式在该页彻底失效。
    for (const page of pages) {
      const src = read(page);
      assert.match(src, /src="\/theme-core\.js/,
        `${page} 没有加载 theme-core.js，既没有主题切换也没有暗色模式`);
    }
  });

  it('does not hide the theme switcher with a blanket selector', function () {
    // preview.css 曾有 `[data-theme-toggle] { display:none !important }`，
    // 按钮被注入又被藏起来——按钮存在但宽高为 0，点不到。这种「注入了但
    // 看不见」的状态比没注入更难发现，所以在这里钉住。
    for (const sheet of fs.readdirSync(root).filter((f) => f.endsWith('.css'))) {
      assert.doesNotMatch(
        read(sheet),
        /\[data-theme-toggle\]\s*\{[^}]*display\s*:\s*none/i,
        `${sheet} 把 [data-theme-toggle] 整个隐藏了，用户将无法切换主题`
      );
    }
  });

  it('replaced the monolithic theme.js', function () {
    assert.ok(!fs.existsSync(path.join(root, 'theme.js')), 'theme.js 应已被两个拆分文件取代');
    for (const page of pages) {
      assert.doesNotMatch(read(page), /src="\/theme\.js/, `${page} 还在引用已删除的 theme.js`);
    }
  });

  it('keeps the two halves disjoint', function () {
    const core = read('theme-core.js');
    const effects = read('theme-effects.js');
    assert.match(core, /window\.ThemeManager = ThemeManager/, 'core 应导出 ThemeManager');
    assert.match(effects, /window\.UIDesignManager = manager/, 'effects 应导出 UIDesignManager');
    // 拆分点选在两个 IIFE 的边界上，任一半出现对方的全局就说明切错了。
    assert.doesNotMatch(core, /UIDesignManager/);
    assert.doesNotMatch(effects, /window\.ThemeManager =/);
  });

  it('loads the theme core synchronously in head', function () {
    assert.ok(themedPages.length >= 9, '加载主题脚本的页面数不对');
    for (const page of themedPages) {
      const src = read(page);
      const head = src.slice(0, src.indexOf('</head>'));
      const tag = /<script src="\/theme-core\.js\?v=[a-f0-9]+"><\/script>/;
      assert.match(head, tag, `${page} 的 theme-core.js 不在 <head> 里`);
      // defer/async 都会把它推到首帧之后，闪白屏。
      assert.doesNotMatch(src, /<script[^>]*\b(?:defer|async)\b[^>]*theme-core\.js/,
        `${page} 的 theme-core.js 不能 defer/async`);
    }
  });

  it('defers the effects half everywhere', function () {
    for (const page of themedPages) {
      assert.match(read(page), /<script defer src="\/theme-effects\.js\?v=[a-f0-9]+"><\/script>/,
        `${page} 的 theme-effects.js 没有 defer`);
    }
  });

  it('makes every UIDesignManager consumer wait for the deferred script', function () {
    // 同步内联脚本里直接读 window.UIDesignManager 永远拿不到（defer 还没执行）。
    // 合法用法只有两种：等 DOMContentLoaded，或在用户触发的回调里读。
    for (const page of pages) {
      const src = read(page);
      if (!src.includes('window.UIDesignManager')) continue;
      const guarded = /DOMContentLoaded/.test(src) || /async\s+\w*[Ss]how|\)\s*\{[^}]*window\.UIDesignManager/.test(src);
      assert.ok(guarded, `${page} 在 UIDesignManager 就绪前就读它了`);
    }
  });

  it('keeps the login background path behind DOMContentLoaded', function () {
    // 这条是真摔过的坑：拆分前它是同步读的，defer 之后会必然走进只认
    // localStorage 的兼容分支，服务端配置的背景再也不会生效。
    const src = read('login.html');
    assert.match(src, /function loadBackground\(\)/);
    assert.match(src, /addEventListener\('DOMContentLoaded', loadBackground, \{ once: true \}\)/);
  });

  it('leaves the icon runtime ordered correctly at the end of body', function () {
    // icons-subset.js 从 <head> 挪到了 body 末尾（它只被 icons.js 消费，不必挡首帧），
    // 但必须排在 icons.js 之前：后者启动时就要读 window.lucide。
    for (const page of pages) {
      const src = read(page);
      const subsetAt = src.indexOf('/icons-subset.js');
      const runtimeAt = src.indexOf('/icons.js');
      if (subsetAt === -1 && runtimeAt === -1) continue;
      assert.ok(subsetAt !== -1 && runtimeAt !== -1, `${page} 只有图标子集和运行时之一`);
      assert.ok(subsetAt < runtimeAt, `${page} 的 icons-subset.js 必须排在 icons.js 之前`);
      const head = src.slice(0, src.indexOf('</head>'));
      assert.ok(!head.includes('/icons-subset.js'), `${page} 的图标子集又回到 <head> 挡首帧了`);
    }
  });

  it('preconnects to the origins each page still pulls from', function () {
    for (const page of pages) {
      const src = read(page);
      const head = src.slice(0, src.indexOf('</head>'));
      for (const origin of ['https://cdn.jsdelivr.net', 'https://js.sentry-cdn.com']) {
        if (!src.includes(origin)) continue;
        assert.ok(head.includes(`rel="preconnect" href="${origin}"`),
          `${page} 用了 ${origin} 却没 preconnect`);
      }
    }
  });
});
