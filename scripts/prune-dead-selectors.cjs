#!/usr/bin/env node
/**
 * 摘掉指定的死选择器。
 *
 * 为什么要脚本而不是手改：这些选择器大多只是分组里的一员，比如
 *   .home-btn, .title, .stats { flex: 0 0 auto; }
 * 里 .title / .stats 都是活的。整条删会连带删掉活规则，手改 35 处又容易漏。
 * 脚本只摘选择器，整条全死才删，并且 --check 能在 CI 里守住不回流。
 *
 * 死因（2026-10 核实）：.status-panel / .status-item / .home-btn 这三个类名
 * 只出现在 CSS 里，仓库内没有任何 HTML 模板或 JS 会产生带这些类的元素。
 *
 *   node scripts/prune-dead-selectors.cjs           # 就地清理
 *   node scripts/prune-dead-selectors.cjs --check   # 只检查，CI 用
 */
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..');

// 这些类名在仓库里没有任何元素会带上。改动前请先全仓搜索确认仍然成立。
const DEAD_CLASSES = ['status-panel', 'status-item', 'home-btn'];
const TARGETS = ['mobile-refactor.css', 'admin-imgtc.css'];

const deadRe = new RegExp(`\\.(?:${DEAD_CLASSES.join('|')})\\b`);

/** 把一段 CSS 切成顶层块，保留块之间的原始文本。 */
function parseBlocks(text) {
  const out = [];
  let i = 0;
  while (i < text.length) {
    const open = text.indexOf('{', i);
    if (open === -1) {
      out.push({ type: 'text', raw: text.slice(i) });
      break;
    }
    let depth = 1;
    let j = open + 1;
    while (j < text.length && depth > 0) {
      if (text[j] === '{') depth++;
      else if (text[j] === '}') depth--;
      j++;
    }
    out.push({ type: 'rule', head: text.slice(i, open), body: text.slice(open + 1, j - 1), raw: text.slice(i, j) });
    i = j;
  }
  return out;
}

/** 选择器列表里摘掉死的那几个；返回 null 表示整条该删。 */
/**
 * 把 head 切成「前导内容」和「选择器」两段。
 * 前导是上一条规则的 `}` 或一段注释，必须整段保留——注意 `*/` 占两个字符，
 * 少算一位就会留下未闭合的 `/* ... *`，而未闭合注释会吞掉它后面所有 CSS。
 */
function splitHead(head) {
  const brace = head.lastIndexOf('}');
  const comment = head.lastIndexOf('*/');
  const cut = Math.max(brace === -1 ? -1 : brace + 1, comment === -1 ? -1 : comment + 2);
  return cut <= 0 ? { lead: '', selectorText: head } : { lead: head.slice(0, cut), selectorText: head.slice(cut) };
}

/**
 * 整条规则被删时，决定它的 head 还该留下什么。
 * 紧贴着规则的那段注释是这条规则的标题，规则没了就是孤儿注释，一起删；
 * 但上一条规则的 `}` 必须留着。
 */
function dropHead(head) {
  // head 里既有前导内容，也有这条规则自己的选择器。选择器必须整段丢掉，
  // 否则会留下一个没有规则体的裸选择器，那同样是语法破损。
  const { lead } = splitHead(head);

  // 紧贴规则的那段注释是它的标题，规则没了就是孤儿，连带删掉；
  // 但更前面的 `}` 和其它内容要原样保留。
  const brace = lead.lastIndexOf('}');
  const tail = brace === -1 ? lead : lead.slice(brace + 1);
  if (/^\s*(?:\/\*[\s\S]*?\*\/\s*)+$/.test(tail)) {
    return brace === -1 ? '' : lead.slice(0, brace + 1);
  }
  return lead;
}

function pruneSelectorList(head) {
  const { lead, selectorText } = splitHead(head);

  const selectors = selectorText.split(',');
  const kept = selectors.filter((s) => !deadRe.test(s));
  if (kept.length === selectors.length) return head;
  if (kept.length === 0) return null;

  // `{` 前的空白原本挂在最后一个选择器尾部。如果那个选择器正好是被摘掉的，
  // 直接 join 会得到 `.batch-toolbar{`，所以要把尾部空白补回来。
  const trailing = selectorText.match(/\s*$/)[0];
  return lead + kept.join(',').replace(/\s*$/, '') + (trailing || ' ');
}

function prune(text) {
  let changed = false;
  const blocks = parseBlocks(text);
  let out = '';
  for (const block of blocks) {
    if (block.type === 'text') {
      out += block.raw;
      continue;
    }
    const isAtRule = /@(?:media|supports|container|layer)\b/.test(block.head.split('}').pop());
    if (isAtRule) {
      const inner = prune(block.body);
      if (inner.text !== block.body) changed = true;
      // 整个 @media 被清空了就连 at-rule 一起删掉。
      if (inner.text.trim() === '') {
        changed = true;
        out += dropHead(block.head);
        continue;
      }
      out += block.head + '{' + inner.text + '}';
      continue;
    }
    const head = pruneSelectorList(block.head);
    if (head === null) {
      changed = true;
      out += dropHead(block.head);
      continue;
    }
    if (head !== block.head) changed = true;
    out += head + '{' + block.body + '}';
  }
  return { text: out, changed };
}

function tidy(text) {
  // 删规则会留下三连以上的空行，收敛成两个。
  return text.replace(/\n[ \t]*\n[ \t]*\n+/g, '\n\n');
}

function main() {
  const check = process.argv.includes('--check');
  let dirty = false;
  let savedTotal = 0;

  for (const file of TARGETS) {
    const abs = path.join(ROOT, file);
    const before = fs.readFileSync(abs, 'utf8');
    const result = prune(before);
    const after = tidy(result.text);
    if (after === before) {
      console.log(`${file}: 已经干净`);
      continue;
    }
    const saved = before.length - after.length;
    savedTotal += saved;
    dirty = true;
    if (check) {
      console.error(`${file}: 还有死选择器，可省 ${saved} 字节`);
    } else {
      fs.writeFileSync(abs, after);
      console.log(`${file}: ${before.length} -> ${after.length} 字节（省 ${saved}）`);
    }
  }

  if (check && dirty) {
    console.error('\n请运行 node scripts/prune-dead-selectors.cjs');
    process.exit(1);
  }
  if (!check && savedTotal) {
    console.log(`\n合计省 ${savedTotal} 字节。记得重新跑 npm run assets:stamp。`);
  }
}

main();
