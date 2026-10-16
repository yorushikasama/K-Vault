const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

/**
 * 应用外壳契约。
 *
 * 这几个页面（上传 / 文件 / 图库 / 视频）是同一个应用的分区页。此前顶栏
 * 定义在 workbench.css 里、并且作用域限定在 .kv-workbench 下，只有上传页与
 * 文件页带这个类；图库页与 WebDAV 页各自长了一套顶栏，导航项的文字都不一样
 * （图库页写「上传 / 管理 / 首页」，WebDAV 页写「首页 / 图片浏览 / 管理后台」），
 * 既没有「文件」入口，点进去就像跳到了别的网站。
 *
 * WebDAV 分区与它的存储后端已整体下线，所以下面的页面名单是四个。
 *
 * 现在顶栏只有 app-shell.css 一份定义、各页面共用同一段标记。这组测试钉住
 * 这件事——尤其是「别再让页面自己造一套页头」，那正是当初割裂的来源。
 */
describe('app shell contract', function () {
  const root = path.resolve(__dirname, '..');
  const read = (f) => fs.readFileSync(path.join(root, f), 'utf8');

  /** 顶栏的分区页。视频库页是后加的，但它也用同一段顶栏标记。 */
  const SHELL_PAGES = ['index.html', 'admin.html', 'gallery.html', 'video.html'];

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
      const own = ['index.css', 'admin.css', 'gallery.css', 'video.css'].find((f) => src.includes(`href="/${f}`));
      if (!own) continue;
      const ownAt = src.search(new RegExp(`href="/${own.replace('.', '\\.')}`));
      assert.ok(shellAt < ownAt, `${page} 把 app-shell.css 排在了 ${own} 之后，外壳会被页面样式覆盖`);
    }
  });

  it('every shell page carries the same navigation items and targets', function () {
    // 导航项与链接必须逐字一致：这正是「点图库像换了个站」的直接成因。
    const expected = ['./', './admin.html', './gallery.html', './video.html'];
    const expectedLabels = ['上传', '文件', '图库', '视频'];

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
    const own = { 'index.html': './', 'admin.html': './admin.html', 'gallery.html': './gallery.html', 'video.html': './video.html' };
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

  /**
   * 从页面里取出 <div class="workspace-tools">…</div>。
   * 只取到第一个 </div>：工具区里不再嵌套 div，够用；嵌套了就该重新数括号。
   */
  function extractTools(src, page) {
    const start = src.indexOf('<div class="workspace-tools">');
    assert.notStrictEqual(start, -1, `${page} 的顶栏里没有 workspace-tools`);
    const end = src.indexOf('</div>', start);
    assert.notStrictEqual(end, -1, `${page} 的 workspace-tools 没有闭合`);
    return src.slice(start, end + '</div>'.length);
  }

  /**
   * 工具区的按钮签名：class 之外的标记（图标、title、绑定方式）与顺序。
   *
   * 这条断言是补上的一次真实疏漏：文件页的顶栏此前挂着 7 个按钮，另外三页
   * 只有 2 个，而那组测试只校验了导航项 —— 于是「点文件页像换了网站」这件事
   * 可以无声地漂很久。外壳是四个分区共用的外框，挂在上面的东西必须是全站级
   * 的，页面自己私有的控件该待在自己的内容区里。
   */
  function toolSignature(tools) {
    return [...tools.matchAll(/<(button|a)\b([^>]*)>/g)].map(([, tag, attrs]) => {
      const pick = (name) => (attrs.match(new RegExp(`\\b${name}="([^"]*)"`)) || [, ''])[1];
      const classes = (pick('class').split(/\s+/).filter(Boolean) || []).sort().join('.');
      // Vue 指令也要算进去：index.html 给退出按钮加了 v-if，那是访客态下
      // 真的会少一个按钮的差异，不能因为属性名不同就漏掉。
      const directives = [...attrs.matchAll(/\b(v-if|v-show)="([^"]*)"/g)].map((m) => `${m[1]}=${m[2]}`);
      return [
        tag,
        classes,
        pick('data-theme-toggle') !== '' ? 'data-theme-toggle' : '',
        pick('data-shell-tool'),
        pick('data-shell-logout') !== '' ? 'data-shell-logout' : '',
        pick('data-lucide'),
        pick('title'),
        pick('aria-label'),
        ...directives,
      ].filter(Boolean).join('|');
    });
  }

  it('every shell page carries the same tool buttons in the same order', function () {
    const expected = ['主题', '系统连接', 'UI 设计', '退出'];

    for (const page of SHELL_PAGES) {
      const tools = extractTools(extractHeader(read(page), page), page);
      const sig = toolSignature(tools);

      // 图标是外壳识别按钮的主要手段（480px 以下只剩 aria-label），所以
      // 数量和身份都要对上——数量对但多了一个「本页专用」按钮同样不行。
      assert.strictEqual(
        sig.length,
        expected.length,
        `${page} 的顶栏工具区应有 ${expected.length} 项（${expected.join(' / ')}），实际 ${sig.length} 项：` +
          JSON.stringify(sig, null, 1) +
          '\n外壳是四个分区共用的外框，本页私有的控件请放进页面内容区，别挂顶栏。'
      );

      const labels = [...tools.matchAll(/aria-label="([^"]*)"/g)].map((m) => m[1]);
      assert.deepStrictEqual(labels, ['切换主题', '系统连接状态', 'UI 设计设置', '退出登录'], `${page} 的工具按钮与其它分区不一致`);
    }
  });

  it('the shell tool buttons are wired by data attributes, not page-level handlers', function () {
    // 三个分区页都没有 Element 也没有共享的 Vue 方法表。面板若靠页面里的
    // @click="openXxx" 接线，那三个页面点一下就是 TypeError —— 所以行为
    // 统一由 shell-tools.js 按 data-shell-tool 绑定，页面只留占位。
    //
    // 先剥注释：页面里那些解释性的中文注释会提到 @click（本页曾经就是那么
    // 接的），那是说明不是接线。
    for (const page of SHELL_PAGES) {
      const tools = extractTools(extractHeader(read(page), page), page).replace(/<!--[\s\S]*?-->/g, '');
      assert.doesNotMatch(
        tools,
        /@click|v-on:/,
        `${page} 的工具区用了页面级事件绑定；另外三个分区页没有对应方法，应该走 data-shell-tool`
      );
    }
  });

  it('the shell tool buttons only appear where their behaviour is defined', function () {
    // data-shell-logout 取代了各页自己的退出实现（此前四页各写一份，行为
    // 已经漂开）。没有这个断言，很容易在某页把按钮留着却把处理函数删了。
    const src = read('shell-tools.js');
    assert.match(src, /data-shell-tool/, 'shell-tools.js 没有按 data-shell-tool 接线');
    assert.match(src, /data-shell-logout/, 'shell-tools.js 没有接退出按钮');
    assert.match(src, /KVShared\.logout/, '退出动作应收拢到 KVShared.logout()，而不是各页自己发请求');
  });

  it('no shell page reintroduces a page-private control into the header', function () {
    // 本次收敛掉的四类东西，逐个点名。它们都是文件工作台私有的：加载模式、
    // 安全模式、快捷入口、文件工具（下放到页面的操作栏与查询栏，不是删掉）。
    // 把这条写成具体清单而不是一句「不要乱加」，是为了下次有人把它们搬回
    // 顶栏时能看懂为什么不行。
    //
    // 只看工具区，不看整个 header：文件页把「快捷入口 / 工具」放进页面操作
    // 栏是这次想要的，判据是「在不在顶栏里」而不是「页面上有没有这个字」。
    const privateToFiles = ['loadMode', 'safeMode', 'handleToolkit', 'handleWebsite', '快捷入口'];
    for (const page of SHELL_PAGES) {
      const tools = extractTools(extractHeader(read(page), page), page);
      for (const marker of privateToFiles) {
        assert.ok(
          !tools.includes(marker),
          `${page} 的顶栏工具区又出现了 ${marker} —— 它只对本工作台有效，放进页面内容区`
        );
      }
    }
  });

  it('the file page keeps its own controls in the content area', function () {
    // 上一条的另一半：收掉不等于删掉。这些控件得在文件页里还在，
    // 只是从外壳挪到了工作台的操作栏和查询栏。
    const src = read('admin.html');
    assert.match(src, /handleWebsite/, '快捷入口应下放到文件页的操作栏');
    assert.match(src, /handleToolkit/, '工具菜单应下放到文件页的操作栏');
    assert.match(src, /handleLoadSettings/, '加载方式应下放到文件页的查询栏');
    assert.match(src, /toggleSafeMode/, '安全模式应下放到文件页的查询栏');
  });
});
