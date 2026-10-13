const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

/**
 * 取消选择必须清底层状态，不能只清派生副本。
 *
 * 模板上的勾选标记绑定的是 `item.selected`（el-checkbox 的 v-model、
 * 卡片的 `:class="{ selected: item.selected }"`），所以
 * `this.selectedFiles = []` 只清了派生视图，勾选标记还在。
 *
 * 这个 bug 曾藏在三个批量操作的收尾处（删除/下载/黑名单），因为它们长得像
 * 「清空一个数组」，看起来无害。正确写法是 clearSelection()：遍历底层数据
 * 把 selected 置 false。
 *
 * 这份测试原先对照两个页面：文件工作台用 `computed` 派生 selectedFiles，
 * 旧版图床页用 `data` + `watch: tableData (deep)` 回填。后者已下线，而
 * 「只清副本」的坑在两个页面上都成立 —— 差别只在派生方式。所以下面两条
 * 断言改成按各自真实的派生机制来查，而不是照抄旧版页面的写法。
 */
describe('clearSelection clears the underlying state', function () {
  const root = path.resolve(__dirname, '..');
  const src = fs.readFileSync(path.join(root, 'admin-app.js'), 'utf8');
  const vueAt = src.search(/\bnew Vue\s*\(/);
  const options = vueAt === -1 ? src : src.slice(vueAt);
  // clearSelection 与两个批量方法在 admin-shared.js 里 —— 页面通过
  // Object.assign 把它们并进自己的 methods，所以守护要查共享模块本体。
  const shared = fs.readFileSync(path.join(root, 'admin-shared.js'), 'utf8');

  it('defines clearSelection', function () {
    assert.match(
      shared,
      /^[ \t]+clearSelection\(\)\s*\{/m,
      'admin-shared.js 缺少 clearSelection 方法'
    );
  });

  it('makes clearSelection reset the underlying items, not just the derived array', function () {
    const m = /^[ \t]+clearSelection\(\)\s*\{([\s\S]*?)\n[ \t]{2}\}/m.exec(shared);
    assert.ok(m, '找不到 clearSelection 的函数体');
    // 必须遍历底层数据把 selected 置 false
    assert.match(
      m[1],
      /tableData[\s\S]{0,80}selected\s*=\s*false/,
      'clearSelection 没有把底层 item.selected 置 false；只清 selectedFiles 会让勾选标记残留'
    );
  });

  describe('batch operations clean up through clearSelection', function () {
    // 这三处原本写成 this.selectedFiles = []，是实际出问题的地方。
    // handleBatchDelete 仍在页面 app 文件；另外两个已并入共享模块。
    const callSites = [
      ['handleBatchDelete', /handleBatchDelete\(\)\s*\{[\s\S]*?\n[ \t]{6}\}/, options],
      ['handleBatchDownload', /handleBatchDownload\(\)\s*\{[\s\S]*?\n[ \t]{2}\}/, shared],
      ['handleBatchBlockOrUnblock', /handleBatchBlockOrUnblock\([\s\S]*?\n[ \t]{2}\}/, shared],
    ];
    for (const [name, re, haystack] of callSites) {
      it(`${name} calls clearSelection`, function () {
        const m = re.exec(haystack);
        assert.ok(m, `找不到 ${name}`);
        assert.match(m[0], /this\.clearSelection\(\)/, `${name} 没有调用 clearSelection`);
      });
    }
  });

  it('derives selectedFiles from the underlying selected flags', function () {
    // 文件工作台用 computed，而不是 data + watch。这条派生是「正确」的，
    // 不能一起改成清副本：它保证了任何地方改 item.selected 都会立刻反映到
    // selectedFiles 上。旧版图床页当年用 watch 慢慢回填，正是因为副本会
    // 跟底层状态脱节才出的那个 bug。
    assert.match(
      options,
      /selectedFiles\(\)\s*\{\s*return this\.tableData\.filter\(file => file\.selected\);/,
      'selectedFiles 应当由 computed 从底层 selected 派生；改回 data + watch 会让副本与底层脱节'
    );
  });

  it('does not reintroduce the bare selectedFiles reset', function () {
    // `this.selectedFiles = []` 出现在方法体里，就说明又用清副本代替了清底层。
    // 先剥掉注释，否则解释这个 bug 的文字本身会被匹配到。
    const codeOnly = options
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .replace(/^[ \t]*\/\/.*$/gm, '');
    const bad = [...codeOnly.matchAll(/this\.selectedFiles\s*=\s*\[\]/g)];
    assert.deepStrictEqual(
      bad,
      [],
      '又出现了 this.selectedFiles = []（注释外）；应改为 this.clearSelection()，否则勾选状态会残留'
    );
  });
});