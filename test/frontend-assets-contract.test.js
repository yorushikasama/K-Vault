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
    // 方法体随模块化在 upload-app.js、模板绑定仍在页面里，两头都查。
    const src = read('index.html');
    const appSrc = read('upload-app.js');

    it('opens the native dialog instead of Element $confirm', function () {
      assert.match(appSrc, /clearHistory\(\)\s*\{\s*this\.historyConfirmOpen = true;/);
    });

    it('defines the method the dialog button binds to', function () {
      assert.match(src, /@click="confirmClearHistory"/, '弹窗按钮的绑定没了');
      assert.match(appSrc, /confirmClearHistory\(\)\s*\{/, 'confirmClearHistory 方法缺失，点确认会抛异常');
    });
  });

  describe('icons.js loads before the page instantiates Vue', function () {
    // icons.js 用 Vue.mixin 注册渲染钩子，而 Vue.mixin 只作用于之后创建的实例。
    // 应用逻辑已拆到根级 app 文件：页面不再内联 new Vue，约束转化为
    // 「icons.js 必须排在应用脚本之前」——script 标签按序执行，等价。
    // gallery.html 和 admin-imgtc.html 都踩过这个坑。
    const APP_SCRIPTS = {
      'index.html': 'upload-app.js',
      'gallery.html': 'gallery-app.js',
      'admin.html': 'admin-app.js',
      'admin-imgtc.html': 'admin-imgtc-app.js',
    };

    it('finds the Vue pages to check', function () {
      assert.strictEqual(Object.keys(APP_SCRIPTS).length, 4, 'Vue 页面清单与预期不符，请同步更新');
    });

    for (const [page, app] of Object.entries(APP_SCRIPTS)) {
      it(`${page} loads icons before its Vue app (${app})`, function () {
        const src = read(page);
        const iconsAt = src.search(/<script[^>]+src="\/icons\.js/);
        const appAt = src.search(new RegExp(`<script[^>]+src="/${app}`));
        assert.notStrictEqual(iconsAt, -1, `${page} 没有加载 icons.js`);
        assert.notStrictEqual(appAt, -1, `${page} 没有加载应用脚本 ${app}`);
        assert.ok(
          iconsAt < appAt,
          `${page} 的 icons.js 排在了 ${app} 之后，条件渲染里的图标不会被替换`
        );
      });
    }

    it('keeps no Vue instantiation inline in any page', function () {
      // 模块化契约：应用逻辑不回灌 HTML。出现即说明又把内联脚本塞回来了。
      const offenders = allPages.filter((p) => /\bnew Vue\s*\(/.test(read(p)));
      assert.deepStrictEqual(offenders, [], 'Vue 应用又内联回页面了；请放进独立的 app 文件');
    });
  });

  describe('every shared JS module is loaded as a <script>', function () {
    // 实测踩过：给 7 个页面加 kv-shared.js 时误写成 <link rel="stylesheet">，
    // 浏览器静默忽略，于是 KVShared 未定义、各页 Vue 全部不挂载——
    // 而「标签里有没有这个文件名」的粗检查照样通过。这里钉住标签类型。
    const MODULES = ['kv-shared.js', 'admin-shared.js', 'upload-media.js', 'upload-image.js',
      'admin-tokens.js', 'admin-ui-design.js', 'preview-parsers.js', 'gallery-app.js',
      'webdav-app.js', 'preview-app.js', 'upload-app.js', 'admin-app.js', 'admin-imgtc-app.js'];

    it('none of them is referenced with a <link> tag', function () {
      const offenders = [];
      for (const page of allPages) {
        const src = read(page);
        for (const mod of MODULES) {
          if (new RegExp(`<link[^>]+href="[^"]*${mod.replace('.', '\\.')}`).test(src)) {
            offenders.push(`${page} 用 <link> 引了 ${mod}`);
          }
        }
      }
      assert.deepStrictEqual(offenders, [], '这些模块必须用 <script src> 加载（<link> 会被静默忽略）');
    });

    it('the shared utilities module is loaded by every page that uses KVShared', function () {
      const missing = [];
      for (const page of allPages) {
        const src = read(page);
        const appFiles = (src.match(/<script[^>]+src="\/[a-z-]+-app\.js/g) || []);
        // 用到 KVShared 的 app 文件对应的页面必须加载 kv-shared.js
        const usesShared = appFiles.length > 0 &&
          (() => {
            const appNames = appFiles.map((m) => m.match(/src="\/([^"?]+)/)[1]);
            return appNames.some((f) => {
              try { return fs.readFileSync(path.join(root, f), 'utf8').includes('KVShared.'); }
              catch { return false; }
            });
          })();
        if (usesShared && !/<script[^>]+src="\/kv-shared\.js/.test(src)) {
          missing.push(page);
        }
      }
      assert.deepStrictEqual(missing, [], '这些页面的应用脚本用了 KVShared，但页面没有加载 kv-shared.js');
    });
  });

  describe('page-specific CSS lives in a cacheable file, not inline', function () {
    // HTML 走 no-cache，内联 <style> 每次导航都要重传；CSS 文件带内容哈希可以缓存
    // 一年。admin.html 原来有 1.9 KB 内联样式，而 admin.css 只被它一个页面加载，
    // 所以搬过去是纯收益。搬动位置也有讲究：内联块原本在 admin.css 之后、
    // workbench.css 之前，追加到 admin.css 末尾才能保住原来的级联顺序。
    it('no page ships an inline <style> block', function () {
      const offenders = allPages.filter((p) => /<style[\s>]/.test(read(p)));
      assert.deepStrictEqual(offenders, [], '这些页面又出现了内联样式，HTML 不可缓存，等于每次导航重传');
    });

    it('admin.css still carries the migrated rules', function () {
      const css = read('admin.css');
      for (const sel of ['.kv-files .files-feedback', '.folder-drawer-backdrop', '.preview-close']) {
        assert.ok(css.includes(sel), `admin.css 少了 ${sel}，内联块搬迁不完整`);
      }
    });
  });

  describe('admin.html keeps every stylesheet it actually applies', function () {
    // 这组是防「想当然去合并/删除」的。曾判断 admin-imgtc.css 在 admin.html 上是
    // 冗余（25 KB，直觉上像是给 admin-imgtc 用的），实际不是：
    // 用「把 <link> 置为 disabled，再逐元素对比计算样式」实测，
    // admin-imgtc.css 影响 19 个元素（分页器按钮圆角、页脚字号与颜色、
    // .el-main 的 flex-direction），workbench.css 影响 335 个，theme/mobile-refactor
    // 分别 48/37 个，admin.css 43 个——5 张本地样式表全都有效，没有可删的。
    //
    // 合并同样不是净收益：theme.css 被 10 个页面共享、mobile-refactor.css 被 9 个、
    // workbench.css 被 2 个，把 admin 专属规则并进共享表会让其它页面多下载。
    // admin-imgtc.css 与 admin.css 的选择器交集为 0，合并也减不掉重复。
    const ADMIN_SHEETS = ['theme.css', 'admin-imgtc.css', 'mobile-refactor.css', 'admin.css', 'workbench.css'];

    it('loads exactly the sheets each page needs', function () {
      const html = read('admin.html');
      for (const sheet of ADMIN_SHEETS) {
        assert.ok(
          new RegExp(`href="[./]*${sheet.replace('.', '\\.')}`).test(html),
          `admin.html 不再加载 ${sheet}；删除前请先用「禁用样式表 + 计算样式对比」确认它在本页真的无效`
        );
      }
    });

    it('keeps the cascade order that was verified', function () {
      // 顺序有意义：这次把内联块追加到 admin.css 末尾，就是为了让它仍然排在
      // workbench.css 之前。调整顺序前要重新做一次计算样式快照比对。
      const html = read('admin.html');
      const at = (sheet) => html.search(new RegExp(`href="[./]*${sheet.replace('.', '\\.')}`));
      assert.ok(at('admin.css') < at('workbench.css'), 'admin.css 必须排在 workbench.css 之前');
      assert.ok(at('theme.css') < at('admin.css'), 'theme.css 必须排在最前');
    });

    it('does not load a stylesheet that is dead on this page', function () {
      // 反向约束：admin-imgtc.css 只在 admin.html / admin-imgtc.html 上有意义时才有理由
      // 被 admin.html 加载；这里只防止误加与 admin 无关的表。
      const html = read('admin.html');
      assert.doesNotMatch(html, /href="[./]*index\.css/, 'index.css 属于上传首页，admin.html 不该加载');
      assert.doesNotMatch(html, /href="[./]*gallery\.css/, 'gallery.css 不属于 admin.html');
    });
  });
});
