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
    const apiCall = /\bthis\.\$(message|confirm|alert|prompt|notify|loading)\b/;

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

    it('leaves no non-Element app script calling Element instance methods', function () {
      // 应用逻辑拆到根级 *.js 之后，实例方法调用也跟着搬了过去，守护同步跟进。
      const nonElementApps = ['upload-app.js', 'upload-media.js', 'gallery-app.js', 'webdav-app.js', 'preview-app.js', 'preview-parsers.js'];
      for (const app of nonElementApps) {
        const src = fs.readFileSync(path.join(root, app), 'utf8');
        assert.doesNotMatch(src, apiCall, `${app} 调了 Element 的实例方法却属于不加载 Element 的页面`);
      }
    });
  });

  describe('index.html clear-history flow', function () {
    // 这条路径原本是半成品：原生弹窗的模板、状态和焦点管理都在，但 clearHistory()
    // 还在调 Element 的 $confirm，而弹窗按钮绑的 confirmClearHistory 方法根本不存在。
    // 应用拆到 upload-app.js 之后，方法体在 app 文件里、模板绑定仍在页面里，两头都查。
    const src = read('index.html');
    const appSrc = fs.readFileSync(path.join(root, 'upload-app.js'), 'utf8');

    it('opens the native dialog instead of Element $confirm', function () {
      assert.match(appSrc, /clearHistory\(\)\s*\{\s*this\.historyConfirmOpen = true;/);
    });

    it('defines the method the dialog button binds to', function () {
      assert.match(src, /@click="confirmClearHistory"/, '弹窗按钮的绑定没了');
      assert.match(appSrc, /confirmClearHistory\(\)\s*\{/, 'confirmClearHistory 方法缺失，点确认会抛异常');
    });
  });

  describe('icons.js loads before the page instantiates Vue', function () {
    // Vue 应用已拆到独立文件（upload-app.js 等），script 标签按序执行，
    // 所以原约束「icons 必须先于 new Vue」转化为「icons.js 必须排在应用
    // 脚本之前」——icons.js 用 Vue.mixin 注册渲染钩子，只作用于之后创建
    // 的实例；顺序反了，v-if / v-for 之后进 DOM 的图标会永久空白。
    // gallery.html 和 admin-imgtc.html 都踩过这个坑。
    const APP_SCRIPTS = {
      'index.html': 'upload-app.js',
      'gallery.html': 'gallery-app.js',
      'admin.html': 'admin-app.js',
      'admin-imgtc.html': 'admin-imgtc-app.js',
    };

    it('finds the Vue pages to check', function () {
      assert.strictEqual(Object.keys(APP_SCRIPTS).length, 4, 'Vue 页面清单与预期不符，请同步更新本清单');
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
          `${page} 的 icons.js 排在 ${app} 之后，条件渲染里的图标不会被替换`
        );
      });
    }

    it('keeps no Vue instantiation inline in any page', function () {
      // 模块化契约：应用逻辑不回灌 HTML。出现即说明又把内联脚本塞回来了。
      const offenders = allPages.filter((p) => /\bnew Vue\s*\(/.test(read(p)));
      assert.deepStrictEqual(offenders, [], 'Vue 应用又内联回页面了；请放进独立的 app 文件');
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

  describe('no scattered style attributes anywhere', function () {
    // 内联 <style> 块禁掉之后，散落的下一站是 style=" 属性和 JS 模板串里的
    // 行内样式：它们绕开样式表的内容哈希缓存，也绕开主题 token（暗色模式
    // 会漏改）。收口后页面标记只允许 class；颜色走 theme.css 的语义 token。
    // Vue 应用拆到根级 *.js 之后，模板串也住进了那些文件，所以这里把全部
    // 根级 JS 一并纳入扫描。唯二例外是 admin.html 的两处 :style 动态绑定
    // ——拖拽工具栏定位和文件夹层级深度，绑定的都是运行时才知道的值，
    // 缩进公式本身仍在 admin.css 里。
    const inlineStyleAttr = /(^|[^:>\w])style\s*=\s*["']/;
    const sources = allPages.map((page) => ({ page, src: read(page) }));
    const rootScripts = fs.readdirSync(root).filter((f) => f.endsWith('.js'));
    for (const file of rootScripts) {
      sources.push({ page: file, src: fs.readFileSync(path.join(root, file), 'utf8') });
    }

    it('no page or root script carries a style=" attribute', function () {
      const offenders = sources.filter((s) => inlineStyleAttr.test(s.src)).map((s) => s.page);
      assert.deepStrictEqual(offenders, [], '散落的内联样式又回来了；请进对应的 CSS 文件并使用 token');
    });

    it('keeps :style bindings limited to the two documented dynamic ones', function () {
      for (const s of sources) {
        const bindings = (s.src.match(/:style\s*=/g) || []).length;
        if (s.page === 'admin.html') {
          assert.strictEqual(bindings, 2, 'admin.html 应只剩 folder-depth 与 batchToolbarStyle 两处动态绑定');
        } else {
          assert.strictEqual(bindings, 0, `${s.page} 出现了新的 :style 绑定`);
        }
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
    // workspace-header.css 是从 workbench.css 平移出的页头家族（品牌/标签导航/工具区），
    // index / admin / gallery / webdav 四页共用。
    const ADMIN_SHEETS = ['theme.css', 'admin-imgtc.css', 'mobile-refactor.css', 'workspace-header.css', 'admin.css', 'workbench.css'];

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
