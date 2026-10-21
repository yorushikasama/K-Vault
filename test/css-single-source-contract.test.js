const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

/**
 * 样式单一来源契约（2026-10-17 用户决策：所有样式必须由全局统一管理）。
 *
 * 背景：全仓曾有四类"绕开 theme.css 权威层"的样式 ——
 *   1. mobile-refactor.css 的 --m-* 体系（surface/border/shadow/radius/font
 *      亮暗各一份硬编码真值，移动端卡片纯白、不跟随主题与 UI 面板设置）
 *   2. preview.css 的代码块配色 #f6f8fa/#1f2328 亮暗两份
 *   3. index.css 的 --warning-text-color 硬编码（权威层明明有 --ui-warning）
 *   4. --card-bg/--primary/--shadow 等跨页别名在 5 个页面文件里各抄一遍
 * 已全部收编：硬编码进 theme.css，别名集中到 theme.css 的 back-compat 区。
 *
 * 本契约把"统一管理"机械化，三条规则：
 *   A. 非 theme.css 文件不得定义硬编码 token 真值 —— 定义值必须引用 var()，
 *      即只许做权威层的转发别名（workbench 的 --wb-*、preview 的 --panel
 *      这类有序别名层是合法的）。布局尺寸常量白名单例外。
 *   B. --m-* 前缀不得回流（体系已拆，注释里的历史提及不算）。
 *   C. 跨页共用别名只许在 theme.css 定义，页面文件不得再各写一份。
 */

const root = path.resolve(__dirname, '..');
const AUTHORITATIVE = 'theme.css';

const LAYOUT_CONSTS = new Set([
  // 组件结构参数，非主题样式：值不是颜色/阴影/字体，不构成主题双源
  '--nav-height',
  '--nav-offset',
]);

const RESERVED_ALIASES = [
  '--bg-gradient', '--card-bg', '--shadow', '--shadow-hover',
  '--primary', '--primary-light', '--primary-dark', '--accent',
  '--transition', '--surface-1', '--surface-2', '--surface-3',
  '--surface-border', '--input-border',
  '--text-primary', '--text-secondary', '--text-muted',

];

function readSheet(name) {
  return fs.readFileSync(path.join(root, name), 'utf8');
}

function sheetNames() {
  return fs.readdirSync(root).filter((f) => f.endsWith('.css'));
}

/** 去掉 /* *\/ 注释后再分析，避免注释里的历史提及被误判。 */
function stripComments(css) {
  return css.replace(/\/\*[\s\S]*?\*\//g, '');
}

/** 收集 [文件名, token 名, 值] 三元组。 */
function collectDefinitions() {
  const defs = [];
  for (const name of sheetNames()) {
    const src = stripComments(readSheet(name));
    const re = /^\s*(--[a-zA-Z][\w-]*)\s*:\s*([^;]+);/gm;
    let m;
    while ((m = re.exec(src))) {
      defs.push({ file: name, token: m[1], value: m[2].trim() });
    }
  }
  return defs;
}

describe('CSS single-source contract', function () {
  const defs = collectDefinitions();

  it('no sheet but theme.css may define a token whose value is a hard truth', function () {
    // 规则 A：非权威层的 token 定义值必须包含 var( —— 即只许转发权威层。
    const offenders = defs.filter(
      (d) => d.file !== AUTHORITATIVE
        && !LAYOUT_CONSTS.has(d.token)
        && !/var\(/.test(d.value)
    );
    assert.deepStrictEqual(
      offenders.map((d) => `${d.file}: ${d.token}: ${d.value}`),
      [],
      '存在绕开 theme.css 的硬编码 token 真值。颜色/阴影/字体/圆角属于主题样式，' +
        '必须进 theme.css 权威层或引用 var(--ui-*)；布局尺寸常量请加入 LAYOUT_CONSTS 白名单并说明理由'
    );
  });

  it('the retired --m-* namespace stays retired', function () {
    // 规则 B：--m-* 体系已整体拆除（历史背景见 mobile-refactor.css 头部注释）。
    const offenders = sheetNames().filter((f) => /--m-[a-z]/.test(stripComments(readSheet(f))));
    assert.deepStrictEqual(offenders, [],
      `${offenders.join(', ')} 里出现了 --m-* —— 该私有体系已拆除，请改用 theme.css 的全局 token`);
  });

  it('shared cross-page aliases are defined only in theme.css', function () {
    // 规则 C：跨页别名集中管理。曾经这批名字在 5 个页面文件里各抄一份，
    // 回退值各自漂移（有一处还抄错了颜色）。现在谁再想本地定义都会在这里被拦下。
    const offenders = defs.filter(
      (d) => d.file !== AUTHORITATIVE && RESERVED_ALIASES.includes(d.token)
    );
    assert.deepStrictEqual(
      offenders.map((d) => `${d.file}: ${d.token}`),
      [],
      '跨页共用别名只允许在 theme.css 的 back-compat 集中区定义，' +
        '页面文件请直接消费（theme-effects.js 运行时会以内联值覆盖其中一部分）'
    );
  });

  it('theme.css actually provides every reserved alias', function () {
    // 配套守卫：集中区必须真的存在，否则规则 C 会把页面饿死
    // （token 未定义时消费点回退到初始值，视觉静默崩坏且无报错）。
    const defined = new Set(
      defs.filter((d) => d.file === AUTHORITATIVE).map((d) => d.token)
    );
    const missing = RESERVED_ALIASES.filter((a) => !defined.has(a));
    assert.deepStrictEqual(missing, [],
      `theme.css 的 back-compat 集中区缺少：${missing.join(', ')}`);
  });
});
describe('card blur consumer chain', function () {
  // 「模糊强度」滑杆的载体是 --ui-card-backdrop-filter（theme-effects.js
  // 按需写出 blur(Npx) saturate(115%) 或 none）。2026-10-17 之前只有
  // index / workbench / admin 弹窗消费它，gallery / video / login / preview
  // 四页的卡片没有任何 backdrop-filter —— 滑杆在那四页是摆设（透明度
  // 却有效，因为 --card-bg 走 color-mix 全局生效），典型的"消费链断裂"。
  // 这组断言钉住每页的最低消费数，防止重构时再把某页的模糊摘掉。

  /** 页面文件 → 至少需要的标准消费数（-webkit- 前缀行不计）。 */
  const BLUR_CONSUMERS = {
    'index.css': 2,       // .header / .card（另有弹窗）
    'workbench.css': 2,   // files-query / file-tile 等
    /* 媒体列表页（图库 / 视频）的工具栏外壳 2026-10-21 收进 media-list.css，
       两页共用一份；各自只剩卡片。加起来必须仍覆盖两页原先的消费数。 */
    'media-list.css': 1,  // .toolbar（两页共用）
    'gallery.css': 1,     // .image-card
    'video.css': 2,       // .video-folders / .video-card
    'login.css': 1,       // .login-card
    'preview.css': 3,     // .topbar / .file-panel / .viewer
    'app-shell.css': 1,   // header.workspace-header（四分区页共用顶栏）
    'shell-panels.css': 1, // .shell-panel（系统连接 / UI 设计浮层）
    /* 提示页（图片已屏蔽 / 白名单已开启）原本各有一份 .container，
       现已合并为 notice.css 的 .notice —— 两页共用一张表。
       见 notice.css 顶部注释。 */
    'notice.css': 1,
    'theme.css': 3,       // el-dialog + toast
  };

  function countBlurConsumers(sheet) {
    const src = stripComments(readSheet(sheet));
    return (src.match(/backdrop-filter:\s*var\(--ui-card-backdrop-filter\)/g) || []).length;
  }

  for (const [sheet, min] of Object.entries(BLUR_CONSUMERS)) {
    it(`${sheet} consumes --ui-card-backdrop-filter at least ${min}x`, function () {
      const hits = countBlurConsumers(sheet);
      assert.ok(hits >= min,
        `${sheet} 仅 ${hits} 处 backdrop-filter 消费（需 ≥ ${min}）——` +
        `「模糊强度」滑杆在该页会失效`);
    });
  }

  it('mobile breakpoints keep disabling backdrop-filter (perf convention)', function () {
    // 移动端禁用高耗效果是全站惯例。各页自己断点内关闭；login 的
    // .login-card 由 mobile-refactor.css 的 900px 断点兜住。
    const selfDisabling = ['index.css', 'gallery.css', 'video.css', 'preview.css', 'app-shell.css', 'mobile-refactor.css', 'media-list.css'];
    for (const sheet of selfDisabling) {
      const src = stripComments(readSheet(sheet));
      assert.ok(
        /backdrop-filter:\s*none/.test(src),
        `${sheet} 的移动端断点缺少 backdrop-filter: none —— 高耗效果惯例被破坏`
      );
    }
  });

  it('top-level card surfaces do not regress to bare --ui-surface', function () {
    // 2026-10-17 同款断链的第三批修复：app-shell 顶栏 / shell-panels 浮层 /
    // 提示页卡片曾裸引 var(--ui-surface)，对「卡片透明度」旋钮完全无感。
    // 这些顶层卡片面必须走 --card-bg（theme-effects.js 写的 color-mix 版；
    // 嵌套小控件保持实色是 workbench --wb-subtle 的既有决策，不在本断言范围）。
    //
    // 提示页原本是 block-img.css / whitelist-on.css 两份，2026-10-21 合并为
    // notice.css 的 .notice（两张表只差一个图标底色，见 notice.css 注释）。
    const MUST_USE_CARD_BG = [
      'app-shell.css',     // header.workspace-header
      'shell-panels.css',  // .shell-panel
      'notice.css',        // .notice（图片已屏蔽 / 白名单已开启共用）
    ];
    for (const sheet of MUST_USE_CARD_BG) {
      const src = stripComments(readSheet(sheet));
      assert.ok(
        /background:\s*var\(--card-bg\)/.test(src),
        `${sheet} 的顶层卡片面必须用 var(--card-bg)（携带用户透明度），` +
        `裸 var(--ui-surface) 会让「卡片透明度」滑杆在该页失效`
      );
    }
  });

  it('preview --panel carries the user card opacity (not a bare surface)', function () {
    // preview.css 曾裸引 var(--ui-surface)：预览页对「卡片透明度」滑杆
    // 完全无感（同日的另一处消费链断裂）。--panel 必须走 color-mix
    // 消费 --ui-card-opacity，与 workbench 的 --wb-surface 同模式。
    const src = stripComments(readSheet('preview.css'));
    const bare = /^\s*--panel:\s*var\(--ui-surface\)\s*;/m.test(src);
    assert.ok(!bare,
      'preview.css 的 --panel 又变回裸 var(--ui-surface)，透明度旋钮在预览页会失效');
    assert.ok(
      /--panel:\s*color-mix\(\s*in srgb,\s*var\(--ui-surface\)\s*calc\(var\(--ui-card-opacity\)/.test(src),
      'preview.css 的 --panel 必须经 color-mix 消费 --ui-card-opacity'
    );
  });

  it('preview .topbar/.viewer rules never re-declare an opaque background', function () {
    // preview.css 历史上叠了三套同名 .topbar/.viewer 规则，最终生效的是
    // 最后一套的硬编码（#fbfffe / 裸 --ui-surface）—— 把第一套携带用户
    // 透明度的 --panel 整个架空，预览页旋钮失效的直接元凶。此断言逐块
    // 扫描 .topbar / .viewer 选择器：背景一旦是裸 ui-surface 或硬编码
    // 色值即失败（--panel / surface 别名合法）。
    const src = stripComments(readSheet('preview.css'));
    const blockRe = /(^|\})\s*([^{}]*\.(?:topbar|viewer)\b[^{}]*)\{([^}]*)\}/g;
    let m;
    while ((m = blockRe.exec(src)) !== null) {
      const decls = m[3];
      const bg = /(?:^|;)\s*background:\s*([^;]+);/.exec(decls);
      if (!bg) continue;
      const value = bg[1].trim();
      assert.ok(
        /var\(--(panel|surface-[123]|card-bg|ui-stage)\)/.test(value) && !/var\(--ui-surface\)/.test(value),
        `preview.css 的 .topbar/.viewer 规则声明了架空背景「${value}」` +
        `—— 预览页旋钮会被这条规则整体失效`
      );
    }
  });

  it('preview paper/gate/media faces never re-declare an opaque background', function () {
    // 第十一批收编面：预览页的纸面页（markdown/data/archive/font/summary/
    // email/doc-page）、视图容器（summary/email/enhanced/doc/text-view）、
    // 加载门（deferred-gate）、媒体台（media-frame/preview-image/
    // preview-video）、音频台（audio-console）、压缩包代码窗
    // （archive-entry-preview/archive-list）与文件面板（file-panel）——
    // 这些块历史上散落 #fff/#f8fafc/#0f172a 系硬编码，用户拖「卡片
    // 透明度」时整面纹丝不动，暗色模式下还保持死白/死黑。逐块扫描：
    // 背景必须转发 token（--panel / surface 别名 / --ui-stage / --code-bg）。
    const src = stripComments(readSheet('preview.css'));
    const blockRe = /(^|\})\s*([^{}]*\.(?:topbar|viewer|file-panel|markdown-page|data-page|archive-page|font-page|summary-page|email-page|email-body|email-header|email-view|enhanced-view|doc-view|doc-page|summary-view|text-view|deferred-gate|audio-console|media-frame|preview-image|preview-video|archive-entry-preview|archive-list)\b[^{}]*)\{([^}]*)\}/g;
    let m;
    while ((m = blockRe.exec(src)) !== null) {
      const decls = m[3];
      const bg = /(?:^|;)\s*background:\s*([^;]+);/.exec(decls);
      if (!bg) continue;
      const value = bg[1].trim();
      assert.ok(
        /var\(--(panel|surface-[123]|card-bg|ui-stage|code-bg)\)/.test(value) && !/var\(--ui-surface\)/.test(value),
        `preview.css 的「${m[2].trim().replace(/\s+/g, ' ')}」声明了架空背景「${value}」` +
        `—— 预览页透明度旋钮会被这条规则架空`
      );
    }
  });

  it('workbench --wb-subtle carries the user card opacity', function () {
    // --wb-subtle 用于拖放区/限额条/空态等大块嵌套面。曾裸引 sunken 实色：
    // 用户拖「卡片透明度」时上传/文件页大片区域纹丝不动。必须走 color-mix
    // （单层：sunken 基色 × 用户透明度，非嵌套双重 mix）。
    const src = stripComments(readSheet('workbench.css'));
    const def = /--wb-subtle:\s*([^;]+);/.exec(src);
    assert.ok(def, 'workbench.css 缺少 --wb-subtle 定义');
    assert.ok(
      /var\(--ui-card-opacity\)/.test(def[1]),
      `--wb-subtle 必须消费 --ui-card-opacity（现为「${def[1].trim()}」），` +
      `否则拖放区/限额条/空态对透明度旋钮无感`
    );
  });

  it('every page takes its font stack from --ui-font-body', function () {
    // 2026-10-21：字体栈曾是全站最分散的一处 —— 图库、视频、首页、登录、
    // 预览、顶栏、浮层各写一份私有栈，字宽与字形因此逐页不同。收编后
    // 只有 theme.css 定义真值，其余文件要么不声明（继承 body），要么
    // 转发 var(--ui-font-body) / var(--ui-font-display)。
    //
    // 例外只有等宽栈：代码块要的是字形固定的 monospace，不是"正文字体"，
    // 强行转发会让代码与正文同宽，失去对齐能力。
    const MONOSPACE_OK = new Set(['gallery.css', 'preview.css']);
    const sheets = fs.readdirSync(root)
      .filter((f) => f.endsWith('.css'))
      .filter((f) => f !== AUTHORITATIVE);

    for (const sheet of sheets) {
      const src = stripComments(readSheet(sheet));
      // font-family 一律检查；font: 简写同时声明了字号/行高/字族，也要查。
      const fa = /font-family:\s*([^;]+);/g;
      const shorthand = /(?:^|[;{]\s*)font:\s*([^;]+);/g;
      let m;
      while ((m = fa.exec(src)) !== null) {
        const value = m[1].trim();
        if (/^var\(--ui-font-/.test(value)) continue;
        if (MONOSPACE_OK.has(sheet) && /monospace/i.test(value)) continue;
        assert.fail(
          `${sheet} 声明了私有字体栈「${value}」—— 必须转发 var(--ui-font-body)，` +
          `否则该页字形与字宽会与全站其它页不一致`
        );
      }
      while ((m = shorthand.exec(src)) !== null) {
        const value = m[1].trim();
        if (/var\(--ui-font-/.test(value)) continue;
        // 同 font-family 的例外：代码块要字形固定的等宽栈。
        if (MONOSPACE_OK.has(sheet) && /monospace/i.test(value)) continue;
        // 只关心显式列了字族的简写；纯尺寸简写（font: 14px/1.6）不涉及字形。
        if (!/["']/.test(value) && !/\b(system-ui|sans-serif|serif)\b/.test(value)) continue;
        assert.fail(
          `${sheet} 的 font: 简写内联了私有字体栈「${value}」—— ` +
          `简写会一并复写 font-family，必须改用 font: <size>/<lh> var(--ui-font-body)`
        );
      }
    }
  });

  it('the authoritative font stack keeps the Latin-first order', function () {
    // 顺序本身就是契约。字体栈首位决定 Latin 字形：若把 CJK 字体提到
    // "Segoe UI" 之前，Windows 上连拉丁字母也改用 Noto Sans SC ——
    // 输入框固有宽度随之变化，工具栏会从两行塌成一行（实测
    // .toolbar-left 554px → 585px）。-apple-system / BlinkMacSystemFont
    // 只在 Apple 平台解析，其余平台跳过，留在栈首无害。
    const src = stripComments(readSheet(AUTHORITATIVE));
    const def = /--ui-font-body:\s*([^;]+);/.exec(src);
    assert.ok(def, 'theme.css 缺少 --ui-font-body 定义');
    const stack = def[1];
    const segPos = stack.search(/"Segoe UI"|Segoe UI/);
    assert.ok(segPos > -1, `--ui-font-body 必须显式列出 "Segoe UI"（现为「${stack}」）`);

    for (const cjk of ['"Noto Sans SC"', '"PingFang SC"', '"Microsoft YaHei"']) {
      const pos = stack.indexOf(cjk);
      if (pos === -1) continue;
      assert.ok(
        pos > segPos,
        `--ui-font-body 里 ${cjk} 必须排在 "Segoe UI" 之后（现为「${stack}」）——` +
        `CJK 字体前置会让 Windows 上的拉丁字形也改用它，页面宽度整体漂移`
      );
    }
  });
});