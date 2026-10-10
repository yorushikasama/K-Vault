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

/**
 * 背景与底色必须由一处说了算。
 *
 * 之前"背景图只在部分页面生效"看着像逐页缺配置，实际是两件事叠加：
 *   1) 壁纸层每页都注入了，但 theme.css 把图层压到 0.14 再叠一层 0.68 底色蒙版，
 *      真正上屏只剩约 4.5% —— 所有页面都"看不见"，于是被误读成某些页没接。
 *   2) preview / webdav / admin-waterfall 各自在 :root 里另起了一套底色与文字
 *      token，和 theme.css 的 --ui-* 权威层并行。同一语义两个名字，改主题只改
 *      得动一半，这才是"没有统一管理"真正的成因。
 * 下面两条把可见度下限和"禁止各页另起底色"钉住。
 */
describe('background + base color are centrally managed', function () {
  const root = path.resolve(__dirname, '..');
  const read = (f) => fs.readFileSync(path.join(root, f), 'utf8');
  const sheets = fs.readdirSync(root).filter((f) => f.endsWith('.css'));
  const theme = read('theme.css');

  it('keeps wallpaper strength in tokens, not per-rule magic numbers', function () {
    // 壁纸强度是两个值的乘积：图层 opacity × 蒙版 opacity。上屏的是乘积，
    // 改任何一个都会改动观感，所以两者必须是 token 而不是散落的字面量。
    assert.match(theme, /--ui-wall-opacity\s*:/, '缺少壁纸可见度 token');
    assert.match(theme, /--ui-wall-mask\s*:/, '缺少壁纸蒙版 token');

    const layer = /\.ui-bg-image-layer\s*\{[^}]*\}/.exec(theme);
    assert.ok(layer, '找不到 .ui-bg-image-layer 规则');
    assert.match(layer[0], /opacity:\s*var\(--ui-wall-opacity\)/,
      '壁纸图层没有引用 --ui-wall-opacity，可见度又散回字面量了');

    const mask = /\.ui-bg-image-layer::after\s*\{[^}]*\}/.exec(theme);
    assert.ok(mask, '找不到 .ui-bg-image-layer::after 规则');
    assert.match(mask[0], /opacity:\s*var\(--ui-wall-mask\)/,
      '壁纸蒙版没有引用 --ui-wall-mask');
  });

  it('keeps the wallpaper above the visibility floor in both themes', function () {
    // 实测阈值：低于 ~10% 时浅色壁纸被压进同色底，等于没壁纸（这正是本次
    // "有些页面没有背景图"的观感来源）。这里解析 token 并守住乘积下限。
    const tokens = {};
    const re = /--(ui-wall-(?:opacity|mask))\s*:\s*([\d.]+)\s*;/g;
    let m;
    while ((m = re.exec(theme))) tokens[m[1]] = Number(m[2]);
    assert.ok(tokens['ui-wall-opacity'] && tokens['ui-wall-mask'],
      `壁纸 token 缺失: ${JSON.stringify(tokens)}`);

    const product = tokens['ui-wall-opacity'] * tokens['ui-wall-mask'];
    assert.ok(product >= 0.1,
      `壁纸有效可见度 ${product.toFixed(3)} 低于 0.1 下限，等于没有背景图`);
  });

  it('cards stay opaque: the opacity floor is not bypassed', function () {
    // DESIGN.md 明令"surfaces are opaque"，theme-effects.js 也把透明度下限
    // 压到 1.0（壁纸透进卡片等于回到磨砂玻璃的老路）。但那份下限一度形同
    // 虚设：写 --ui-card-opacity 时又回头读了滑块的原始值，于是卡片仍按
    // 0.86 渲染，壁纸从正文下面透出来。这里守住"写出去的是被约束过的值"。
    const effects = read('theme-effects.js');
    assert.match(effects, /opacity\s*=\s*Math\.max\(\s*1(?:\.0)?\s*,\s*opacity\s*\)/,
      'applyCompatibilityVars 不再把卡片透明度压到下限 —— 实心表面被放开了');
    assert.doesNotMatch(effects, /surfaceAlpha\s*=[^;]*next\.cardOpacity/,
      'surfaceAlpha 又去读未约束的 next.cardOpacity 了，下限会被绕过、壁纸透进卡片');
  });

  it('pages do not declare their own base color or body background', function () {
    // 各页可以在 :root 里放自己的私有 token（预览器的代码块配色、
    // webdav 的 --wf-* 等），但"页面底色"和"body 背景"只有一个来源：
    // theme.css 的 --ui-canvas。任何页面写死底色或另起一套 --bg/--bg-gradient，
    // 就会和权威层打架，且不会跟随 UI 面板的全局改动。
    for (const sheet of sheets) {
      if (sheet === 'theme.css') continue;
      const src = read(sheet);

      // 只认真正的字面量颜色：`var(...)` / `none` 都放行 —— 它们本来就在
      // 权威层里（--ui-canvas）。上一版正则把 var(--bg-gradient) 也判成硬编码，
      // 那不是缺陷，是规则写错了。
      assert.doesNotMatch(
        src,
        /^\s*body\s*\{[^}]*\bbackground(?:-color)?\s*:\s*(?!none\b|var\(|inherit\b)[^;}]*#/gim,
        `${sheet} 在 body 上写死了背景色 —— 底色应统一由 theme.css 的 --ui-canvas 提供`
      );
      assert.doesNotMatch(
        src,
        /--bg\s*:\s*#[0-9a-f]{3,8}\s*;/i,
        `${sheet} 自带 --bg 颜色值，应引用 var(--ui-canvas)`
      );
      assert.doesNotMatch(
        src,
        /--bg-gradient\s*:\s*#[0-9a-f]{3,8}\s*;/i,
        `${sheet} 自带 --bg-gradient 颜色值，应引用 var(--ui-canvas)`
      );
    }
  });

  it('only theme.css positions the wallpaper layer', function () {
    // 图层由 theme-effects.js 无条件注入，任何页面都不会缺失。真正要守住的是
    // 层叠关系：壁纸层必须挂在负 z-index 上，任何在流内容都自动压在它上面。
    // 页面样式表若自行改写 z-index，内容要么被壁纸盖住、要么反过来把壁纸盖掉
    // —— 这类问题只在特定页面出现，很难联想到壁纸。
    for (const sheet of sheets) {
      assert.doesNotMatch(
        read(sheet),
        /\.ui-bg-image-layer\s*\{[^}]*display\s*:\s*none/i,
        `${sheet} 把壁纸图层隐藏了`
      );
      if (sheet === 'theme.css') continue;
      assert.doesNotMatch(
        read(sheet),
        /\.ui-bg-image-layer\s*\{/,
        `${sheet} 不该重新定义壁纸图层的层级（z-index/opacity），这属于 theme.css`
      );
    }
    // 负层级是"任意页面都盖不住壁纸"的机制本身：正 z-index 需要每个页面
    // 记得把自己的内容根抬起来（preview 的 .shell 就漏过一次，壁纸直接
    // 压在正文上）；负层级把这件事变成默认成立。
    assert.match(theme, /\.ui-bg-image-layer\s*\{[^}]*z-index\s*:\s*-\d+\s*;/,
      '壁纸图层必须挂在负 z-index 上，否则又回到"逐页登记内容根"的老路');
    assert.doesNotMatch(theme, /body\s*>\s*#app\s*,[^}]*z-index\s*:\s*\d/,
      '不该再用「body > #app 等容器抬 z-index」的白名单来给内容让位');
  });

  it('no page wrapper paints an opaque full-viewport background', function () {
    // 用户报的"有些地方有图片背景，有些地方又没有"：壁纸是负层级，任何铺满
    // 视口的不透明底都会把它整块抹掉。曾经是 .kv-workbench / .upload-surface /
    // .files-shell / .files-main 四处各铺一层 --wb-surface，于是同一份背景图
    // 设置在上传/文件两页看不见、其余页看得见。实心的应当是卡片，不是页面。
    for (const sheet of sheets) {
      const src = read(sheet);
      const re = /(\.kv-workbench|\.upload-surface|\.files-shell|\.files-main)\s*\{([^}]*)\}/g;
      let m;
      while ((m = re.exec(src))) {
        const decl = /\bbackground(?:-color)?\s*:\s*([^;}]+)/i.exec(m[2]);
        if (!decl) continue;
        const value = decl[1].trim().toLowerCase();
        // 只有"真的铺了一层色"才算：none / transparent 是我们要的写法。
        const paints = !/^(none|transparent|inherit|initial|unset)$/.test(value);
        assert.ok(!paints,
          `${sheet} 给页面级容器 ${m[1]} 铺了底（${decl[1].trim()}），会把全局壁纸整块盖掉`);
      }
    }
  });

  it('the wallpaper scrim reads a token that flips with the theme', function () {
    // 蒙版用 --ui-canvas 洗壁纸。如果那个值被写成不随主题翻转的字面量，
    // 夜间就会拿浅色去洗深色页 —— 壁纸发灰发脏。JS 尤其危险：它在 <html>
    // 上写内联样式，内联优先级高于 :root，一旦写死主题就再也翻不动。
    const cssCanvas = /--ui-canvas\s*:\s*([^;]+);/.exec(theme);
    assert.ok(cssCanvas, 'theme.css 里找不到 --ui-canvas');
    assert.match(cssCanvas[1], /var\(--ui-canvas-(?:light|dark)\)/,
      '--ui-canvas 必须从亮/暗两档里选，写死颜色会让主题翻不动');

    // JS 只能写亮色档：写 --ui-canvas 本身会锁死主题。
    const effects = read('theme-effects.js');
    assert.doesNotMatch(effects, /setProperty\(\s*["']--ui-canvas["']/,
      'theme-effects.js 不得直接写 --ui-canvas（内联值会压过 :root 的暗色档）');
    assert.match(effects, /setProperty\(\s*["']--ui-canvas-light["']/,
      'theme-effects.js 的 baseColor 应当写进 --ui-canvas-light');
  });

  it('scrollbar styling lives in exactly one place', function () {
    // 用户报的"滚动条又是紫色的，其他地方又是灰色的"：唯一一份滚动条样式在
    // index.css 里、用品牌紫作滑块，而那份样式表只被上传页加载 —— 于是十页里
    // 一页紫、九页浏览器默认灰。滚动条属于浏览器 chrome，只有一处定义。
    //
    // 例外是"藏掉某条滚动条"（.workspace-nav 的横向滚动导航、.header-actions
    // 的溢出区）：那是布局手段，不是配色，且都限定在具体元素上，不参与全站
    // 观感。这里只禁止不带元素的全局选择器去定义滚动条外观。
    const globalAppearance = /(^|[^-\w.])::-(?:webkit|moz)-scrollbar/;
    const owners = sheets.filter((s) => globalAppearance.test(read(s)));
    assert.deepStrictEqual(owners, ['theme.css'],
      `全局滚动条外观只能定义在 theme.css，实际出现在: ${owners.join(', ')}`);
    assert.match(theme, /::-webkit-scrollbar-thumb\s*\{[^}]*background\s*:\s*var\(--ui-/,
      '滚动条滑块颜色应当取中性 token，写品牌色会跟页面状态色争注意力');
    assert.match(theme, /scrollbar-color\s*:/,
      '缺少 Firefox 的 scrollbar-color —— 那边不认 ::-webkit-scrollbar');
  });

  it('solid brand/danger buttons use the theme-aware ink token', function () {
    // 实测踩到的坑：实心按钮上的文字写死 #fff，而夜间品牌色是浅青绿
    // (#5eead4)，白字压上去只有 1.2:1，整个按钮读不出来。品牌底色配的
    // 文字色应当是 --ui-brand-ink（随主题翻转：亮色白字、夜间深字）。
    // 这里只守住"品牌底 + 白字"这一种组合，别的地方用白字是合理的。
    for (const sheet of sheets) {
      const src = read(sheet);
      const brandBgs = [
        /background\s*:\s*var\(--brand\)\s*;/g,
        /background\s*:\s*var\(--primary\)\s*;/g,
      ];
      for (const re of brandBgs) {
        let m;
        while ((m = re.exec(src))) {
          const rule = src.slice(m.index, src.indexOf('}', m.index) + 1);
          assert.doesNotMatch(
            rule,
            /color\s*:\s*(#fff\b|#ffffff\b|white\b)/i,
            `${sheet} 品牌色实心按钮上写死了白色文字，夜间会变成浅底浅字 —— 用 var(--ui-brand-ink)`
          );
        }
      }
    }
  });

  describe('brand colour lives in one place', function () {
    const hueOf = (hex) => {
      const h = hex.replace('#', '');
      const [r, g, b] = [0, 2, 4].map((i) => parseInt(h.slice(i, i + 2), 16) / 255);
      const max = Math.max(r, g, b), min = Math.min(r, g, b), d = max - min;
      if (!d) return null;
      let x = max === r ? ((g - b) / d + (g < b ? 6 : 0)) : max === g ? (b - r) / d + 2 : (r - g) / d + 4;
      return Math.round(x * 60);
    };
    // 只认整块颜色的声明，避免把注释里的举例也当成字面量。
    const colourLiterals = (src) => {
      const out = [];
      const noComments = src.replace(/\/\*[\s\S]*?\*\//g, '');
      for (const m of noComments.matchAll(/#([0-9a-fA-F]{6})\b/g)) {
        const h = hueOf('#' + m[1]);
        if (h === null) continue;
        out.push({ hex: '#' + m[1].toLowerCase(), hue: h });
      }
      return out;
    };

    it('no violet survives anywhere in the stylesheets', function () {
      // 紫色是这次要清掉的东西，也是全站最容易靠"凭手感"再写回来的东西
      // （它当年就散在 10 个文件、106 处）。凡是色相落在 240–300 的有色值
      // 都拦下：写这类颜色时应当引用 --ui-brand 的派生式，而不是新字面量。
      for (const sheet of sheets) {
        for (const { hex, hue } of colourLiterals(read(sheet))) {
          assert.ok(
            !(hue >= 240 && hue <= 300),
            `${sheet} 出现紫色字面量 ${hex}（色相 ${hue}）—— 强调色应当由 var(--ui-brand) 派生，不要新写颜色`
          );
        }
      }
      for (const page of fs.readdirSync(root).filter((f) => f.endsWith('.html'))) {
        for (const { hex, hue } of colourLiterals(read(page))) {
          assert.ok(
            !(hue >= 240 && hue <= 300),
            `${page} 出现紫色字面量 ${hex}（色相 ${hue}）—— 强调色应当由 var(--ui-brand) 派生`
          );
        }
      }
    });

    it('brand tokens are defined exactly once per theme', function () {
      // --ui-brand 是品牌色的唯一来源。同名 token 若在别处再定义一次，
      // 主题切换时两套值会分叉（历史上 webdav 就自带一份 --wf-primary-solid）。
      //
      // 例外：页面**故意**换品牌（preview / admin-waterfall 是青绿那支）。
      // 那不是"第二份真值"，而是该页的品牌定义——但它必须成对给出亮/暗两档，
      // 否则夜间会掉回主站品牌色。下面按文件分组核算。
      const brandDefsIn = (src) => [...src.matchAll(/--ui-brand:\s*([^;]+);/g)].map((m) => m[1].trim());

      const base = brandDefsIn(theme);
      assert.strictEqual(base.length, 2,
        `theme.css 的 --ui-brand 应当只定义亮/暗两档，实际 ${base.length} 处：${JSON.stringify(base)}`);
      assert.ok(base.every((v) => /^#[0-9a-f]{6}$/i.test(v)),
        `theme.css 的 --ui-brand 应当是本层里的具体色值，实际 ${JSON.stringify(base)}`);

      for (const sheet of sheets) {
        if (sheet === 'theme.css') continue;
        const defs = brandDefsIn(read(sheet));
        if (!defs.length) continue;
        // 页面要么完全不定义，要么亮暗成对定义。这里只放行成对的情况。
        const rootBlock = read(sheet).indexOf('html[data-theme="dark"]');
        assert.ok(rootBlock > -1 && defs.length >= 2,
          `${sheet} 重新定义了 --ui-brand，但没有成对给出亮/暗两档 —— 夜间会掉回主站品牌色`);
        assert.ok(defs.every((v) => /^#[0-9a-f]{6}$/i.test(v)),
          `${sheet} 的 --ui-brand 必须是具体色值，实际 ${JSON.stringify(defs)}`);
      }
    });

    it('page-level accent aliases point at the token, never a literal', function () {
      // 各页自定义的强调色别名（--wf-primary / --primary-color / --accent …）
      // 必须别名到品牌 token。写死一个色值就是第二份真值，亮暗两档会各自漂移
      // —— webdav 的 --wf-primary-solid 就是这么来的（同一语义两个值）。
      const aliasRe = /--(primary-color|primary-light|primary-dark|wf-primary|accent)\s*:\s*([^;]+);/g;
      for (const sheet of sheets) {
        // 先去掉注释：注释里说明历史值的文字（"--accent: #f59e0b"）不该被当成声明。
        const src = read(sheet).replace(/\/\*[\s\S]*?\*\//g, '');
        let m;
        while ((m = aliasRe.exec(src))) {
          assert.match(m[2], /var\(--ui-brand/,
            `${sheet} 的 --${m[1]} 写成了 ${m[2].trim()} —— 应别名到 var(--ui-brand*)`);
        }
      }
    });

    it('brand pair clears WCAG AA as ink, as text, and as a ground', function () {
      // 换色时必须同时满足三种用法，任何一头不达标都会让某处读不出来：
      // 作文字压在页面底 / 压在卡片上，以及当实心底时压在其上的 ink。
      const rgb = (hex) => {
        const h = hex.replace('#', '');
        return [0, 2, 4].map((i) => parseInt(h.slice(i, i + 2), 16));
      };
      const lum = ([r, g, b]) => {
        const f = (v) => { v /= 255; return v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4); };
        return 0.2126 * f(r) + 0.7152 * f(g) + 0.0722 * f(b);
      };
      const ratio = (a, b) => {
        const la = lum(rgb(a)), lb = lum(rgb(b));
        return (Math.max(la, lb) + 0.05) / (Math.min(la, lb) + 0.05);
      };
      // 按出现顺序取具体色值：theme.css 里先是亮色档、后是暗色档。
      // 不能用「indexOf('html[data-theme=dark]')」再找第一个 --ui-brand：
      // 文件顶部还有一个历史遗留的 dark 块，那样会取到亮色档的值。
      const brandDefs = [...theme.matchAll(/--ui-brand:\s*(#[0-9a-f]{6})\s*;/gi)].map((m) => m[1]);
      assert.strictEqual(brandDefs.length, 2,
        `theme.css 应当恰好给出亮/暗两档 --ui-brand，实际 ${JSON.stringify(brandDefs)}`);
      const surfaceDefs = [...theme.matchAll(/--ui-surface:\s*(#[0-9a-f]{6})\s*;/gi)].map((m) => m[1]);

      for (const [label, brand, canvas, ink, surface] of [
        ['亮色', brandDefs[0], '#fafaf8', '#ffffff', surfaceDefs[0]],
        ['暗色', brandDefs[1], '#0d1117', '#0d1117', surfaceDefs[1]],
      ]) {
        assert.ok(surface, `${label}找不到 --ui-surface`);
        const onCanvas = ratio(brand, canvas);
        assert.ok(onCanvas >= 4.5, `${label}品牌色 ${brand} 作文字压在页底只有 ${onCanvas.toFixed(2)}:1`);
        const onSurface = ratio(brand, surface);
        assert.ok(onSurface >= 4.5, `${label}品牌色 ${brand} 作文字压在卡片上只有 ${onSurface.toFixed(2)}:1`);
        const asGround = ratio(ink, brand);
        assert.ok(asGround >= 4.5, `${label}品牌色 ${brand} 作实心底时文字只有 ${asGround.toFixed(2)}:1`);
      }
    });
  });
});
