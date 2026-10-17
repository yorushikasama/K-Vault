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
  '--warning-text-color',
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