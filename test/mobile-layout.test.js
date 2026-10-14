const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

/**
 * 移动端布局契约。
 *
 * 这些规则都是从实测缺陷反推出来的，不是风格偏好。每个断言都对应一个
 * 在真实设备宽度下量到过的问题：
 *
 *   1. 存储目标网格用裸 1fr —— 子项 min-width:auto 不会小于内容宽度，
 *      长站点名把轨道顶开。
 *   2. 首页页头缺移动端规则 —— 品牌+导航+工具约 450px 加内外边距，
 *      390px 屏溢出 68px，导航被推出屏幕。
 *   3. 触摸目标不足 44px —— WCAG 2.5.5 与 Apple HIG 的下限；实测有
 *      20px 高的页脚链接、28px 的分页按钮、30px 的品牌 logo。
 *   4. el-message 硬编码 min-width:380px —— 320px 屏上左边被裁掉；
 *      它还用 left:50% + translateX(-50%) 定位，只改 left 会把它推更远。
 *   5. 上传行的长文件名 —— 320px 视口下「缩略图 + 文件名 + 图标按钮」
 *      单行 flex 把文件名区挤到 14px，90 字符的文件名逐字折行、单行高
 *      1680px，一行记录顶掉整屏。同一批的 .upload-file-meta 也没有
 *      overflow-wrap，无空格的长目录名横向溢出到边框外。
 *
 * 另有一批同类断言曾挂在 webdav.css 上（单列 grid 裸 1fr、.file-picker
 * 缺 min-width:0、.upload-file-row 没有 flex-wrap）。那个页面与后端功能
 * 已整体下线，连同这些只针对它的断言一起移除 —— 它们量的是一个不存在的
 * 页面，留着只会让人以为那里还有东西要维护。
 */
describe('mobile layout contract', function () {
  const root = path.resolve(__dirname, '..');
  const read = (f) => fs.readFileSync(path.join(root, f), 'utf8');
  const allCss = fs.readdirSync(root).filter((f) => f.endsWith('.css'));

  describe('grid tracks must not be sized by their content', function () {
    it('workbench storage grid uses minmax(0, 1fr)', function () {
      const css = read('workbench.css');
      const m = /\.upload-storage-options\s*\{[^}]*grid-template-columns:\s*([^;]+);/.exec(css);
      assert.ok(m, '找不到 .upload-storage-options 的网格定义');
      assert.match(m[1], /minmax\(0,\s*1fr\)/, '存储目标网格用了裸 1fr，长站点名会把轨道撑开');
    });

    it('gives the upload file rows a two-row grid on narrow screens', function () {
      // 长文件名实测：320px 视口下，原来「缩略图 + 文件名 + 图标按钮」
      // 单行 flex 把 .upload-file-info 挤到 14px 宽，90 字符的文件名按
      // overflow-wrap 逐字折行，单行高 1680px，一行记录顶掉整屏。
      // 断点取 768：768 以上一行放得下，而铺满的按钮会被拉到 203px 宽
      // （实测），不该让这条为窄屏写的规则去改桌面排版。
      const css = read('workbench.css');
      const block = /@media \(max-width: 768px\)\s*\{\s*\.kv-workbench :is\(\.upload-result-row[\s\S]*?\.upload-row-actions \.btn\s*\{/.exec(css);
      assert.ok(block, 'workbench.css 没有「窄屏下上传行改两行网格」的 768px 媒体查询');

      const rows = block[0];
      assert.match(
        rows,
        /\.upload-result-row,\s*\.upload-history-row\)\s*\{[^}]*display:\s*grid/,
        '结果/历史行在窄屏没有改成网格'
      );
      assert.match(rows, /\.upload-task-row\s*\{[^}]*display:\s*grid/, '队列行在窄屏没有改成网格');

      // 三个子项都要有 grid-area，否则自动摆放会落进第一行的文件名列。
      for (const area of ['select', 'thumb', 'info', 'actions']) {
        assert.match(
          rows,
          new RegExp(`grid-area:\\s*${area}\\b`),
          `窄屏上传行没有给 ${area} 指定 grid-area，自动摆放会和文件名抢同一格`
        );
      }

      // 三列都必须是 auto 或 minmax(0, 1fr)：裸 1fr 会被 nowrap 内容顶开，
      // 这正是上面那个 1fr 断言要防的同一个坑，网格版本同样适用。
      for (const m of rows.matchAll(/grid-template-columns:\s*([^;]+);/g)) {
        const value = m[1];
        for (const track of value.trim().split(/\s+(?![^(]*\))/)) {
          assert.ok(
            track === 'auto' || /minmax\(0,\s*1fr\)/.test(track),
            `窄屏上传行的轨道「${track}」既不是 auto 也不是 minmax(0, 1fr)，会被内容顶开`
          );
        }
      }
    });

    it('lets long paths wrap in the file row metadata line', function () {
      // .upload-file-meta 拼的是「大小 · 存储目标 · 目录路径」。目录名由
      // 用户自建，可能整段没有空格也不带连字符，overflow-wrap: normal
      // 不会断它 —— 实测该行 scrollWidth 82px / clientWidth 35px，
      // 文字横向溢出到边框外。
      const css = read('workbench.css');
      const m = /\.upload-muted, \.upload-file-meta\)\s*\{([^}]*)\}/.exec(css);
      assert.ok(m, '找不到 .upload-file-meta 的基础规则');
      assert.match(
        m[1],
        /overflow-wrap:\s*anywhere/,
        '.upload-file-meta 没有 overflow-wrap: anywhere，无空格的长目录名会横向溢出'
      );
    });
  });

  describe('the app shell header has mobile rules', function () {
    // 顶栏从 workbench.css 抽到 app-shell.css 之后（它现在是各分区共用的
    // 应用外壳：上传 / 文件 / 图库 / 视频），这套规则随之搬家。
    // 断言跟着移到新文件，但要求不变：窄屏必须换行 + 导航可横向滚动，
    // 否则 390px 视口会把导航推出屏幕。
    const css = read('app-shell.css');

    it('lets the header wrap on narrow screens', function () {
      const block = /@media \(max-width: 900px\)[\s\S]*?\n\}/.exec(css);
      assert.ok(block, 'app-shell.css 没有 900px 媒体查询');
      assert.match(
        block[0],
        /header\.workspace-header\s*\{[^}]*flex-wrap:\s*wrap/,
        '页头在窄屏没有允许换行，会把导航挤出视口'
      );
    });

    it('makes the nav scrollable rather than overflowing', function () {
      const block = /@media \(max-width: 900px\)[\s\S]*?\n\}/.exec(css);
      assert.match(block[0], /\.workspace-nav\s*\{[^}]*overflow-x:\s*auto/, '导航没有横向滚动兜底');
    });
  });

  describe('touch targets meet the 44px floor', function () {
    // 触摸目标现在有两个来源：已迁移到 .btn 的页面由 ui-buttons.css 负责，
    // 尚未迁移的后台页仍靠 mobile-refactor.css 的兜底。
    // 首页不加载 mobile-refactor.css，规则写在 workbench.css。
    it('ui-buttons.css gives migrated buttons the 44px floor', function () {
      const css = read('ui-buttons.css');
      assert.match(
        css,
        /@media \(max-width: 768px\)[\s\S]*?\.btn\s*\{[^}]*min-height:\s*44px/,
        'ui-buttons.css 没有在窄屏把 .btn 抬到 44px；迁移后的页面会失去触摸下限'
      );
    });

    it('mobile-refactor still covers bare buttons as a fallback', function () {
      const css = read('mobile-refactor.css');
      // 后台页仍有裸 <button>，枚举具体类名必然漏。
      // 已挂 .btn 的排除在外 —— 它们的高度由 ui-buttons.css 定义，
      // 再补一条 !important 会让两处来源互相打架。
      assert.match(
        css,
        /^\s*button:not\(\.btn\),\s*$/m,
        'mobile-refactor.css 缺少裸 button 兜底规则（应为 button:not(.btn)）；未迁移的页面会漏掉'
      );
    });

    it('keeps the touch-target rules in a max-width media query', function () {
      const css = read('mobile-refactor.css');
      const touch = /触摸目标下限[\s\S]*?@media \(max-width: (\d+)px\)/.exec(css);
      assert.ok(touch, '找不到触摸目标的媒体查询');
      assert.ok(Number(touch[1]) >= 480, `触摸目标断点是 ${touch[1]}px，太小——平板竖屏（768）也会用触摸`);
    });

    it('the app shell carries its own touch targets for the pages that skip mobile-refactor', function () {
      // index.html 不加载 mobile-refactor.css（避免两处规则重复），
      // 所以它用到的页头元素必须自己带 44px 下限。顶栏现在由各分区共用，
      // 这份规则随之落在 app-shell.css —— 任一分区都不会漏。
      const html = read('index.html');
      assert.doesNotMatch(html, /mobile-refactor\.css/, 'index.html 现在加载了 mobile-refactor.css，两处规则会重复');
      const css = read('app-shell.css');
      assert.match(css, /\.workspace-nav a,[\s\S]{0,80}\.workspace-tool\s*\{[\s\S]{0,80}min-height:\s*44px/, 'app-shell.css 缺少页头的触摸目标规则');
    });
  });

  describe('el-message fits the viewport', function () {
    const css = read('mobile-refactor.css');

    it('overrides the hard-coded min-width', function () {
      assert.match(css, /\.el-message\s*\{[^}]*min-width:\s*0\s*!important/, 'Element 的 min-width:380px 没有覆盖，320px 屏上会被裁');
    });

    it('clears the translateX that Element pairs with left:50%', function () {
      // 只设 left 而不清 transform，元素会再左移自身宽度的一半（实测 -171px）
      const block = /\.el-message\s*\{([^}]*)\}/.exec(css);
      assert.ok(block, '找不到 .el-message 规则');
      assert.match(block[1], /transform:\s*none\s*!important/, '没有清掉 translateX(-50%)，消息会被推出屏幕左边');
    });
  });

  describe('no stylesheet reintroduces a bare 1fr fallback in a mobile block', function () {
    // 只检查已知会出问题的那几处；全站扫 1fr 会误报（很多网格的子项没有 nowrap 内容）
    const GUARDED = ['workbench.css'];
    for (const file of GUARDED) {
      it(`${file} mobile grid tracks are all minmax(0, ...)`, function () {
        const css = read(file);
        const offenders = [];
        for (const m of css.matchAll(/grid-template-columns:\s*([^;]+);/g)) {
          const value = m[1];
          // 单列 1fr 才危险；repeat(N, 1fr) 在多列时每列都很窄，同样要给 minmax
          if (/^\s*1fr\s*$/.test(value) || /repeat\(\s*\d+\s*,\s*1fr\s*\)/.test(value)) {
            const line = css.slice(0, m.index).split('\n').length;
            // 允许出现，但必须在注释里写明理由——留个记号让人复查
            const context = css.slice(Math.max(0, m.index - 400), m.index);
            if (!/min-width:\s*auto|会被内容顶开|minmax/.test(context)) {
              offenders.push(`${line}: ${value.trim()}`);
            }
          }
        }
        assert.deepStrictEqual(
          offenders,
          [],
          `${file} 里这些网格用了裸 1fr 且附近没有说明；子项 min-width:auto 会被内容撑开`
        );
      });
    }
  });

  it('keeps every stylesheet syntactically intact', function () {
    for (const sheet of allCss) {
      const src = read(sheet);
      let depth = 0, min = 0, i = 0, unclosed = false;
      while (i < src.length) {
        if (src.startsWith('/*', i)) {
          const end = src.indexOf('*/', i + 2);
          if (end === -1) { unclosed = true; break; }
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
        else if (ch === '}') { depth--; if (depth < min) min = depth; }
        i++;
      }
      assert.strictEqual(unclosed, false, `${sheet} 有未闭合注释`);
      assert.strictEqual(depth, 0, `${sheet} 花括号不配平`);
      assert.strictEqual(min, 0, `${sheet} 有多余的 }`);
    }
  });
});
