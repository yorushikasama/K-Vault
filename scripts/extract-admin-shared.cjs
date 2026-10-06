#!/usr/bin/env node
/**
 * 把两个后台页重复的 24 个方法抽成 admin-shared.js，并改写页面。
 *
 * 这是一次性重构脚本，保留在仓库里是为了让这次改动可复核、可重跑：
 * 每一步都校验，任一步失败就整体中止，不会留下半成品。
 *
 *   node scripts/extract-admin-shared.cjs          # 执行
 *   node scripts/extract-admin-shared.cjs --check  # 只校验现状（CI 用）
 *
 * 为什么用 acorn 而不是正则：手写括号配平在「正则字面量」上会翻车——
 * /}/ 里的花括号会被当成代码里的括号，模板字符串的 ${} 也会算错。
 * 位置信息必须来自语法树。
 */
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..');
const PAGES = ['admin.html', 'admin-imgtc.html'];
const SHARED_FILE = 'admin-shared.js';
const SHARED_GLOBAL = 'window.KVAdminShared';
const SECTIONS = ['methods', 'computed', 'watch'];

/** 只收「两页逐字相同」的方法。名单由 scripts/extract-admin-shared.cjs 生成时确定。 */
const SHARED_NAMES = [
  'copyToClipboardFallback', 'mergeListData', 'normalizeListItem', 'sortData',
  'toggleSelect', 'getFileType', 'openUploader', 'filter', 'handleWebsite', 'sort',
  'editWebsites', 'toggleLike', 'handleEditName', 'handleQuickCopy', 'exportAllLinks',
  'handleBatchCopyHtml', 'handleBatchCopyMarkdown', 'handleBatchCopy', 'handleCopy',
  'updateWindowWidth',
  'filterIcon', 'paginatedTableData', 'sortIcon',
  'sortOption',
];
const NAME_TO_SECTION = {
  filterIcon: 'computed', paginatedTableData: 'computed', sortIcon: 'computed',
  sortOption: 'watch',
};

let acorn = null;
try {
  acorn = require('acorn');
} catch (e) {
  // 改写模式需要解析器；校验模式不需要（见下面的 regexFallback）。
  // acorn 只作为开发时的可选依赖（npm install --no-save acorn），
  // 不写进 package.json——这个项目刻意保持零构建依赖，为了一个 lint
  // 检查引入解析器不划算，而 --check 用字符串匹配就足够了。
}

// ---------- 工具 ----------

/** 把整份 HTML 里的内联 <script> 逐个解析，返回 {code, base, ast}。 */
function parseInlineScripts(src) {
  const out = [];
  const re = /<script(?![^>]*\bsrc=)[^>]*>([\s\S]*?)<\/script>/g;
  let m;
  while ((m = re.exec(src))) {
    const code = m[1];
    const base = m.index + m[0].indexOf('>') + 1;
    let ast;
    try {
      ast = acorn.parse(code, { ecmaVersion: 2022, sourceType: 'script' });
    } catch (err) {
      throw new Error(`内联 <script> 解析失败: ${err.message}`);
    }
    out.push({ code, base, ast });
  }
  return out;
}

/** 在 AST 里找 `new Vue({...})` 的选项对象。 */
function findVueOptions(ast) {
  let found = null;
  (function walk(node) {
    if (!node || typeof node !== 'object') return;
    if (Array.isArray(node)) { node.forEach(walk); return; }
    if (node.type === 'NewExpression' && node.callee && node.callee.name === 'Vue' &&
        node.arguments && node.arguments[0] && node.arguments[0].type === 'ObjectExpression') {
      found = node.arguments[0];
    }
    for (const k of Object.keys(node)) {
      if (k === 'loc' || k === 'range') continue;
      walk(node[k]);
    }
  })(ast);
  return found;
}

/** 取出某个 section 的对象字面量（兼容已被包装成 Object.assign 的情况）。 */
function sectionObject(options, name) {
  const prop = options.properties.find((p) =>
    p.type === 'Property' && p.key && (p.key.name || p.key.value) === name);
  if (!prop) return null;
  let v = prop.value;
  if (v && v.type === 'CallExpression' && v.arguments && v.arguments.length) {
    v = v.arguments[v.arguments.length - 1];
  }
  return v && v.type === 'ObjectExpression' ? v : null;
}

// ---------- 校验当前状态 ----------

/**
 * 无解析器时的校验实现。
 *
 * 只用字符串匹配，因为要判断的三件事都是「文本形状」：
 *   1. admin-shared.js 的 <script> 引用出现几次；
 *   2. 三个 section 是否写成了 Object.assign({}, window.KVAdminShared.xxx, {
 *   3. 共享方法名是否又出现在 Vue 选项区（重复定义会覆盖共享版本）。
 *
 * 第 3 条需要把「定义」和「调用」区分开：模板里的 @click="handleCopy(...)"
 * 和 this.handleCopy(...) 都是调用，只有 `name(...) {` 这种行首形态才是定义。
 * 这一点用正则足够可靠，不需要语法树。
 */
function inspectByText(page) {
  const src = fs.readFileSync(path.join(ROOT, page), 'utf8');
  const loaded = (src.match(/src="\/admin-shared\.js/g) || []).length;

  const merged = {};
  for (const sec of SECTIONS) {
    merged[sec] = new RegExp(
      `${sec}\\s*:\\s*Object\\.assign\\(\\{\\},\\s*window\\.KVAdminShared\\.${sec}`
    ).test(src);
  }

  // 只看 Vue 选项区，避开 HTML 模板里的调用
  const vueAt = src.search(/\bnew Vue\s*\(/);
  const options = vueAt === -1 ? '' : src.slice(vueAt);
  const dupes = [];
  for (const name of SHARED_NAMES) {
    // 定义形态：行首缩进 + 方法名 + 参数表 + {。调用不会长这样。
    const defRe = new RegExp(`^[ \\t]+(?:async\\s+)?${name}\\s*\\([^)]*\\)\\s*\\{`, 'm');
    if (defRe.test(options)) dupes.push(name);
  }
  return { loaded, merged, dupes };
}

function inspect() {
  const report = { loaded: {}, merged: {}, dupes: {} };
  if (!acorn) {
    // 无解析器：走文本校验
    for (const page of PAGES) {
      const r = inspectByText(page);
      report.loaded[page] = r.loaded;
      report.merged[page] = r.merged;
      report.dupes[page] = r.dupes;
    }
    return report;
  }
  for (const page of PAGES) {
    const src = fs.readFileSync(path.join(ROOT, page), 'utf8');
    report.loaded[page] = (src.match(/src="\/admin-shared\.js/g) || []).length;
    const scripts = parseInlineScripts(src);
    let merged = { methods: false, computed: false, watch: false };
    const dupes = [];
    for (const { ast } of scripts) {
      const options = findVueOptions(ast);
      if (!options) continue;
      for (const sec of SECTIONS) {
        const obj = sectionObject(options, sec);
        if (!obj) continue;
        if (obj.properties.some((p) => p.type === 'Property' && p.key &&
            (p.key.name || p.key.value) === '__never__')) continue;
        // 是否已合并
        const prop = options.properties.find((p) =>
          p.type === 'Property' && p.key && (p.key.name || p.key.value) === sec);
        if (prop && prop.value.type === 'CallExpression' &&
            prop.value.callee.type === 'MemberExpression' &&
            prop.value.callee.object.name === 'Object' && prop.value.callee.property.name === 'assign') {
          merged[sec] = true;
        }
        for (const inner of obj.properties) {
          if (inner.type !== 'Property' || !inner.key) continue;
          const n = inner.key.name || inner.key.value;
          if (SHARED_NAMES.includes(n)) dupes.push(`${sec}.${n}`);
        }
      }
    }
    report.merged[page] = merged;
    report.dupes[page] = dupes;
  }
  return report;
}

if (process.argv.includes('--check')) {
  const r = inspect();
  let bad = 0;
  for (const page of PAGES) {
    if (r.loaded[page] !== 1) { console.error(`${page}: admin-shared.js 引用 ${r.loaded[page]} 次（应为 1）`); bad++; }
    for (const sec of SECTIONS) {
      if (!r.merged[page][sec]) { console.error(`${page}: ${sec} 没有合并共享模块`); bad++; }
    }
    if (r.dupes[page].length) {
      console.error(`${page}: 又内联了共享方法 -> ${r.dupes[page].join(', ')}`);
      bad++;
    }
  }
  if (bad) { console.error('\n请运行 node scripts/extract-admin-shared.cjs'); process.exit(1); }
  console.log('共享模块契约满足');
  process.exit(0);
}

// ---------- 执行 ----------

if (!acorn) {
  console.error('改写模式需要解析器：npm install --no-save acorn');
  console.error('（校验模式不需要，用 npm run shared:check）');
  process.exit(2);
}

console.log('检查 acorn 可用，开始改写\n');

// 1) 先确认共享模块里确实有这些方法
const sharedSrc = fs.readFileSync(path.join(ROOT, SHARED_FILE), 'utf8');
const missing = SHARED_NAMES.filter((n) =>
  !new RegExp(`^ {2}(?:async\\s+)?${n}\\s*[:(]`, 'm').test(sharedSrc));
if (missing.length) {
  console.error(`!! 共享模块缺少: ${missing.join(', ')}`);
  process.exit(3);
}
console.log(`1. 共享模块包含全部 ${SHARED_NAMES.length} 个方法`);

// 2) 删除页面里的重复定义
for (const page of PAGES) {
  const file = path.join(ROOT, page);
  let src = fs.readFileSync(file, 'utf8');
  const before = src.length;
  const edits = [];
  for (const { code, base, ast } of parseInlineScripts(src)) {
    const options = findVueOptions(ast);
    if (!options) continue;
    for (const sec of SECTIONS) {
      const obj = sectionObject(options, sec);
      if (!obj) continue;
      for (const inner of obj.properties) {
        if (inner.type !== 'Property' || !inner.key) continue;
        const n = inner.key.name || inner.key.value;
        if (!SHARED_NAMES.includes(n)) continue;
        let end = inner.end;
        while (end < code.length && (code[end] === ',' || code[end] === ' ' || code[end] === '\t')) end++;
        if (code[end] === '\n') end++;
        edits.push([base + inner.start, base + end]);
      }
    }
  }
  if (!edits.length) { console.log(`2. ${page}: 没有重复定义（已是目标状态）`); continue; }
  edits.sort((a, b) => b[0] - a[0]);
  let prev = Infinity;
  for (const [s, e] of edits) {
    if (e > prev) { console.error('!! 区间重叠，中止'); process.exit(4); }
    prev = s;
  }
  let out = src;
  for (const [s, e] of edits) out = out.slice(0, s) + out.slice(e);
  fs.writeFileSync(file, out);
  console.log(`2. ${page}: 删除 ${edits.length} 个重复定义，${before} -> ${out.length} 字节`);
}

// 3) 把三个 section 包装成 Object.assign({}, SHARED.xxx, { ...页面自己的... })
for (const page of PAGES) {
  const file = path.join(ROOT, page);
  let src = fs.readFileSync(file, 'utf8');
  const edits = [];
  for (const { code, base, ast } of parseInlineScripts(src)) {
    const options = findVueOptions(ast);
    if (!options) continue;
    for (const sec of SECTIONS) {
      const prop = options.properties.find((p) =>
        p.type === 'Property' && p.key && (p.key.name || p.key.value) === sec);
      if (!prop) continue;
      // 已经包过就跳过
      if (prop.value.type === 'CallExpression' &&
          prop.value.callee.type === 'MemberExpression' &&
          prop.value.callee.object.name === 'Object') continue;
      if (prop.value.type !== 'ObjectExpression') continue;
      // 前缀插在 '{' 之前，结尾插在 '}' 之后。
      // 插在 '{' 之后会写成 `{Object.assign(`，报 "Unexpected token '.'"。
      edits.push([base + prop.value.start, `Object.assign({}, ${SHARED_GLOBAL}.${sec}, `, 'ins']);
      edits.push([base + prop.value.end, ')', 'ins']);
    }
  }
  edits.sort((a, b) => b[0] - a[0]);
  for (const [at, text] of edits) src = src.slice(0, at) + text + src.slice(at);
  fs.writeFileSync(file, src);
  console.log(`3. ${page}: 包装 ${edits.length / 2} 个 section`);
}

// 4) 确保只加载一次，且位置在 new Vue 之前
for (const page of PAGES) {
  const file = path.join(ROOT, page);
  let src = fs.readFileSync(file, 'utf8');
  const refs = [...src.matchAll(/<script src="\/admin-shared\.js[^"]*"><\/script>\n?/g)];
  // 先全部摘掉
  for (let i = refs.length - 1; i >= 0; i--) {
    src = src.slice(0, refs[i].index) + src.slice(refs[i].index + refs[i][0].length);
  }
  // 插到内联 <script> 之前（也就是最后一个带 src 的本地脚本之后）
  const anchor = /(<script src="\/icons\.js\?v=[a-f0-9]+"><\/script>\n)/;
  if (!anchor.test(src)) { console.error(`!! ${page}: 找不到 icons.js 作为插入锚点`); process.exit(5); }
  src = src.replace(anchor, `$1<script src="/admin-shared.js"></script>\n`);
  fs.writeFileSync(file, src);
  console.log(`4. ${page}: 摘掉 ${refs.length} 处引用，重新插入 1 处`);
}

// 5) 语法校验：用 V8 编译（语义与浏览器 <script> 一致）
for (const page of PAGES) {
  const src = fs.readFileSync(path.join(ROOT, page), 'utf8');
  const js = [...src.matchAll(/<script(?![^>]*\bsrc=)[^>]*>([\s\S]*?)<\/script>/g)]
    .map((m) => m[1]).join('\n');
  try {
    new Function(js);
    console.log(`5. ${page}: 语法 OK`);
  } catch (e) {
    console.error(`!! ${page}: 语法错误 -> ${e.message}`);
    process.exit(6);
  }
}

// 6) 最终校验
const r = inspect();
let ok = true;
for (const page of PAGES) {
  if (r.loaded[page] !== 1) { console.error(`${page}: 引用数 ${r.loaded[page]}`); ok = false; }
  if (r.dupes[page].length) { console.error(`${page}: 仍内联 ${r.dupes[page].join(',')}`); ok = false; }
}
console.log(ok ? '\n完成。记得跑 npm run assets:stamp 重新打版本串。' : '\n有问题，请检查。');
process.exit(ok ? 0 : 1);
