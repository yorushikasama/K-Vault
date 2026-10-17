const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

/**
 * shell-tools.js 的词法作用域完整性。
 *
 * 2026-10-17 的事故：toggleLoginRow()（原 450 行）引用了 checkedValue，
 * 但它定义在兄弟函数 readValues() 内部 —— 作用域不可达，运行时抛
 * ReferenceError: checkedValue is not defined。该错误先在 wire() 末尾
 * 爆一次（Uncaught (in promise)），之后用户每拖一次滑杆，applyPreview()
 * 又在调用 manager.previewSettings() 之前崩掉 —— 表现为 UI 设计面板
 * 的全部交互（滑杆、radio、保存预览）"集体失效"，而事件绑定其实是好的。
 *
 * 这类错误静态契约测试抓不到（引用在文件里"存在"，只是作用域错了），
 * 现有测试也没有 DOM 桩可以真正执行面板流程。所以这里内嵌一个迷你
 * 作用域分析器：剥掉字符串/注释/正则后配平括号，构建函数嵌套树，
 * 然后校验每一处对本文件函数名/变量名的引用都能沿词法祖先链解析。
 * 它覆盖 shell-tools.js 里全部函数，不是只盯 checkedValue 一个名字。
 *
 * 配套的第二条用例把事故当时的代码形状内嵌为样本，证明分析器
 * 真的能抓到它（否则上面那条断言可能恒真，等于没有守卫）。
 */

/** 把字符串/注释/正则字面量替换成等长空格，只留代码骨架（偏移不变）。 */
function skeletonOf(src) {
  const out = src.split('');
  const n = src.length;
  const blank = (from, to) => {
    for (let k = from; k <= to && k < n; k++) {
      if (out[k] !== '\n' && out[k] !== '\r') out[k] = ' ';
    }
  };
  const prevCode = (upto) => {
    for (let j = upto - 1; j >= 0; j--) {
      if (!/\s/.test(src[j])) return src[j];
    }
    return '';
  };
  let i = 0;
  while (i < n) {
    const c = src[i];
    if (c === '/' && src[i + 1] === '/') {
      let j = src.indexOf('\n', i);
      if (j === -1) j = n;
      blank(i, j - 1); i = j; continue;
    }
    if (c === '/' && src[i + 1] === '*') {
      let j = src.indexOf('*/', i + 2);
      if (j === -1) j = n; else j += 1;
      blank(i, j); i = j + 1; continue;
    }
    if (c === '"' || c === "'") {
      let j = i + 1;
      while (j < n) {
        if (src[j] === '\\') { j += 2; continue; }
        if (src[j] === c) break;
        j++;
      }
      blank(i, Math.min(j, n - 1)); i = Math.min(j, n - 1) + 1; continue;
    }
    // 正则字面量 vs 除法：前一有效字符是这些之一时才当正则。
    // shell-tools.js 的正则全部形如 .replace(/&/g, ...)，落在 '(' 之后。
    if (c === '/' && /[(,=:[!&|?;+\-*/%<>~^]/.test(prevCode(i))) {
      let j = i + 1;
      let cls = false;
      while (j < n) {
        const d = src[j];
        if (d === '\\') { j += 2; continue; }
        if (d === '[') cls = true;
        else if (d === ']') cls = false;
        else if (d === '/' && !cls) break;
        j++;
      }
      let k = j + 1;
      while (k < n && /[dgimsuy]/.test(src[k])) k++;
      blank(i, k - 1); i = k; continue;
    }
    i++;
  }
  return out.join('');
}

/** 三种括号配平：open 偏移 -> close 偏移。 */
function bracketPairs(skel) {
  const pairs = new Map();
  const stack = [];
  const match = { '(': ')', '[': ']', '{': '}' };
  for (let i = 0; i < skel.length; i++) {
    const c = skel[i];
    if (c === '(' || c === '[' || c === '{') stack.push([c, i]);
    else if (c === ')' || c === ']' || c === '}') {
      const top = stack.pop();
      if (top && match[top[0]] === c) pairs.set(top[1], i);
    }
  }
  return pairs;
}

const KEYWORDS = new Set(
  ('function var let const if else for while do switch case default break continue ' +
    'return new delete typeof instanceof void in of this try catch finally throw with ' +
    'async await yield class extends super import export debugger true false null undefined').split(' ')
);

/**
 * 返回全部作用域违例：[{ name, line, scope }]。
 * 只校验"引用了本文件某函数/变量名"的位置 —— 内置 API、属性访问
 * 天然不在名单里，不需要全局白名单，也就不会误报。
 */
function scopeViolations(src) {
  const skel = skeletonOf(src);
  const pairs = bracketPairs(skel);
  const funcs = [];

  const headRe = /\bfunction\s*(?:([A-Za-z_$][\w$]*)\s*)?\(/g;
  let m;
  while ((m = headRe.exec(skel))) {
    const paren = m.index + m[0].length - 1;
    const close = pairs.get(paren);
    if (close === undefined) continue;
    let b = close + 1;
    while (b < skel.length && /\s/.test(skel[b])) b++;
    if (skel[b] !== '{') continue;
    const end = pairs.get(b);
    if (end === undefined) continue;
    const params = [];
    for (const pm of skel.slice(paren + 1, close).matchAll(/[A-Za-z_$][\w$]*/g)) {
      params.push(pm[0]);
    }
    funcs.push({ name: m[1] || null, open: paren, start: b, end, params, locals: [], parent: null });
  }

  // 归属区间含参数列表 [open, end)：参数位置的引用属于该函数本身。
  const innermost = (pos) => {
    let best = null;
    for (const f of funcs) {
      if (f.open < pos && f.end > pos) {
        if (!best || (f.open > best.open && f.end < best.end)) best = f;
      }
    }
    return best;
  };

  funcs.sort((a, b) => a.start - b.start);
  for (const f of funcs) {
    f.parent = null;
    for (const g of funcs) {
      if (g === f || g.start >= f.start || g.end <= f.end) continue;
      if (!f.parent || (g.start > f.parent.start && g.end < f.parent.end)) f.parent = g;
    }
  }

  // 函数声明/表达式的名字绑定在外层函数作用域（兄弟互调靠它）。
  for (const f of funcs) if (f.name && f.parent) f.parent.locals.push(f.name);

  const varRe = /\b(?:var|let|const)\s+([A-Za-z_$][\w$]*)/g;
  while ((m = varRe.exec(skel))) {
    const owner = innermost(m.index);
    if (owner) owner.locals.push(m[1]);
  }

  const allNames = new Set();
  for (const f of funcs) {
    if (f.name) allNames.add(f.name);
    for (const v of f.locals) allNames.add(v);
  }

  const lineOf = (pos) => src.slice(0, pos).split('\n').length;
  const chainNames = (f) => {
    const s = new Set();
    for (let g = f; g; g = g.parent) {
      for (const p of g.params) s.add(p);
      for (const v of g.locals) s.add(v);
      if (g.name) s.add(g.name);
    }
    return s;
  };

  const violations = [];
  const report = (name, pos) => {
    const f = innermost(pos);
    if (!chainNames(f).has(name)) {
      violations.push({
        name,
        line: lineOf(pos),
        scope: f ? (f.name || 'anonymous@' + lineOf(f.start)) : '<top>',
      });
    }
  };

  // 调用式引用 name( —— 排除属性方法（.name(）和声明处（function name(）。
  const callRe = /(?<![.\w$])([A-Za-z_$][\w$]*)\s*\(/g;
  while ((m = callRe.exec(skel))) {
    const name = m[1];
    if (KEYWORDS.has(name)) continue;
    if (/function\s*$/.test(skel.slice(Math.max(0, m.index - 9), m.index))) continue;
    if (allNames.has(name)) report(name, m.index);
  }

  // 裸引用（回调传参、赋值右值等）。排除对象 key（后跟 :）与声明位置。
  // 三元分支里的引用会被 ':' 规则一并跳过 —— 宁漏报不误报。
  const bareRe = /(?<![.\w$'"])([A-Za-z_$][\w$]*)(?![\w$(])/g;
  while ((m = bareRe.exec(skel))) {
    const name = m[1];
    if (KEYWORDS.has(name)) continue;
    const after = m.index + name.length;
    if (/^\s*:/.test(skel.slice(after, after + 3)) && !/\?\s*$/.test(skel.slice(0, after))) continue;
    if (/(?:var|let|const|function)\s+$/.test(skel.slice(Math.max(0, m.index - 11), m.index))) continue;
    if (allNames.has(name)) report(name, m.index);
  }

  return violations;
}

describe('shell-tools scope integrity', function () {
  const root = path.resolve(__dirname, '..');

  it('every function reference resolves up the lexical scope chain', function () {
    const violations = scopeViolations(fs.readFileSync(path.join(root, 'shell-tools.js'), 'utf8'));
    assert.deepStrictEqual(violations, [],
      'shell-tools.js 存在作用域不可达的引用（这正是 2026-10-17 让 UI 设计面板' +
      '整页失效的那类错误，详见各违例的 行号/所在函数）');
  });

  it('the analyser catches the 2026-10-17 checkedValue regression', function () {
    // 事故当时的代码形状：checkedValue 藏在 readValues() 内部，
    // toggleLoginRow() 却从自己的作用域引用它。分析器必须精确报出
    // 这一处 —— 既证明守卫有效，也防止将来"优化"成恒真断言。
    const regressed = [
      '(function () {',
      '  "use strict";',
      '  function outer(node) {',
      '    function readValues() {',
      '      var checkedValue = function (name, fallback) { return name || fallback; };',
      '      return checkedValue("uiLoginMode", "follow-global");',
      '    }',
      '    function toggleLoginRow() {',
      '      node.classList.toggle("is-disabled", checkedValue("uiLoginMode") !== "custom");',
      '    }',
      '    function wire() {',
      '      toggleLoginRow();',
      '      readValues();',
      '    }',
      '    wire();',
      '  }',
      '  outer({ classList: { toggle: function () {} } });',
      '})();',
    ].join('\n');

    const violations = scopeViolations(regressed);
    assert.deepStrictEqual(
      violations.map((v) => v.name + '@' + v.scope),
      ['checkedValue@toggleLoginRow'],
      '分析器没能精确复现 2026-10-17 事故的检出结果 —— 主断言可能已经失效'
    );
  });
});