const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

/**
 * 死 CSS 契约。
 *
 * 这个仓库没有打包步骤，也就没有任何工具会告诉你某条规则已经没有元素匹配了。
 * .status-panel / .status-item / .home-btn 三个类名在 CSS 里留了 35 条规则、
 * 5 KB 原始字节，而仓库里没有任何 HTML 模板或 JS 会产生带这些类的元素——
 * mobile-refactor.css 还被 9 个页面加载，等于每页都白下载一遍。
 *
 * 这组测试不只是钉住「已经删了」，而是钉住判断依据本身：
 * 一旦有人真的加了这些元素，第一条测试会失败并提醒把样式加回来，
 * 而不是让后来者以为删掉是无条件正确的。
 */
describe('dead CSS contract', function () {
  const root = path.resolve(__dirname, '..');
  const REMOVED_CLASSES = ['status-panel', 'status-item', 'home-btn'];

  const htmlPages = fs.readdirSync(root).filter((f) => f.endsWith('.html'));
  const scripts = fs.readdirSync(root).filter((f) => f.endsWith('.js'));
  const sheets = fs.readdirSync(root).filter((f) => f.endsWith('.css'));
  const read = (f) => fs.readFileSync(path.join(root, f), 'utf8');

  describe('the classes really are unproducible', function () {
    for (const cls of REMOVED_CLASSES) {
      it(`no HTML or JS ever emits .${cls}`, function () {
        // 静态 class 属性、Vue 的 :class 绑定、以及 JS 侧的 classList / 字符串拼接。
        const patterns = [
          new RegExp(`class\\s*=\\s*["'][^"']*\\b${cls}\\b`),
          new RegExp(`:class\\s*=\\s*["'][^"']*\\b${cls}\\b`),
          new RegExp(`classList\\.[a-z]+\\(\\s*["'\`][^"'\`]*\\b${cls}\\b`),
          new RegExp(`className\\s*[+]?=\\s*["'\`][^"'\`]*\\b${cls}\\b`),
          new RegExp(`["'\`][^"'\`]*\\b${cls}\\b[^"'\`]*["'\`]\\s*\\)`),
        ];
        const offenders = [...htmlPages, ...scripts].filter((f) => {
          const src = read(f);
          return patterns.some((re) => re.test(src));
        });
        assert.deepStrictEqual(
          offenders,
          [],
          `${offenders.join(', ')} 现在会产生 .${cls} 元素了，` +
            `对应样式已经在 mobile-refactor.css / admin-imgtc.css 里删掉，需要补回来`
        );
      });
    }
  });

  describe('the dead rules stay gone', function () {
    for (const cls of REMOVED_CLASSES) {
      it(`no stylesheet styles .${cls}`, function () {
        const offenders = sheets.filter((f) => new RegExp(`\\.${cls}\\b`).test(read(f)));
        assert.deepStrictEqual(offenders, [], `${offenders.join(', ')} 又出现了没有元素匹配的规则`);
      });
    }
  });

  describe('pruning preserved the live selectors it shared rules with', function () {
    // 这三个类大多混在分组选择器里，比如 `.home-btn, .title, .stats { ... }`。
    // 整条删会连带删掉 .title / .stats，而这两个类全站都在用。
    const mobile = read('mobile-refactor.css');

    it('keeps .title and .stats in the flex rule', function () {
      assert.match(mobile, /\.title,\s*\n\.stats\s*\{\s*\n\s*flex: 0 0 auto;/);
    });

    it('keeps .batch-toolbar in the surface rule', function () {
      assert.match(mobile, /\.batch-toolbar\s*\{\s*\n\s*border-radius: var\(--m-radius-lg\)/);
    });

    it('leaves no selector without a rule body', function () {
      // 摘选择器时如果把整段 head 吐回去却没带规则体，就会留下一个裸选择器。
      // 判定依据：这行不以逗号结尾（不是分组续行），而且往后跳过空行也等不到 `{`。
      const lines = mobile.split('\n');
      const orphans = [];
      for (let i = 0; i < lines.length; i++) {
        const line = lines[i].trim();
        if (!/^[.#][\w-][^{};]*$/.test(line) || line.endsWith(',')) continue;
        // 不以逗号结尾 = 这是分组里最后一个选择器，后面只能是 `{`。
        let j = i + 1;
        while (j < lines.length && lines[j].trim() === '') j++;
        const next = j < lines.length ? lines[j].trim() : '';
        if (!next.startsWith('{')) orphans.push(`${i + 1}: ${line}`);
      }
      assert.deepStrictEqual(orphans, [], '出现了没有规则体的裸选择器');
    });
  });

  describe('both sheets remain syntactically intact', function () {
    for (const sheet of ['mobile-refactor.css', 'admin-imgtc.css']) {
      it(`${sheet} has balanced braces and closed comments`, function () {
        const src = read(sheet);

        let depth = 0;
        let minDepth = 0;
        let i = 0;
        let unclosedComment = false;
        while (i < src.length) {
          if (src.startsWith('/*', i)) {
            const end = src.indexOf('*/', i + 2);
            if (end === -1) { unclosedComment = true; break; }
            i = end + 2;
            continue;
          }
          const ch = src[i];
          if (ch === '"' || ch === "'") {
            i++;
            while (i < src.length && src[i] !== ch) { if (src[i] === '\\') i++; i++; }
            i++;
            continue;
          }
          if (ch === '{') depth++;
          else if (ch === '}') { depth--; if (depth < minDepth) minDepth = depth; }
          i++;
        }

        // 未闭合的注释最危险：它会把后面所有 CSS 一起吞掉，而浏览器不会报错。
        assert.strictEqual(unclosedComment, false, '有未闭合的 /* 注释，会吞掉后面所有样式');
        assert.strictEqual(depth, 0, '花括号不配平');
        assert.strictEqual(minDepth, 0, '出现了多余的 }');
        assert.doesNotMatch(src, /\{\s*\}/, '留下了空规则');
        assert.doesNotMatch(src, /,\s*\{/, '留下了悬空的逗号选择器');
      });
    }
  });
});
