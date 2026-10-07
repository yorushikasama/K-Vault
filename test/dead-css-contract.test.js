const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

/**
 * 死 CSS 契约。
 *
 * 这个仓库没有打包步骤，也就没有任何工具会告诉你某条规则已经没有元素匹配了。
 * 第一批 .status-panel / .status-item / .home-btn 在 CSS 里留了 35 条规则、
 * 5 KB 原始字节，而仓库里没有任何 HTML 模板或 JS 会产生带这些类的元素——
 * mobile-refactor.css 还被 9 个页面加载，等于每页都白下载一遍。
 *
 * 第二批是 3257348 把 index.html 换成 workbench 外壳后遗留的：存储目标从
 * .storage-btn 变成 .upload-storage-option、上传方式从 .method-btn 变成
 * .upload-btn，历史记录与标题不再带类名。那次迁移共留下 107 条无元素匹配的
 * 规则（index.css 一个文件就占 83 条、12 KB）。核对过迁移提交：这批类名在
 * 3257348 里全是「只删不加」，即确实存在过、被显式替换掉了。
 *
 * 这组测试不只是钉住「已经删了」，而是钉住判断依据本身：
 * 一旦有人真的加了这些元素，第一条测试会失败并提醒把样式加回来，
 * 而不是让后来者以为删掉是无条件正确的。
 */
describe('dead CSS contract', function () {
  const root = path.resolve(__dirname, '..');

  /**
   * 第一组是无引用类；第二组是 3257348 把 index.html 换成 workbench 外壳后
   * 被整体替换掉的老类。两者都要求「HTML/JS 造不出带这些类的元素」，
   * 一旦有人真的加了元素，测试会失败并提醒把样式加回来。
   */
  const REMOVED_CLASSES = [
    'status-panel',
    'status-item',
    'home-btn',
    // 3257348 遗留（已核对：那次迁移里只删不加）
    'storage-btn',
    'method-btn',
    'upload-zone',
    'upload-methods',
    'storage-switcher',
    'history-item',
    'history-file-icon',
    'card-title',
    'header-theme-toggle',
    'theme-toggle-btn',
    'compress-mode-btn',
    'preview-stage',
  ];

  /**
   * 这些类同样搜不到 HTML 引用，但必须保留：
   * theme-core.js:120 有 `document.querySelector(".header .nav-links")`，
   * 一旦补上匹配标记就会真的把主题按钮插进去，删样式等于埋雷。
   */
  const KEEP_FOR_JS_QUERY = ['nav-links'];

  const htmlPages = fs.readdirSync(root).filter((f) => f.endsWith('.html'));
  const scripts = fs.readdirSync(root).filter((f) => f.endsWith('.js'));
  const sheets = fs.readdirSync(root).filter((f) => f.endsWith('.css'));
  const read = (f) => fs.readFileSync(path.join(root, f), 'utf8');

  describe('the classes really are unproducible', function () {
    for (const cls of REMOVED_CLASSES) {
      it(`no HTML or JS ever emits .${cls}`, function () {
        // 静态 class 属性、Vue 的 :class 绑定、以及 JS 侧的 classList / 字符串拼接。
        // 边界用 (?![-\w])：\b 会让 .history-item 顺带匹配 .history-item-overlay，
        // 而后者是活类，不能拿它当「有人重新引入了 history-item」的证据。
        const patterns = [
          new RegExp(`class\\s*=\\s*["'][^"']*(?<![-\\w])${cls}(?![-\\w])`),
          new RegExp(`:class\\s*=\\s*["'][^"']*(?<![-\\w])${cls}(?![-\\w])`),
          new RegExp(`classList\\.[a-z]+\\(\\s*["'\`][^"'\`]*(?<![-\\w])${cls}(?![-\\w])`),
          new RegExp(`className\\s*[+]?=\\s*["'\`][^"'\`]*(?<![-\\w])${cls}(?![-\\w])`),
          new RegExp(`["'\`][^"'\`]*(?<![-\\w])${cls}(?![-\\w])[^"'\`]*["'\`]\\s*\\)`),
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
        const offenders = sheets.filter((f) =>
          new RegExp(`\\.${cls}(?![-\\w])`).test(read(f))
        );
        assert.deepStrictEqual(offenders, [], `${offenders.join(', ')} 又出现了没有元素匹配的规则`);
      });
    }
  });

  describe('classes the pruner must NOT touch', function () {
    // 这条是真实踩过的坑：死类表里原本用 \b 收尾，而 \b 把连字符也当成词边界，
    // 于是 \.history-item\b 会匹配 .history-item-overlay——另一个还活着的类。
    // 它带着自己的 opacity/overflow/渐变遮罩，被摘掉后历史卡片的悬停效果就没了。
    // 所以匹配一律用 (?![-\w])，并且这条测试钉住它。
    it('.history-item-overlay survives even though history-item is dead', function () {
      // 它必须还在。历史记录卡片（.history-item）整块确实死了，
      // 但这条遮罩规则本身挂着自己的 position/背景/布局，被顺手摘掉的话，
      // 一旦有人把历史功能加回来就会直接坏掉，而且没有任何报错。
      const hits = sheets.filter((f) => /\.history-item-overlay/.test(read(f)));
      assert.ok(
        hits.length > 0,
        '.history-item-overlay 不在死类表里，不该被 .history-item 的清理顺手摘掉'
      );
    });

    for (const cls of KEEP_FOR_JS_QUERY) {
      it(`.${cls} styles are kept because JS queries for it at runtime`, function () {
        // theme-core.js 按这个类名找元素；找不到匹配标记时它静默跳过，
        // 所以「搜不到引用」不足以判死。至少要有一处样式存在。
        const hits = sheets.filter((f) => new RegExp(`\\.${cls}(?![-\\w])`).test(read(f)));
        assert.ok(
          hits.length > 0,
          `.${cls} 被 JS 在运行时查询，样式不应删除`
        );
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
    // 不只原来那两个文件：这次 prune 覆盖了 12 个样式表，任何一个括号失衡
    // 都会静默吞掉后面的样式。
    const prunedSheets = [
      'mobile-refactor.css', 'admin-imgtc.css', 'index.css', 'theme.css',
      'gallery.css', 'webdav.css', 'preview.css', 'block-img.css',
      'whitelist-on.css', 'admin-waterfall.css', 'login.css', 'admin.css',
    ];
    for (const sheet of prunedSheets) {
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
