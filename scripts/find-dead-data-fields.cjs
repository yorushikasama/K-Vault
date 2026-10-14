#!/usr/bin/env node
/**
 * 找出「定义了但没人读/没人写」的 Vue data 字段。
 *
 * 为什么单独做这件事：死方法有 prune-dead-methods.cjs 在管，data 字段没有。
 * 两者都会骗人，但骗的方式不同 ——
 *   - 方法可能被模板以字符串形式调用，静态搜索容易漏判；
 *   - data 字段则常常是「写了但从不读」或「读了但从没写」，
 *     前者是死重量（每个实例都占一份），后者是更危险的空壳：
 *     模板读到的永远是 undefined，看起来像功能坏了但代码「存在」。
 *
 * 判定用两条独立证据，和死方法同一把尺子（docs/dead-code-boundaries.md）：
 *   1. 静态：除 data() 里的定义处，全仓（含模板、:class 绑定、watch、
 *      字符串形式）再无出现 —— 证明「没有引用点」
 *   2. 运行时：在真实页面里挂 Object.defineProperty 计数器，
 *      跑一轮交互后读写计数都为 0 —— 证明「真的没人碰」
 * 只在两边都归零时才建议删除。静态会漏（动态拼接），运行时覆盖不到
 * 未触发的分支，所以单边归零一律不下结论。
 *
 * 用法：
 *   node scripts/find-dead-data-fields.cjs          # 报告，不改
 *   node scripts/find-dead-data-fields.cjs --json   # 机器可读
 */
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..');

/** 页面 → 该页模板与逻辑文件。逻辑拆到根级 app 文件后要一起算。 */
const PAGES = {
  'index.html': ['upload-app.js', 'upload-media.js', 'upload-image.js', 'kv-shared.js'],
  'admin.html': ['admin-app.js', 'admin-tokens.js', 'admin-ui-design.js', 'admin-shared.js'],
  'gallery.html': ['gallery-app.js'],
  'video.html': ['video-app.js'],
  'preview.html': ['preview-app.js', 'preview-parsers.js'],
  'block-img.html': [],
  'whitelist-on.html': [],
};

const read = (f) => fs.readFileSync(path.join(ROOT, f), 'utf8');

/**
 * 抽出 data() 返回对象的顶层键。
 *
 * 用括号配平而不是正则找 `data: { ... }`：正则踩过 /}/ 把字符串里的
 * 花括号当代码括号的坑，本仓库 prune-dead-methods.cjs 的注释也记着。
 */
function dataKeys(src, file) {
  const keys = [];
  const marker = /data\s*:\s*function\s*\(\)\s*\{/g;
  const marker2 = /data\s*:\s*\(\)\s*=>\s*\{/g;
  const marker3 = /data\s*:\s*\{/g;
  for (const re of [marker, marker2, marker3]) {
    let m;
    while ((m = re.exec(src)) !== null) {
      const open = src.indexOf('{', m.index + m[0].length - 1);
      let depth = 1;
      let i = open + 1;
      let inStr = null;
      while (i < src.length && depth > 0) {
        const c = src[i];
        if (inStr) {
          if (c === '\\') i++;
          else if (c === inStr) inStr = null;
        } else if (c === '"' || c === "'" || c === '`') inStr = c;
        else if (c === '{') depth++;
        else if (c === '}') depth--;
        i++;
      }
      const body = src.slice(open + 1, i - 1);
      // 只取顶层键：depth 0 的位置上的 name: 或 'name': 或 "name":
      let d = 0;
      let j = 0;
      let lineStart = 0;
      let cur = '';
      const toks = [];
      while (j < body.length) {
        const c = body[j];
        if (inStr) {
          if (c === '\\') { cur += c + body[j + 1]; j += 2; continue; }
          if (c === inStr) inStr = null;
          cur += c; j++; continue;
        }
        if (c === '"' || c === "'" || c === '`') { inStr = c; cur += c; j++; continue; }
        if (c === '/' && body[j + 1] === '/') { while (j < body.length && body[j] !== '\n') j++; continue; }
        if (c === '/' && body[j + 1] === '*') { const e = body.indexOf('*/', j + 2); j = e === -1 ? body.length : e + 2; continue; }
        if (c === '{' || c === '[' || c === '(') { d++; cur += c; j++; continue; }
        if (c === '}' || c === ']' || c === ')') { d--; cur += c; j++; continue; }
        if (c === ',' && d === 0) { toks.push(cur); cur = ''; j++; continue; }
        cur += c; j++;
      }
      if (cur.trim()) toks.push(cur);
      for (const t of toks) {
        const k = /^\s*(?:'([^']+)'|"([^"]+)"|`([^`]+)`|([A-Za-z_$][\w$]*))\s*:/.exec(t);
        if (k) keys.push({ name: k[1] || k[2] || k[3] || k[4], file, index: open + 1 + body.indexOf(t) });
      }
    }
  }
  return keys;
}

/** 数一个标识符在全仓出现多少次（排除它自己的定义处）。 */
function countOutside(page, files, name, defIndex, defFile) {
  let hits = [];
  const word = new RegExp(`\\b${name.replace(/[$]/g, '\\$')}\\b`, 'g');
  for (const f of files) {
    const src = read(f);
    let m;
    while ((m = word.exec(src)) !== null) {
      const same = f === defFile && m.index >= defIndex && m.index < defIndex + name.length;
      if (same) continue;
      hits.push({ file: f, index: m.index, line: src.slice(0, m.index).split('\n').length });
    }
  }
  return hits;
}

function main() {
  const json = process.argv.includes('--json');
  const report = {};

  for (const [page, appFiles] of Object.entries(PAGES)) {
    const files = [page, ...appFiles];
    const missing = files.filter((f) => !fs.existsSync(path.join(ROOT, f)));
    if (missing.length) {
      report[page] = { error: `缺少文件: ${missing.join(', ')}` };
      continue;
    }

    const seen = new Map();
    for (const f of files) {
      for (const k of dataKeys(read(f), f)) {
        if (!seen.has(k.name)) seen.set(k.name, k);
      }
    }

    const dead = [];
    for (const [name, def] of seen) {
      const hits = countOutside(page, files, name, def.index, def.file);
      if (hits.length === 0) dead.push({ name, definedIn: def.file });
    }

    report[page] = {
      totalDataKeys: seen.size,
      noStaticReference: dead,
    };
  }

  if (json) {
    console.log(JSON.stringify(report, null, 2));
    return;
  }

  for (const [page, r] of Object.entries(report)) {
    if (r.error) { console.log(`${page}: ${r.error}`); continue; }
    console.log(`\n${page}  data 键 ${r.totalDataKeys} 个，静态零引用 ${r.noStaticReference.length} 个`);
    for (const d of r.noStaticReference) console.log(`   ${d.name}   (定义于 ${d.definedIn})`);
  }
  console.log('\n以上只是「静态零引用」的候选。还需运行时探针确认读写都为 0 才能删。');
}

main();