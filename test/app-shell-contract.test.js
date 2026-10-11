const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

/**
 * 应用外壳契约。
 *
 * 这四个页面（上传 / 文件 / 图库 / WebDAV）是同一个应用的四个分区。此前顶栏
 * 定义在 workbench.css 里、并且作用域限定在 .kv-workbench 下，只有上传页与
 * 文件页带这个类；图库页和 WebDAV 页各自长了一套顶栏，导航项的文字都不一样
 * （图库页写「上传 / 管理 / 首页」，WebDAV 页写「首页 / 图片浏览 / 管理后台」），
 * 既没有「文件」入口（图库页还漏了 WebDAV 入口），点进去就像跳到了别的网站。
 *
 * 现在顶栏只有 app-shell.css 一份定义、四个页面共用同一段标记。这组测试钉住
 * 这件事——尤其是「别再让页面自己造一套页头」，那正是当初割裂的来源。
 */
describe('app shell contract', function () {
  const root = path.resolve(__dirname, '..');
  const read = (f) => fs.readFileSync(path.join(root, f), 'utf8');

  /** 顶栏的四个分区页。 */
  const SHELL_PAGES = ['index.html', 'admin.html', 'gallery.html', 'webdav.html'];

  /** 从页面里取出 <header class="workspace-header">…</header>。 */
  function extractHeader(src, page) {
    const start = src.indexOf('<header class="workspace-header"');
    assert.notStrictEqual(start, -1, `${page} 没有 workspace-header，顶栏可能又被拆成页面自己的了`);
    const end = src.indexOf('</header>', start);
    assert.notStrictEqual(end, -1, `${page} 的 workspace-header 没有闭合`);
    return src.slice(start, end + '</header>'.length);
  }

  it('every shell page loads app-shell.css', function () {
    for (const page of SHELL_PAGES) {
      const src = read(page);
      assert.match(
        src,
        /href="\/app-shell\.css\?v=[a-f0-9]+"/,
        `${page} 没有加载 app-shell.css —— 顶栏样式只有一个来源，缺了它这一页的页头会散架`
      );
    }
  });

  it('app-shell.css is loaded before the page-private sheets', function () {
    // 外壳是基础层，页面样式在其上做内容区覆盖。反过来的话页面规则会先落盘、
    // 外壳的 page-agnostic 约束就得靠优先级去压，正是当初难改的原因。
    for (const page of SHELL_PAGES) {
      const src = read(page);
      const shellAt = src.search(/href="\/app-shell\.css/);
      const own = ['index.css', 'admin.css', 'gallery.css', 'webdav.css'].find((f) => src.includes(`href="/${f}`));
      if (!own) continue;
      const ownAt = src.search(new RegExp(`href="/${own.replace('.', '\\.')}`));
      assert.ok(shellAt < ownAt, `${page} 把 app-shell.css 排在了 ${own} 之后，外壳会被页面样式覆盖`);
    }
  });

  it('all four pages carry the same navigation items and targets', function () {
    // 导航项与链接必须逐字一致：这正是「点图库/WebDAV 像换了个站」的直接成因。
    const expected = ['./', './admin.html', './gallery.html', './webdav.html'];
    const expectedLabels = ['上传', '文件', '图库', 'WebDAV'];

    for (const page of SHELL_PAGES) {
      const header = extractHeader(read(page), page);
      const navBlock = /<nav class="workspace-nav"[^>]*>([\s\S]*?)<\/nav>/.exec(header);
      assert.ok(navBlock, `${page} 的顶栏里没有 workspace-nav`);

      const hrefs = [...navBlock[1].matchAll(/href="([^"]+)"/g)].map((m) => m[1]);
      assert.deepStrictEqual(hrefs, expected, `${page} 的导航链接与其它分区不一致`);

      const labels = [...navBlock[1].matchAll(/>([^<>]+)<\/a>/g)]
        .map((m) => m[1].trim())
        .filter((t) => t && !t.startsWith('{{') && !t.includes('v-'));
      assert.deepStrictEqual(labels, expectedLabels, `${page} 的导航项文字与其它分区不一致`);
    }
  });

  it('each page marks exactly one current section, and it is its own', function () {
    const own = { 'index.html': './', 'admin.html': './admin.html', 'gallery.html': './gallery.html', 'webdav.html': './webdav.html' };
    for (const page of SHELL_PAGES) {
      const header = extractHeader(read(page), page);
      const navBlock = /<nav class="workspace-nav"[^>]*>([\s\S]*?)<\/nav>/.exec(header)[1];
      const currents = [...navBlock.matchAll(/<a href="([^"]+)"[^>]*aria-current/g)].map((m) => m[1]);
      assert.deepStrictEqual(
        currents,
        [own[page]],
        `${page} 的高亮项应为 ${own[page]}，实际 ${JSON.stringify(currents)}（应恰好一个）`
      );
    }
  });

  it('the shell defines the header, brand, nav and tool styles', function () {
    const css = read('app-shell.css');
    for (const sel of ['header.workspace-header', '.workspace-brand', '.workspace-nav a', '.workspace-tools', '.workspace-tool']) {
      assert.ok(css.includes(sel), `app-shell.css 缺少 ${sel}`);
    }
    // 外壳必须是全宽、贴顶、sticky 的应用外框，不能退化成卡片式页头。
    const block = /header\.workspace-header\s*\{([^}]*)\}/.exec(css);
    assert.ok(block, '找不到 header.workspace-header 规则');
    assert.match(block[1], /position:\s*sticky/, '外壳页头应为 sticky');
    assert.match(block[1], /width:\s*100%/, '外壳页头应占满宽度');
    assert.match(block[1], /border-radius:\s*0/, '外壳页头不应有圆角（它是外框不是卡片）');
  });

  it('only app-shell.css styles the shell header', function () {
    // 反向约束：防止有人从别的样式表去改外壳页头。
    //
    // 判定方式是「谁能命中外壳」而不是「谁写了 .header」：外壳的标记是
    // <header class="workspace-header">，裸 .header 规则打不到它。
    // mobile-refactor.css 里确实有 .header 分组规则，但那是给旧版独立页面
    // （admin-waterfall / admin-imgtc）的，与外壳互不影响——按类名匹配会误报。
    //
    // 先剥注释再匹配：mobile-refactor / workbench 的注释里会提到这些类名
    // （例如「页头规则已搬到 app-shell.css」），那是说明而不是样式。
    const stripComments = (s) => s.replace(/\/\*[\s\S]*?\*\//g, '');
    for (const sheet of fs.readdirSync(root).filter((f) => f.endsWith('.css') && f !== 'app-shell.css')) {
      const src = stripComments(read(sheet));
      assert.doesNotMatch(
        src,
        /(?:^|[\s,])\.workspace-(?:header|brand|nav|tool|tools)\b/m,
        `${sheet} 又在改动应用外壳的样式；外壳只有一个来源 app-shell.css`
      );
    }
  });

  it('every shell page can reach the theme switcher in the shell', function () {
    // 不要求页面带 data-theme-toggle：theme-core.js 会在没有按钮时注入到
    // workspace-tools 里。这里只守住「外壳存在工具区」这个前提。
    for (const page of SHELL_PAGES) {
      const header = extractHeader(read(page), page);
      assert.match(header, /class="workspace-tools"/, `${page} 的顶栏没有 workspace-tools，主题入口无处安放`);
    }
  });
});
