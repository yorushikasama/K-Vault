#!/usr/bin/env node
/**
 * 删除已确认无用的 Vue 方法/computed。
 *
 * 判定依据（两条都满足才算死代码）：
 *   1. 静态：整个仓库里，除了它自己的定义，没有任何地方出现它的名字
 *      —— 含模板插值、@click 绑定、this.x() 调用、字符串形式引用
 *   2. 运行时：在真实浏览器里挂计数器，跑一轮交互（点击全部按钮、切视图、
 *      搜索、翻页）后计数仍为 0
 *
 * 删除用 acorn 的语法树区间，不是正则——正则在本仓库踩过两次坑：
 * 一次是把 /}/ 里的花括号当成代码括号，一次是 bash 里 \\b 被转义成字面量
 * 导致词边界失效、161 个方法全被误报成死代码。
 *
 *   node scripts/prune-dead-methods.cjs --check   # 只校验（CI 用，不需要 acorn）
 *   node scripts/prune-dead-methods.cjs           # 执行删除（需要 acorn）
 */
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..');

/**
 * 已确认的死方法。每项都经过静态全仓搜索 + 浏览器交互探针双重确认。
 * 记录在这里而不是每次重算，是为了让删除可复核、可回溯。
 */
const DEAD = {
  'admin.html': [
    { name: 'uploadFiles', note: '上传入口走 openUploader 跳转上传中心，页面里没有 input[type=file] 绑到它' },
    { name: 'showLoginBackgroundSettings', note: '登录页背景设置在 login.html 上，此页无入口' },
    { name: 'beginResourceMutation', note: '与 finishResourceMutation 成对，已无调用方' },
    { name: 'finishResourceMutation', note: '与 beginResourceMutation 成对，已无调用方' },
    { name: 'shouldShowImage', note: '预览门控改用 shouldAutoLoadPreview / isPreviewRevealed' },
    { name: 'viewModeIcon', note: '图标改由模板内联三元给出，这个 computed 无人读' },
  ],
  'admin-imgtc.html': [
    { name: 'uploadFiles', note: '同 admin.html，上传走 openUploader' },
  ],
  'index.html': [
    { name: 'getFileIconClass', note: '图标已改用 kv-icon + getFileIcon，这个返回 CSS 类名的实现无人用' },
    { name: 'getCleanFilePath', note: '与 getCleanFileUrl 重复；保留的那条才有引用' },
    { name: 'formatBytes', note: '体积格式化已统一用 formatSize' },
    { name: 'getStatusText', note: '状态文案由模板内联映射给出' },
    { name: 'imageCompressPanelExpanded', note: '压缩面板展开态改由别的字段驱动' },
    { name: 'previewImage', note: '预览走 openImagePreview；gallery.html 里的同名方法是另一份独立实现，不在此列' },
    { name: 'uploadPendingCompressed', note: '压缩上传入口已移除' },
    { name: 'uploadPendingOriginal', note: '原图上传入口已移除' },
  ],
};

let acorn = null;
try { acorn = require('acorn'); } catch (e) {}

/** 用 acorn 找出 Vue 选项里指定名字的定义区间。 */
function findDefinitions(src, wanted) {
  const scripts = [...src.matchAll(/<script(?![^>]*\bsrc=)[^>]*>([\s\S]*?)<\/script>/g)];
  const out = [];
  for (const m of scripts) {
    const code = m[1];
    const base = m.index + m[0].indexOf('>') + 1;
    let ast;
    try { ast = acorn.parse(code, { ecmaVersion: 2022, sourceType: 'script' }); } catch (e) { continue; }
    let options = null;
    (function walk(n) {
      if (!n || typeof n !== 'object') return;
      if (Array.isArray(n)) { n.forEach(walk); return; }
      if (n.type === 'NewExpression' && n.callee && n.callee.name === 'Vue' &&
          n.arguments[0] && n.arguments[0].type === 'ObjectExpression') options = n.arguments[0];
      for (const k of Object.keys(n)) { if (k === 'loc' || k === 'range') continue; walk(n[k]); }
    })(ast);
    if (!options) continue;
    for (const prop of options.properties) {
      if (prop.type !== 'Property' || !prop.key) continue;
      const sec = prop.key.name || prop.key.value;
      if (!['methods', 'computed'].includes(sec)) continue;
      let obj = prop.value;
      if (obj && obj.type === 'CallExpression' && obj.arguments.length) obj = obj.arguments[obj.arguments.length - 1];
      if (!obj || obj.type !== 'ObjectExpression') continue;
      for (const inner of obj.properties) {
        if (inner.type !== 'Property' || !inner.key) continue;
        const n = inner.key.name || inner.key.value;
        if (!wanted.includes(n)) continue;
        out.push({ name: n, section: sec, start: base + inner.start, end: base + inner.end });
      }
    }
  }
  return out;
}

const check = process.argv.includes('--check');
let problems = 0;

for (const [page, entries] of Object.entries(DEAD)) {
  const file = path.join(ROOT, page);
  const src = fs.readFileSync(file, 'utf8');
  const names = entries.map((e) => e.name);

  if (check) {
    // 校验模式：确认这些方法确实已经不在了（不依赖 acorn）
    const still = names.filter((n) => new RegExp(`^[ \\t]+(?:async\\s+)?${n}\\s*\\([^)]*\\)\\s*\\{`, 'm').test(src));
    for (const n of still) { console.error(`${page}: ${n} 仍然存在（应为已删除）`); problems++; }
    if (!still.length) console.log(`${page}: 死方法已清理`);
    continue;
  }

  if (!acorn) {
    console.error('删除模式需要解析器：npm install --no-save acorn');
    process.exit(2);
  }

  const defs = findDefinitions(src, names);
  const found = new Set(defs.map((d) => d.name));
  for (const n of names) {
    if (!found.has(n)) console.log(`  ${page}.${n}: 已不存在，跳过`);
  }
  if (!defs.length) continue;

  // 从后往前删，顺便吃掉尾随逗号和换行
  defs.sort((a, b) => b.start - a.start);
  let out = src;
  for (const d of defs) {
    let end = d.end;
    while (end < out.length && (out[end] === ',' || out[end] === ' ' || out[end] === '\t')) end++;
    if (out[end] === '\n') end++;
    // 连带删掉紧贴其上的整行注释，避免留下孤儿注释
    let start = d.start;
    for (;;) {
      const lineStart = out.lastIndexOf('\n', start - 1) + 1;
      if (lineStart >= start) break;
      const line = out.slice(lineStart, start).trim();
      if (line.startsWith('//') || line.endsWith('*/') || line.startsWith('*') || line.startsWith('/*')) start = lineStart;
      else break;
    }
    out = out.slice(0, start) + out.slice(end);
  }
  fs.writeFileSync(file, out);
  console.log(`${page}: 删除 ${defs.length} 个（${defs.map((d) => d.name).join(', ')}），${src.length} -> ${out.length} 字节`);

  // 语法校验
  const js = [...out.matchAll(/<script(?![^>]*\bsrc=)[^>]*>([\s\S]*?)<\/script>/g)].map((m) => m[1]).join('\n');
  try {
    new Function(js);
    console.log(`  语法 OK`);
  } catch (e) {
    console.error(`  !! 语法错误: ${e.message}`);
    process.exit(3);
  }
}

if (check) {
  if (problems) { console.error('\n请运行 node scripts/prune-dead-methods.cjs'); process.exit(1); }
  process.exit(0);
}
console.log('\n完成。记得跑 npm run assets:stamp。');
