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

  /**
   * 加载 accent-color.js 并在沙箱里求值。
   *
   * 它同时支持 window / module.exports 双份导出，所以这里可以像测普通模块
   * 一样 require 它 —— 不必去解析页面里的脚本标签。
   */
  const loadAccentModule = () => require(path.join(root, 'accent-color.js'));

  it('every page that renders colour loads the accent deriver', function () {
    // 强调色和中性面的色相都是 accent-color.js 算的。漏掉这个脚本的页面会
    // 静默走单色回退（theme-effects.js 里 paletteApi() 返回 null）——
    // 页面本身不报错，但永远不上色，很难从截图看出是"脚本没加载"。
    for (const page of pages) {
      if (!/href="[^"]*theme\.css/.test(read(page))) continue;
      assert.match(read(page), /src="\/accent-color\.js/,
        `${page} 没有加载 accent-color.js —— 壁纸取色在该页不会生效，页面会一直是黑白`);
    }
  });

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

  /**
   * 加载 accent-color.js 并在沙箱里求值。
   *
   * 它同时支持 window / module.exports 双份导出，所以这里可以像测普通模块
   * 一样 require 它 —— 不必去解析页面里的脚本标签。
   */
  const loadAccentModule = () => require(path.join(root, 'accent-color.js'));

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

    // JS 不得写任何具体的色阶 token —— 三个层级（canvas / surface / ink）
    // 全是内联写入的高危对象：内联值压过 :root，写了就锁死主题。
    const effects = read('theme-effects.js');
    for (const token of ['--ui-canvas', '--ui-canvas-light', '--ui-canvas-dark',
      '--ui-surface', '--ui-ink', '--ui-line']) {
      assert.doesNotMatch(effects, new RegExp(`setProperty\\(\\s*["']${token}["']`),
        `theme-effects.js 不得直接写 ${token}（内联值会压过 :root 的主题档）`);
    }
    // 它只能写两个不分主题的旋钮：色相与着色强度。
    assert.match(effects, /setProperty\(\s*["']--ui-hue["']/,
      'theme-effects.js 应当把壁纸色相写进 --ui-hue');
    assert.match(effects, /setProperty\(\s*["']--ui-tint["']/,
      'theme-effects.js 应当把着色强度写进 --ui-tint');
  });

  it('every neutral colour is derived from the wallpaper knobs', function () {
    // 用户要的"页面所有颜色根据壁纸来自动计算"：不是只改强调色，而是底色、
    // 卡片、描边、文字全部随壁纸的色相走。这里钉住那个结构 —— 每个中性
    // token 都必须是 hsl(var(--ui-hue) … var(--ui-tint) …) 而不是字面量。
    // 一旦有人把某个面写回 #ffffff，那部分就脱离了壁纸，页面会花。
    const NEUTRALS = [
      'canvas-light', 'canvas-dark',
      'surface-light', 'surface-dark',
      'surface-sunken-light', 'surface-sunken-dark',
      'surface-raised-light', 'surface-raised-dark',
      'surface-hover-light', 'surface-hover-dark',
      'surface-active-light', 'surface-active-dark',
      'ink-light', 'ink-dark',
      'ink-secondary-light', 'ink-secondary-dark',
      'ink-muted-light', 'ink-muted-dark',
      'ink-inverse-light', 'ink-inverse-dark',
      'line-light', 'line-dark',
      'line-strong-light', 'line-strong-dark',
    ];
    for (const name of NEUTRALS) {
      const m = new RegExp(`--ui-${name}\\s*:\\s*([^;]+);`).exec(theme);
      assert.ok(m, `theme.css 里缺少 --ui-${name} —— 中性色应当亮/暗成对给出`);
      assert.match(m[1], /var\(--ui-hue\)/,
        `--ui-${name} 写成了 ${m[1].trim()} —— 中性色应当由 --ui-hue 派生，不要字面量`);
      assert.match(m[1], /var\(--ui-tint\)/,
        `--ui-${name} 没跟着 --ui-tint 走 —— 壁纸取色对它不生效`);
    }
  });

  it('with no wallpaper every neutral collapses to pure grey', function () {
    // "如果没有壁纸，那么就是黑色或者白色"：--ui-tint 的默认值必须是 0%，
    // 这样所有 calc(var(--ui-tint) * k) 都塌成 0，hsl(H 0% L%) 与色相无关，
    // 页面就是纯灰阶。若默认值不是 0，没有壁纸的站点会凭空带一层色。
    const m = /--ui-tint\s*:\s*([^;]+);/.exec(theme);
    assert.ok(m, 'theme.css 里找不到 --ui-tint 的默认值');
    assert.match(m[1].trim(), /^0(%|\s*%)?$/,
      `--ui-tint 的默认值是 ${m[1].trim()}，没有壁纸时应当是 0%`);
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
      // --ui-brand 是强调色的唯一来源。同名 token 若在别处再定义一次，
      // 主题切换时两套值会分叉（历史上 webdav 就自带一份 --wf-primary-solid）。
      //
      // 现在的形态是两档实色 + 一个指针：
      //   --ui-brand-light / --ui-brand-dark 由 JS 按壁纸写内联
      //   --ui-brand 从两档里挑一份（暗色块换指针）
      // 所以 theme.css 里 --ui-brand 的值是 var(...) 而不是色值 —— 它已经
      // 不是一个可以写死的字面量了。
      const brandDefsIn = (src) => [...src.matchAll(/--ui-brand:\s*([^;]+);/g)].map((m) => m[1].trim());

      const base = brandDefsIn(theme);
      assert.strictEqual(base.length, 2,
        `theme.css 的 --ui-brand 应当只定义亮/暗两档，实际 ${base.length} 处：${JSON.stringify(base)}`);
      assert.deepStrictEqual(base, ['var(--ui-brand-light)', 'var(--ui-brand-dark)'],
        `--ui-brand 应当从亮/暗两档里挑，实际 ${JSON.stringify(base)}`);

      // 默认值就是黑白：没有壁纸时不取色（用户要的"没有壁纸就是黑色或者白色"）。
      const light = /--ui-brand-light\s*:\s*([^;]+);/.exec(theme);
      const dark = /--ui-brand-dark\s*:\s*([^;]+);/.exec(theme);
      assert.ok(light && dark, 'theme.css 缺少 --ui-brand-light / --ui-brand-dark 的默认值');
      assert.strictEqual(light[1].trim().toLowerCase(), '#000000',
        `--ui-brand-light 的默认值应当是纯黑，实际 ${light[1].trim()}`);
      assert.strictEqual(dark[1].trim().toLowerCase(), '#ffffff',
        `--ui-brand-dark 的默认值应当是纯白，实际 ${dark[1].trim()}`);

      for (const sheet of sheets) {
        if (sheet === 'theme.css') continue;
        const defs = brandDefsIn(read(sheet));
        // 页面一律不得再定义品牌色：强调色是壁纸算出来的，页面自己钉一个值
        // 就是"第二份真值"，跳转时观感会断（预览页和瀑布流此前各有一套青绿）。
        assert.deepStrictEqual(defs, [],
          `${sheet} 重新定义了 --ui-brand（${JSON.stringify(defs)}）—— 强调色由壁纸派生，页面不得钉色`);
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

    it('derivation always lands on WCAG AA, for every hue', function () {
      // 这里不再校验"某个色值达标"，而是校验**派生函数本身**达标：壁纸的
      // 色相是任意值（0–360° 连续），页面必须照样读得清。旧测试钉的是两个
      // 固定色值（#1a5fa8 / #79b8ff），换色就得改测试 —— 而现在已经没有
      // 固定色值可钉了，所以改成遍历全色相去证明"不存在读不清的壁纸"。
      //
      // 顺带说明为什么强调色必须分两档：同一个颜色压不到两种底色上。老品牌
      // 蓝 #1a5fa8 在深色底上只有 2.67:1，它的夜间档 #79b8ff 在白底上只有
      // 1.99:1 —— 亮暗各算一个不是设计偏好，是可读性的硬要求。
      const accent = loadAccentModule();

      // 中性面的底色配方（与 theme.css 的 calc 系数一一对应）。
      // 这些数字改了的话，这里的断言会失败 —— 那正是想要的：配方是
      // 对比度的地基，动了就必须重新验证。
      const TINT = accent.TINT_MAX;
      const LIGHT_BG = [
        ['canvas', 0.78, 97], ['surface', 0.35, 99],
        ['sunken', 0.70, 95.5], ['active', 0.85, 93.5],
      ];
      const DARK_BG = [
        ['canvas', 0.80, 7.1], ['surface', 1.00, 11],
        ['raised', 1.05, 14.2], ['active', 1.15, 19],
      ];
      const surfaceHexes = (recipe, hue) =>
        recipe.map(([, k, l]) => accent.rgbToHex(accent.hslToRgb(hue, (TINT / 100) * k, l / 100)));

      let worstLight = { ratio: Infinity };
      let worstDark = { ratio: Infinity };
      for (let hue = 0; hue < 360; hue += 1) {
        const lightBgs = surfaceHexes(LIGHT_BG, hue);
        const darkBgs = surfaceHexes(DARK_BG, hue);
        const pair = accent.buildAccent(hue, {
          backgroundsLight: lightBgs,
          backgroundsDark: darkBgs,
          saturation: 0.6,
        });
        // 作文字：压在每一种底面上都要达标（不是只压最白那个）
        for (const bg of lightBgs) {
          const r = accent.contrastRatio(accent.hexToRgb(pair.light), accent.hexToRgb(bg));
          if (r < worstLight.ratio) worstLight = { ratio: r, hue, bg };
        }
        for (const bg of darkBgs) {
          const r = accent.contrastRatio(accent.hexToRgb(pair.dark), accent.hexToRgb(bg));
          if (r < worstDark.ratio) worstDark = { ratio: r, hue, bg };
        }
        // 作实心底：强调色自己当按钮底色时，压在其上的反相文字也要达标
        assert.ok(accent.contrastRatio(accent.hexToRgb(pair.light), [255, 255, 255]) >= 4.5,
          `hue ${hue}: 亮档强调色作实心底时白字只有 ${accent.contrastRatio(accent.hexToRgb(pair.light), [255, 255, 255]).toFixed(2)}:1`);
        assert.ok(accent.contrastRatio(accent.hexToRgb(pair.dark), [0, 0, 0]) >= 4.5,
          `hue ${hue}: 暗档强调色作实心底时黑字只有 ${accent.contrastRatio(accent.hexToRgb(pair.dark), [0, 0, 0]).toFixed(2)}:1`);
      }

      assert.ok(worstLight.ratio >= 4.5,
        `亮档强调色压在 (hue ${worstLight.hue}, ${worstLight.bg}) 上只有 ${worstLight.ratio.toFixed(2)}:1`);
      assert.ok(worstDark.ratio >= 4.5,
        `暗档强调色压在 (hue ${worstDark.hue}, ${worstDark.bg}) 上只有 ${worstDark.ratio.toFixed(2)}:1`);
    });

    it('falls back to black and white when there is no wallpaper', function () {
      // 用户的原话："如果没有壁纸，那么就是黑色或者白色"。
      // 三种输入都算"没有可用壁纸"：没有壁纸、灰阶壁纸、非数字色相。
      const accent = loadAccentModule();
      for (const [label, input] of [
        ['没有壁纸', null],
        ['undefined', undefined],
        ['NaN', NaN],
        ['空串', ''],
        ['灰阶壁纸（提取不出色相）', { hue: 0, sat: 0 }],
      ]) {
        const palette = accent.buildPalette(input, {});
        assert.strictEqual(palette.tint, 0, `${label}: tint 应当是 0，实际 ${palette.tint}`);
        assert.strictEqual(palette.mono, true, `${label}: 应当走单色回退`);
        assert.strictEqual(palette.hasWallpaperHue, false, `${label}: 不该认为取到了色相`);
        assert.strictEqual(palette.accent.light, '#000000', `${label}: 亮档应当是纯黑`);
        assert.strictEqual(palette.accent.dark, '#ffffff', `${label}: 暗档应当是纯白`);
      }
    });

    it('gives a coloured wallpaper a non-zero tint', function () {
      // 反向守住：有颜色的壁纸必须真的染上页面，否则"取色"是空转。
      const accent = loadAccentModule();
      const palette = accent.buildPalette({ hue: 210, sat: 0.6 }, {});
      assert.ok(palette.tint > 0, `有色壁纸的 tint 应当大于 0，实际 ${palette.tint}`);
      assert.ok(palette.tint <= accent.TINT_MAX,
        `tint ${palette.tint} 超出对比度上限 ${accent.TINT_MAX}`);
      assert.strictEqual(palette.mono, false, '有彩壁纸不该走单色回退');
      assert.notStrictEqual(palette.accent.light, '#000000', '有彩壁纸的强调色不该是纯黑');
    });
  });
});
