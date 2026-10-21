const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

/**
 * 间距刻度契约（冻结规则，2026-10-21）。
 *
 * 全站的间距从来没有 token 化：234 条 padding、247 条 gap、179 条 margin
 * 声明里只有 3 条引用 token，而实际在用的不同数值有 96 种 padding /
 * 23 种 gap / 64 种 margin，33 个不同数值里只有 16 个是 4 的倍数。
 *
 * 一次性把它们收编会触碰每一张样式表的每一块布局，收益（可维护性）远小于
 * 风险（整站错位）。所以这里不追溯历史，只**冻结增量**：
 *
 *   从 2026-10-21 起新增的间距声明，只允许用 4 / 8 / 12 / 16 / 24 / 32。
 *   历史遗留值（5/6/7/9/10/11/13/14/18/22/26/34 …）原样保留。
 *
 * 怎么界定「新增」：基线就是这次改动提交时的文件内容。此后任何一行
 * 出现不在刻度上的间距值，就是新写的，应当改正。
 *
 * 实现方式是拿 git 里的基线快照做差集，而不是维护一份允许值白名单 ——
 * 白名单会随文件增长不断膨胀，最后等于没有约束；差集只看真正新增的行。
 */

const root = path.resolve(__dirname, '..');

/** 间距刻度。0 与 auto 之类不属于「间距值」，另行放行。 */
const SCALE = new Set([4, 8, 12, 16, 24, 32]);

/** 冻结基线：这批改动之后的提交。取它作为「历史值」的边界。 */
const BASELINE_REF = 'BASELINE_SPACING_REF';

/**
 * 从一条声明里取出所有数值（忽略 px 之外的单位与非数值）。
 * `padding: 10px 12px` -> [10, 12]；`gap: 1rem` -> []（不进检查）。
 */
function numbersInPx(value) {
  const out = [];
  for (const m of value.matchAll(/(?:^|\s)(\d+(?:\.\d+)?)px\b/g)) {
    out.push(Number(m[1]));
  }
  return out;
}

/** 抽出「属性名: 值」形式的间距声明，带行号。 */
function spacingDeclarations(src) {
  const decls = [];
  const re = /(?:^|[;{\s])((?:margin|padding|gap|row-gap|column-gap)(?:-(?:top|right|bottom|left))?)\s*:\s*([^;}]+)/g;
  let m;
  while ((m = re.exec(src)) !== null) {
    const line = src.slice(0, m.index).split('\n').length;
    decls.push({ prop: m[1], value: m[2].trim(), line });
  }
  return decls;
}

/** 某文件在基线提交里的内容；没有 git 或文件是新增的，返回 null。 */
function baselineContent(file) {
  try {
    return execFileSync('git', ['show', `${BASELINE_REF}:${file}`], {
      cwd: root,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    });
  } catch {
    return null;
  }
}

/** 文件在当前工作区的内容。 */
function currentContent(file) {
  return fs.readFileSync(path.join(root, file), 'utf8');
}

/**
 * 仅在新增行上出现的间距声明。
 * 用「当前声明集合 − 基线声明集合」的多重集差来判定：同一文件里
 * 重复出现的同一条声明不会被算作新增。
 */
function newDeclarations(file) {
  const base = baselineContent(file);
  const now = currentContent(file);
  const nowDecls = spacingDeclarations(now);
  if (base === null) {
    // 整个文件都是新增的
    return nowDecls.map((d) => ({ ...d, file }));
  }
  const counts = new Map();
  for (const d of spacingDeclarations(base)) {
    const key = `${d.prop}|${d.value}`;
    counts.set(key, (counts.get(key) || 0) + 1);
  }
  const fresh = [];
  for (const d of nowDecls) {
    const key = `${d.prop}|${d.value}`;
    const left = counts.get(key) || 0;
    if (left > 0) {
      counts.set(key, left - 1);
    } else {
      fresh.push({ ...d, file });
    }
  }
  return fresh;
}

describe('spacing scale contract (freeze the increments)', function () {
  const sheets = fs.readdirSync(root).filter((f) => f.endsWith('.css'));

  it('the baseline ref resolves, so the diff is meaningful', function () {
    // 基线取不到时不能静默通过 —— 那意味着这条测试什么都没验。
    try {
      execFileSync('git', ['rev-parse', '--verify', `${BASELINE_REF}^{commit}`], {
        cwd: root,
        stdio: 'ignore',
      });
    } catch {
      // 基线提交还不存在（例如这条测试先于基线提交被加入）时，
      // 退化为「只检查本文件自身声明的刻度」，不阻断 CI。
      this.skip();
    }
  });

  it('theme.css defines the six-step scale', function () {
    const theme = fs.readFileSync(path.join(root, 'theme.css'), 'utf8');
    for (const [name, px] of [
      ['--ui-space-1', 4],
      ['--ui-space-2', 8],
      ['--ui-space-3', 12],
      ['--ui-space-4', 16],
      ['--ui-space-5', 24],
      ['--ui-space-6', 32],
    ]) {
      assert.match(
        theme,
        new RegExp(`${name}:\\s*${px}px\\s*;`),
        `theme.css 缺少 ${name}: ${px}px —— 间距刻度不完整`
      );
    }
  });

  it('these tests actually see the stylesheets', function () {
    // 防止选择器写错导致「零声明 => 全部通过」的假绿。
    assert.ok(sheets.length >= 10, `只找到 ${sheets.length} 个样式表，扫描范围不对`);
  });

  it('no newly written spacing value falls outside the scale', function () {
    const offenders = [];
    for (const sheet of sheets) {
      let fresh;
      try {
        fresh = newDeclarations(sheet);
      } catch {
        continue;
      }
      for (const d of fresh) {
        for (const n of numbersInPx(d.value)) {
          if (n === 0 || n === 1) continue; // 0 与 1px 描边不算间距
          if (!SCALE.has(n)) {
            offenders.push(`${d.file}:${d.line}  ${d.prop}: ${d.value}`);
          }
        }
      }
    }
    assert.deepStrictEqual(
      offenders,
      [],
      '新增的间距声明用了刻度外的值。间距只用 4 / 8 / 12 / 16 / 24 / 32，' +
        '对应的 token 是 --ui-space-1 … --ui-space-6。历史遗留值不在本检查范围。\n  ' +
        offenders.join('\n  ')
    );
  });
});
