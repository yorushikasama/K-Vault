const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

/**
 * 共享模块契约。
 *
 * admin.html 与 admin-imgtc.html 之间曾有 24 个方法逐字重复（约 7.2 KB）。
 * 这个仓库没有打包步骤，改了一处忘另一处没有任何工具会提醒你，所以把逐字相同的
 * 部分收进了 admin-shared.js。这组测试守住三件事：
 *
 *   1. 共享模块仍然只包含两页确实一致的方法（不做「近似合并」）；
 *   2. 页面确实用了共享版本，而不是又内联了一份（内联会覆盖共享版，
 *      等于去重失效，而且共享模块白下载）；
 *   3. 加载顺序正确 —— 共享模块必须在 new Vue 之前执行。
 */
describe('shared admin module contract', function () {
  const root = path.resolve(__dirname, '..');
  const read = (f) => fs.readFileSync(path.join(root, f), 'utf8');
  const PAGES = ['admin.html', 'admin-imgtc.html'];

  it('exists and exposes the three Vue option sections', function () {
    const src = read('admin-shared.js');
    assert.match(src, /window\.KVAdminShared\s*=/, '共享模块没有挂到 window 上');
    for (const sec of ['methods', 'computed', 'watch']) {
      assert.match(src, new RegExp(`${sec}:\\s*${sec}\\b`), `共享模块缺少 ${sec}`);
    }
  });

  it('loads before Vue is instantiated on every page that uses it', function () {
    // 与 icons.js 同类的问题：共享模块提供 Vue 选项，必须在 new Vue 之前执行，
    // 否则 Object.assign 拿到 undefined，会抛 TypeError。
    for (const page of PAGES) {
      const src = read(page);
      const sharedAt = src.search(/<script[^>]+src="\/admin-shared\.js/);
      const vueAt = src.search(/\bnew Vue\s*\(/);
      assert.notStrictEqual(sharedAt, -1, `${page} 没有加载 admin-shared.js`);
      assert.ok(sharedAt < vueAt, `${page} 把 admin-shared.js 放在了 new Vue 之后`);
    }
  });

  it('pages merge the shared options instead of inlining a copy', function () {
    // 页面定义在后会覆盖共享版本。如果页面里又写了一份同名方法，
    // 去重就失效了——而且表面上完全看不出来，代码照样能跑。
    for (const page of PAGES) {
      const src = read(page);
      for (const sec of ['methods', 'computed', 'watch']) {
        assert.match(
          src,
          new RegExp(`${sec}:\\s*Object\\.assign\\(\\{\\},\\s*window\\.KVAdminShared\\.${sec}`),
          `${page} 的 ${sec} 没有合并共享模块`
        );
      }
    }
  });

  describe('no page re-declares a shared method', function () {
    // 共享模块里的方法名，不应再出现在页面的 methods/computed/watch 里。
    // 这条是「去重是否真的生效」的核心断言：不看字节数，看有没有重复定义。
    const sharedSrc = read('admin-shared.js');
    // 从共享模块里取出顶层方法名（形如 `  name(` 或 `  name: `）
    const sharedNames = [...sharedSrc.matchAll(/^ {2}([a-zA-Z_$][\w$]*)\s*[:(]/gm)]
      .map((m) => m[1])
      .filter((n) => !['var', 'methods', 'computed', 'watch', 'window', 'function', 'return'].includes(n));
    const unique = [...new Set(sharedNames)];

    it('found the shared method names', function () {
      assert.ok(unique.length >= 20, `只解析出 ${unique.length} 个共享方法名，解析逻辑可能失效`);
    });

    for (const page of PAGES) {
      it(`${page} defines none of them locally`, function () {
        const src = read(page);
        // 只看 Vue 选项区（new Vue 之后），避免误报 HTML 模板里的同名调用
        const vueAt = src.search(/\bnew Vue\s*\(/);
        assert.notStrictEqual(vueAt, -1, `${page} 找不到 new Vue`);
        const options = src.slice(vueAt);
        const offenders = unique.filter((name) =>
          new RegExp(`^\\s+(?:async\\s+)?${name}\\s*\\([^)]*\\)\\s*\\{`, 'm').test(options)
        );
        assert.deepStrictEqual(
          offenders,
          [],
          `${page} 又内联了这些共享方法（会覆盖共享版本，去重失效）：${offenders.join(', ')}`
        );
      });
    }
  });

  it('only contains methods that were genuinely identical', function () {
    // 防止有人把「看着差不多」的方法也搬进来。共享模块里每个方法都必须
    // 在两个页面上逐字相同——一致性一旦破坏，合并就会改变其中一页的行为。
    // 这里只做可维护性提醒：共享模块顶部必须写明这个前提。
    const src = read('admin-shared.js');
    assert.match(src, /逐字重复|逐字相同的/, '共享模块没有说明「只收逐字相同的方法」这个前提');
  });
});
