const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

/**
 * 取消选择必须清底层状态，不能只清派生副本。
 *
 * admin-imgtc.html 里 selectedFiles 是 **data**，由 `watch: tableData (deep)`
 * 回填；模板上的勾选标记绑定的是 `item.selected`（el-checkbox 的 v-model、
 * 卡片的 `:class="{ selected: item.selected }"`）。
 *
 * 所以 `this.selectedFiles = []` 只清了派生副本：
 *   - 勾选标记仍在（模板读的是 item.selected）
 *   - tableData 下次有任何深层变动，watch 会按底层 true 值把副本重新填回来
 *     ——表现为「取消选择后又自己选上了」
 *
 * 这个 bug 藏在三个批量操作的收尾处（删除/下载/黑名单），因为它们长得像
 * 「清空一个数组」，看起来无害。admin.html 用的是 clearSelection()，
 * 遍历底层数据置 false，行为正确。
 *
 * 实测（本地浏览器，注入两条数据）：
 *   只清 selectedFiles -> 底层仍有 2 条 true，深层变动后副本回到 2
 *   调 clearSelection  -> 底层 0 条 true，深层变动后仍为 0（与 admin.html 一致）
 */
describe('admin-imgtc clearSelection clears the underlying state', function () {
  const root = path.resolve(__dirname, '..');
  const src = fs.readFileSync(path.join(root, 'admin-imgtc-app.js'), 'utf8');
  const vueAt = src.search(/\bnew Vue\s*\(/);
  const options = vueAt === -1 ? src : src.slice(vueAt);
  // clearSelection 与两个批量方法已升格进 admin-shared.js（两页逐字相同），
  // 「取消选择清底层状态」的守护要查共享模块本体。
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
    const body = m[1];
    // 必须遍历底层数据把 selected 置 false
    assert.match(
      body,
      /tableData[\s\S]{0,80}selected\s*=\s*false/,
      'clearSelection 没有把底层 item.selected 置 false；只清 selectedFiles 会被 deep watch 填回来'
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

  it('keeps the watch handler recomputing from tableData', function () {
    // 这个赋值是**正确的**，不能一起改掉：watch 的职责就是按底层状态重算副本。
    assert.match(
      options,
      /handler\(newData\)\s*\{\s*this\.selectedFiles = newData\.filter\(file => file\.selected\);/,
      'watch.tableData 的 handler 被改动了；它需要按底层 selected 重算 selectedFiles'
    );
  });

  it('does not reintroduce the bare selectedFiles reset', function () {
    // 只允许在 watch handler 里出现 `this.selectedFiles = ...`；
    // 方法体里出现 `= []` 就说明又用清副本代替了清底层。
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
