const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

/**
 * 移动端布局契约。
 *
 * 这些规则都是从实测缺陷反推出来的，不是风格偏好。每个断言都对应一个
 * 在真实设备宽度下量到过的问题：
 *
 *   1. webdav 单列 grid 用裸 1fr —— 子项 min-width:auto 不会小于内容宽度，
 *      卡片里的 nowrap 文本把轨道顶到 503px，390px 屏横向溢出 123px。
 *   2. 首页页头缺移动端规则 —— 品牌+导航+工具约 450px 加内外边距，
 *      390px 屏溢出 68px，导航被推出屏幕。
 *   3. 触摸目标不足 44px —— WCAG 2.5.5 与 Apple HIG 的下限；实测有
 *      20px 高的页脚链接、28px 的分页按钮、30px 的品牌 logo。
 *   4. el-message 硬编码 min-width:380px —— 320px 屏上左边被裁掉；
 *      它还用 left:50% + translateX(-50%) 定位，只改 left 会把它推更远。
 */
describe('mobile layout contract', function () {
  const root = path.resolve(__dirname, '..');
  const read = (f) => fs.readFileSync(path.join(root, f), 'utf8');
  const allCss = fs.readdirSync(root).filter((f) => f.endsWith('.css'));

  describe('grid tracks must not be sized by their content', function () {
    it('webdav single-column layout uses minmax(0, 1fr)', function () {
      const css = read('webdav.css');
      const m = /@media \(max-width: 980px\)[\s\S]*?\.layout\s*\{[^}]*grid-template-columns:\s*([^;]+);/.exec(css);
      assert.ok(m, '找不到 webdav 的窄屏 .layout 规则');
      assert.match(
        m[1],
        /minmax\(0,\s*1fr\)/,
        'webdav 的窄屏 .layout 用了裸 1fr；子项的 min-width:auto 会被 nowrap 内容顶开，窄屏横向溢出'
      );
    });

    it('workbench storage grid uses minmax(0, 1fr)', function () {
      const css = read('workbench.css');
      const m = /\.upload-storage-options\s*\{[^}]*grid-template-columns:\s*([^;]+);/.exec(css);
      assert.ok(m, '找不到 .upload-storage-options 的网格定义');
      assert.match(m[1], /minmax\(0,\s*1fr\)/, '存储目标网格用了裸 1fr，长站点名会把轨道撑开');
    });
  });

  describe('the workbench header has mobile rules', function () {
    // 首页改用 workbench.css 后漏了这套规则（admin.html 靠 mobile-refactor.css 兜住），
    // 结果首页头部在 900px 以下溢出。
    const css = read('workbench.css');

    it('lets the header wrap on narrow screens', function () {
      const block = /@media \(max-width: 900px\)[\s\S]*?\n\}/.exec(css);
      assert.ok(block, 'workbench.css 没有 900px 媒体查询');
      assert.match(block[0], /\.kv-workbench \.workspace-header\s*\{[^}]*flex-wrap:\s*wrap/, '页头在窄屏没有允许换行，会把导航挤出视口');
    });

    it('makes the nav scrollable rather than overflowing', function () {
      const block = /@media \(max-width: 900px\)[\s\S]*?\n\}/.exec(css);
      assert.match(block[0], /\.kv-workbench \.workspace-nav\s*\{[^}]*overflow-x:\s*auto/, '导航没有横向滚动兜底');
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

    it('workbench defines its own targets since index.html skips mobile-refactor', function () {
      const html = read('index.html');
      assert.doesNotMatch(html, /mobile-refactor\.css/, 'index.html 现在加载了 mobile-refactor.css，两处规则会重复');
      const css = read('workbench.css');
      assert.match(css, /\.kv-workbench :is\(\.upload-btn[\s\S]{0,120}min-height:\s*44px/, 'workbench.css 缺少触摸目标规则');
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
    const GUARDED = ['webdav.css', 'workbench.css'];
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
