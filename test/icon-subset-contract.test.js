const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

/**
 * icons-subset.js 取代了全量 Lucide UMD（105 KB gzip -> 11.6 KB gzip）。
 * 代价是漏掉图标不会报错，只会渲染出兜底方块，而且只在真实浏览器里才看得出来。
 * 这组测试把「页面引用的图标名」和「子集里真实存在的图标」钉在一起。
 */
describe('Lucide icon subset contract', function () {
  const root = path.resolve(__dirname, '..');
  const subsetPath = path.join(root, 'icons-subset.js');
  const subset = require(subsetPath);

  const pageFiles = fs
    .readdirSync(root)
    .filter((f) => f.endsWith('.html'))
    .map((f) => path.join(root, f));

  // 与 icons.js / admin.html 里 kv-icon 的 kebab -> PascalCase 规则保持一致。
  function toPascalCase(name) {
    return String(name).replace(/(^|-)([a-z0-9])/g, (_, _dash, letter) => letter.toUpperCase());
  }

  /**
   * 极简 DOM 替身：只实现 createIcons 真正触达的那几个 API
   * （createElementNS / setAttribute / getAttribute / attributes /
   *   appendChild / replaceChild / querySelectorAll('[attr]') / outerHTML）。
   * 为了在 Node 里跑真实渲染路径，不值得为此引入 jsdom。
   */
  function makeTinyDom(iconNames) {
    class El {
      constructor(tag) {
        this.tagName = tag;
        this.children = [];
        this.attrs = {};
        this.parentNode = null;
      }
      setAttribute(k, v) { this.attrs[k] = String(v); }
      getAttribute(k) { return k in this.attrs ? this.attrs[k] : null; }
      get attributes() {
        return Object.keys(this.attrs).map((name) => ({ name, value: this.attrs[name] }));
      }
      appendChild(c) { c.parentNode = this; this.children.push(c); return c; }
      replaceChild(nu, old) {
        const i = this.children.indexOf(old);
        this.children[i] = nu;
        nu.parentNode = this;
        return old;
      }
      get outerHTML() { return `<${this.tagName}>`; }
      querySelectorAll(sel) {
        const attr = /^\[([^\]]+)\]$/.exec(sel);
        const out = [];
        const walk = (n) => n.children.forEach((c) => {
          if (attr && c.getAttribute(attr[1]) !== null) out.push(c);
          walk(c);
        });
        walk(this);
        return out;
      }
    }

    const previousDocument = global.document;
    global.document = { createElementNS: (_ns, tag) => new El(tag) };
    after(function () { global.document = previousDocument; });

    const root = new El('div');
    for (const name of iconNames) {
      const placeholder = new El('i');
      placeholder.setAttribute('data-lucide', name);
      root.appendChild(placeholder);
    }
    return { root, countSvg: () => root.children.filter((c) => c.tagName === 'svg').length };
  }

  it('exposes the same shape as the upstream UMD build', function () {
    assert.strictEqual(typeof subset.createIcons, 'function', 'icons.js 依赖 createIcons 渲染 data-lucide 占位符');
    assert.strictEqual(typeof subset.icons, 'object');
    assert.ok(Object.keys(subset.icons).length > 0, '子集不能是空的');
    // kv-icon 先查 library.icons[key]，查不到再查 library[key]，两条路都得通。
    assert.ok(Array.isArray(subset.icons.House));
    assert.ok(Array.isArray(subset.House));
  });

  it('renders when called the way icons.js calls it', function () {
    // icons.js 调的是 createIcons({ root }) / createIcons({})，从不传 icons。
    // 上游默认参数是 `icons = iconAndAliases`，子集必须保留这个绑定，否则运行时
    // 直接 ReferenceError —— 而静态检查完全看不出来。
    const { root, countSvg } = makeTinyDom(['house', 'x']);
    assert.doesNotThrow(() => subset.createIcons({ root }));
    assert.strictEqual(countSvg(), 2, '占位符没被替换成 svg');
  });

  it('warns instead of throwing on an unknown icon name', function () {
    // CDN 时代漏图标只是控制台告警；子集化不能把它升级成异常。
    const { root } = makeTinyDom(['definitely-not-an-icon']);
    const original = console.warn;
    const warnings = [];
    console.warn = (msg) => warnings.push(msg);
    try {
      assert.doesNotThrow(() => subset.createIcons({ root }));
    } finally {
      console.warn = original;
    }
    assert.strictEqual(warnings.length, 1);
  });

  it('covers every statically referenced data-lucide name', function () {
    const missing = [];
    for (const file of pageFiles) {
      const src = fs.readFileSync(file, 'utf8');
      // 只收静态字面量；:data-lucide="expr" 这类动态绑定在下一个用例里兜。
      for (const m of src.matchAll(/\sdata-lucide="([a-z0-9][a-z0-9-]*)"/g)) {
        const key = toPascalCase(m[1]);
        if (!subset.icons[key]) missing.push(`${path.basename(file)}: ${m[1]}`);
      }
    }
    assert.deepStrictEqual(missing, [], `这些图标名不在子集里，请重跑 node scripts/build-icon-subset.cjs`);
  });

  it('covers every statically referenced kv-icon name', function () {
    const missing = [];
    for (const file of pageFiles) {
      const src = fs.readFileSync(file, 'utf8');
      for (const m of src.matchAll(/<kv-icon[^>]*\sname="([a-z0-9][a-z0-9-]*)"/g)) {
        const key = toPascalCase(m[1]);
        if (!subset.icons[key]) missing.push(`${path.basename(file)}: ${m[1]}`);
      }
    }
    assert.deepStrictEqual(missing, [], `这些图标名不在子集里，请重跑 node scripts/build-icon-subset.cjs`);
  });

  it('covers the names only reachable through runtime expressions', function () {
    // 这些名字来自三元表达式、文件类型映射表和 toast 类型映射，静态扫描看不全，
    // 漏掉任何一个都会让对应交互渲染成兜底方块。
    const dynamic = [
      // 主题切换 / 收藏 / 目录展开的三元分支
      'sun', 'moon', 'folder', 'folder-open', 'bookmark', 'bookmark-check',
      // getToastIcon / getPasteNoticeIcon
      'circle-check', 'circle-x', 'info', 'triangle-alert', 'clipboard', 'clipboard-check',
      // getFileIcon 映射表的值
      'file', 'file-text', 'file-spreadsheet', 'presentation', 'file-archive', 'file-code',
      'file-image', 'file-down', 'file-video-camera', 'audio-lines', 'disc', 'video', 'music',
      // 加载态
      'loader-circle',
    ];
    const missing = dynamic.filter((name) => !subset.icons[toPascalCase(name)]);
    assert.deepStrictEqual(missing, [], '运行时才用到的图标名缺失');
  });

  it('stays in sync with the generator', function () {
    // 生成器是幂等的：源码没变，产物就该一字不差。改了页面图标却忘了重跑会在这里挂。
    const { execFileSync } = require('node:child_process');
    try {
      execFileSync(process.execPath, [path.join(root, 'scripts', 'build-icon-subset.cjs'), '--check'], {
        cwd: root,
        stdio: 'pipe',
      });
    } catch (err) {
      const detail = `${err.stdout || ''}${err.stderr || ''}`.trim();
      assert.fail(`icons-subset.js 与页面源码不同步：${detail}`);
    }
  });

  it('is dramatically smaller than the full upstream bundle', function () {
    const bytes = fs.statSync(subsetPath).size;
    // 全量 UMD 未压缩 444 KB；子集越界说明扫描规则误收了大量图标。
    assert.ok(bytes < 120 * 1024, `icons-subset.js 膨胀到 ${bytes} 字节，检查扫描规则是否误收`);
  });

  it('is referenced by every page that previously loaded the full bundle', function () {
    const expected = [
      'index.html', 'admin.html', 'admin-imgtc.html', 'admin-waterfall.html',
      'gallery.html', 'login.html', 'webdav.html', 'block-img.html', 'whitelist-on.html',
    ];
    for (const page of expected) {
      const src = fs.readFileSync(path.join(root, page), 'utf8');
      assert.match(src, /<script src="\/icons-subset\.js\?v=[a-f0-9]+"><\/script>/, `${page} 没引用图标子集`);
      assert.doesNotMatch(src, /umd\/lucide(\.min)?\.js/, `${page} 还在从 CDN 拉全量 Lucide`);
    }
  });
});
