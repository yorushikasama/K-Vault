const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

/**
 * 前端第三方依赖的加载契约。
 *
 * 这些页面没有打包步骤，依赖都是手写的 <script>/<link>，很容易在改动中被顺手加回来。
 * 这组测试把「哪个页面该加载什么」钉死，让多余的 CDN 依赖在 CI 里就挂掉。
 */
describe('frontend third-party asset contract', function () {
  const root = path.resolve(__dirname, '..');
  const read = (page) => fs.readFileSync(path.join(root, page), 'utf8');
  const allPages = fs.readdirSync(root).filter((f) => f.endsWith('.html'));

  describe('FontAwesome is fully gone', function () {
    it('is not loaded by any page', function () {
      const offenders = allPages.filter((p) => /fontawesome/i.test(read(p)));
      assert.deepStrictEqual(offenders, [], 'FontAwesome 整包 22.7 KB gzip，全站只用到五个品牌图标');
    });

    it('leaves no page depending on the brand webfont', function () {
      // theme.css 以前用 font-family: "Font Awesome 6 Brands" 渲染品牌字形；
      // 字体没了之后这条规则只会渲染出豆腐块。
      const themeCss = fs.readFileSync(path.join(root, 'theme.css'), 'utf8');
      assert.doesNotMatch(themeCss, /Font Awesome/i);
    });

    it('inlines every brand icon the pages still reference', function () {
      const iconsJs = fs.readFileSync(path.join(root, 'icons.js'), 'utf8');
      const referenced = new Set();
      for (const page of allPages) {
        for (const m of read(page).matchAll(/(?:fab|fa-brands|fas|far)\s+fa-([a-z0-9-]+)/g)) {
          referenced.add(m[1]);
        }
      }
      assert.ok(referenced.size > 0, '品牌图标引用扫描失效了');
      const missing = [...referenced].filter((brand) => !new RegExp(`\\b${brand}:\\s*"M`).test(iconsJs));
      assert.deepStrictEqual(missing, [], 'icons.js 的 BRAND_PATHS 里缺这些品牌，页面会渲染成空白');
    });
  });

  describe('Element UI only loads where it is actually used', function () {
    // Element UI 的 JS + CSS 合计 183 KB gzip，只有真用 <el-*> 组件或 $message/
    // $confirm 这类实例方法的页面才值得付这个代价。
    const elementUsers = ['admin.html', 'admin-imgtc.html'];

    it('is loaded by the admin pages that use its components', function () {
      for (const page of elementUsers) {
        const src = read(page);
        assert.match(src, /element-ui@[\d.]+\/lib\/index\.js/, `${page} 用了 Element 组件但没加载它`);
        assert.match(src, /element-ui@[\d.]+\/lib\/theme-chalk\/index\.css/, `${page} 缺 Element 样式`);
      }
    });

    it('is not loaded by any other page', function () {
      const offenders = allPages.filter((p) => !elementUsers.includes(p) && /element-ui/.test(read(p)));
      assert.deepStrictEqual(offenders, [], '这些页面白付了 183 KB gzip');
    });

    it('leaves no page calling Element instance methods without loading it', function () {
      // $confirm / $message 这类调用在没装 Element 的页面上是运行时 TypeError，
      // 而且往往藏在只有特定交互才走到的分支里。
      const apiCall = /\bthis\.\$(message|confirm|alert|prompt|notify|loading)\b/;
      for (const page of allPages) {
        if (elementUsers.includes(page)) continue;
        assert.doesNotMatch(read(page), apiCall, `${page} 调了 Element 的实例方法却没加载 Element`);
      }
    });

    it('leaves no dead Element styles in the sheets only non-Element pages load', function () {
      // index.css / gallery.css 只被各自的页面加载；Element 走了之后这些规则永远不匹配。
      for (const sheet of ['index.css', 'gallery.css']) {
        const css = fs.readFileSync(path.join(root, sheet), 'utf8');
        assert.doesNotMatch(css, /\.el-[a-z]/, `${sheet} 还留着 Element 的死样式`);
      }
    });
  });

  describe('index.html clear-history flow', function () {
    // 这条路径原本是半成品：原生弹窗的模板、状态和焦点管理都在，但 clearHistory()
    // 还在调 Element 的 $confirm，而弹窗按钮绑的 confirmClearHistory 方法根本不存在。
    const src = read('index.html');

    it('opens the native dialog instead of Element $confirm', function () {
      assert.match(src, /clearHistory\(\)\s*\{\s*this\.historyConfirmOpen = true;/);
    });

    it('defines the method the dialog button binds to', function () {
      assert.match(src, /@click="confirmClearHistory"/, '弹窗按钮的绑定没了');
      assert.match(src, /confirmClearHistory\(\)\s*\{/, 'confirmClearHistory 方法缺失，点确认会抛异常');
    });
  });

  describe('icons.js loads before the page instantiates Vue', function () {
    // icons.js 用 Vue.mixin 注册渲染钩子，而 Vue.mixin 只作用于之后创建的实例。
    // 脚本放在 new Vue 后面时，首屏那次全文档扫描照样能把静态图标换掉，所以问题
    // 完全不显形——只有 v-if / v-for 之后才进 DOM 的图标会永久保持空白。
    // gallery.html 和 admin-imgtc.html 都踩过这个坑。
    const vuePages = allPages.filter((p) => /\bnew Vue\s*\(/.test(read(p)));

    it('finds the Vue pages to check', function () {
      assert.ok(vuePages.length >= 4, `只扫到 ${vuePages.length} 个 Vue 页面，扫描逻辑可能失效了`);
    });

    for (const page of vuePages) {
      it(`${page} registers the mixin first`, function () {
        const src = read(page);
        const iconsAt = src.search(/<script[^>]+src="\/icons\.js/);
        const vueAt = src.search(/\bnew Vue\s*\(/);
        assert.notStrictEqual(iconsAt, -1, `${page} 没有加载 icons.js`);
        assert.ok(
          iconsAt < vueAt,
          `${page} 把 icons.js 放在了 new Vue 之后，条件渲染里的图标不会被替换`
        );
      });
    }
  });
});
