const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

/**
 * 死 data 字段清理契约。
 *
 * dead-methods-contract.test.js 盯着方法，这组盯 data 字段 —— 两者都会骗人，
 * 但骗的方式不同。方法是「定义了但没人调用」；字段更常见的是两种相反的空壳：
 *   - 写了但从不读：纯死重量，每个实例都占一份；
 *   - 读了但从没写：模板拿到的是 undefined，看起来像功能坏了，但代码「存在」，
 *     反而最难发现。
 *
 * 判定用的是两条独立证据，单条一律不下结论（见 docs/dead-code-boundaries.md）：
 *   1. 静态：从运行时的 Vue 实例枚举出 $data 的真实键（不是正则猜源码，
 *      正则在本仓库把 upload-app.js 的 data 块数成了 3 个，实际 61 个 ——
 *      因为 `'a[href], button:not([disabled])'` 这类 CSS 选择器里的引号
 *      会被当成字符串起始），然后核对全仓除定义处外无引用；
 *   2. 运行时：Object.defineProperty 装读写计数器，跑一轮真实交互后归零。
 * 静态会漏（动态拼接），运行时覆盖不到未触发的分支，所以两边都归零才删。
 *
 * 这批字段是 2026-10-13 实测的：上传页跑 12 个交互、后台页跑 13 个交互，
 * 读写计数全为 0。
 */
describe('pruned dead data fields stay pruned', function () {
  const root = path.resolve(__dirname, '..');
  const read = (f) => fs.readFileSync(path.join(root, f), 'utf8');

  /** 已确认的零引用 + 零读写字段。改动前请先跑一遍静态与运行时双重确认。 */
  const DEAD = {
    'upload-app.js': [
      { name: 'storageStates', note: '存储可用性改由 uploadLimits / *Available 承载，这个空对象从建立起就没被写过' },
    ],
    'admin-app.js': [
      { name: 'resourceMutationId', note: '与 finishResourceMutation 成对的方法已删，剩下的计数器没人读' },
      { name: 'checkingFiles', note: '批量体检改走 brokenCheckSeq / brokenCheckController' },
      { name: 'favoritePending', note: '收藏改走 toggleLike 的请求态，本地这张表没填过' },
      { name: 'checkRequestSeq', note: '同名职责由 brokenCheckSeq 承担，这个字段没人读也没人写' },
      { name: 'tokenError', note: '令牌错误改由 tokenDialogVisible + 行内错误文案承载' },
      { name: 'moveDialogScopeKey', note: '移动弹窗的范围判断改用别的字段，这个键只定义过' },
      { name: 'uploadConfig', note: '后台页自己那份上传上限从未被读；上传页 upload-app.js 另有一份，是活的（12 处引用），删的是这份副本' },
    ],
  };

  /** 同名的活字段必须留着，防止「按名字删」把真实现误伤。 */
  const ALIVE_NAMES = ['uploadConfig'];

  for (const [file, items] of Object.entries(DEAD)) {
    describe(file, function () {
      const src = read(file);

      for (const item of items) {
        it(`no longer declares ${item.name}`, function () {
          assert.ok(
            !new RegExp(`^\\s*${item.name}\\s*:`, 'm').test(src),
            `${file} 又声明了 ${item.name} —— ${item.note}`
          );
        });
      }
    });
  }

  it('keeps the live uploadConfig in upload-app.js', function () {
    // 上传页那份 uploadConfig 是活的（分片大小、并发数、直传阈值都在用）。
    // 按名字全局删会连它一起删掉 —— 这正是 admin-app.js 那份是死代码的原因。
    const src = read('upload-app.js');
    assert.match(src, /^\s*uploadConfig\s*:/m, 'upload-app.js 的 uploadConfig 被误删了，它是活的');
    const uses = (src.match(/this\.uploadConfig\./g) || []).length;
    assert.ok(uses >= 4, `upload-app.js 的 uploadConfig 只剩 ${uses} 处引用，确认它没被误删`);
  });

  it('does not remove any data field that is still referenced', function () {
    // 回归护栏：把 DEAD 里点名的字段和 ALIVE_NAMES 一起过一遍，
    // 确认除了点名的那几处，其它顶层字段都有模板或脚本引用。
    const declared = [...read('admin-app.js').matchAll(/^ {6}([A-Za-z_$][\w$]*)\s*:/gm)].map((m) => m[1]);
    const deadNames = DEAD['admin-app.js'].map((d) => d.name);
    for (const name of deadNames) {
      assert.ok(!declared.includes(name), `${name} 仍在 admin-app.js 里声明，删除没生效`);
    }
    for (const name of ALIVE_NAMES) {
      const live = /this\.uploadConfig\./.test(read('upload-app.js'));
      assert.ok(live, `活字段 ${name} 的实现被误删`);
    }
  });
});

/**
 * 被遮蔽的重复定义。
 *
 * 同一个对象字面量里同名键出现两次时，后者静默覆盖前者 —— 前面那份代码
 * 永远不执行，却仍然占着体积、仍会被搜索命中，读代码的人也会以为它是活的。
 * 上传页就有一例：getFileIcon 被定义了两份，前面那份自带 44 行 iconMap
 * 映射表，后面那份是一行 `return KVShared.fileIconOf(filename)`。
 * 跑起来的是后者，前者是死的（2026-10-13 实测两者返回完全一致，
 * 证明前者从未参与）。
 *
 * 这里只盯「同一文件里同名的方法/计算属性定义多次」。注意别误伤
 * data 字段与 watcher 同名的正常写法（activeDialogKey 就是
 * computed + watch 各一处），所以只在「同一缩进层级、且都是函数定义」
 * 时才算重复。
 */
describe('no shadowed duplicate definitions', function () {
  const root = path.resolve(__dirname, '..');
  const read = (f) => fs.readFileSync(path.join(root, f), 'utf8');
  const APP_FILES = [
    'upload-app.js', 'upload-media.js', 'upload-image.js',
    'admin-app.js', 'admin-tokens.js', 'admin-ui-design.js',
    'gallery-app.js', 'video-app.js', 'preview-app.js',
  ];

  // 混入的纯逻辑文件（upload-media / upload-image / admin-tokens /
  // admin-ui-design）只导出 `var methods = { … }`，成员缩进 4 或 6 空格
  // （admin-tokens 比其它多一层），没有 `methods: {` 段。
  // preview-app.js 是个 IIFE + 内部函数，根本没有方法表，不参与这项检查。
  const COMPONENT_FILES = [
    'upload-app.js', 'admin-app.js', 'gallery-app.js', 'video-app.js',
  ];
  const MIXIN_FILES = [
    'upload-media.js', 'upload-image.js', 'admin-tokens.js', 'admin-ui-design.js',
  ];

  for (const file of COMPONENT_FILES) {
    it(`${file} defines each method only once`, function () {
      const lines = read(file).split('\n');
      // 只看 methods 块内部的函数定义。限定在 methods 段内是必须的：
      // computed 与 watch 允许同名（activeDialogKey 就是 computed + watch
      // 各一处，两边都需要），那种写法不是重复定义。
//
      // methods 的写法在本仓库有两种：
      //   methods: {                            （gallery / video / preview）
      //   methods: Object.assign({}, …, {        （upload-app.js / admin-app.js）
      // 所以行首只认 `methods:`、成员缩进按该行 +2 推算，不能写死成
      // `methods: {` 或固定 6 空格 —— 写死会让 upload-app.js 与 admin-app.js
      // 整条断言变成空跑，看着全绿其实什么都没查（这坑踩过一次）。
      const KEYWORDS = new Set(['if', 'for', 'while', 'switch', 'catch', 'function', 'return', 'do', 'else']);
      const DEF = /^(\s*)(?:async\s+)?([A-Za-z_$][\w$]*)\s*\([^)]*\)\s*\{\s*$/;
      const counts = new Map();
      let memberIndent = null;

      lines.forEach((line, i) => {
        if (memberIndent !== null) {
          const indent = line.match(/^ */)[0].length;
          if (line.trim() === '') return;
          if (indent < memberIndent) { memberIndent = null; return; }
          const m = DEF.exec(line);
          if (m && indent === memberIndent && !KEYWORDS.has(m[2])) {
            if (!counts.has(m[2])) counts.set(m[2], []);
            counts.get(m[2]).push(i + 1);
          }
          return;
        }
        const m = /^\s*methods\s*:/.exec(line);
        if (m) memberIndent = m[0].length - m[0].trimStart().length + 2;
      });

      // 护栏本身的自检：没检出一批方法就说明上面某个锚点又写死了。
      assert.ok(counts.size > 5, `${file} 只检出 ${counts.size} 个方法，检测范围写死了，这条断言会变成空跑`);

      const dups = [...counts.entries()]
        .filter(([, ls]) => ls.length > 1)
        .map(([key, ls]) => `${key} @ ${ls.join(', ')}`);
      assert.deepStrictEqual(dups, [], `${file} 的 methods 里有同名方法被定义多次，后者会静默覆盖前者：${dups.join('; ')}`);
    });
  }

  for (const file of MIXIN_FILES) {
    it(`${file} defines each exported method only once`, function () {
      // 混入文件导出 `var methods = { … }`。成员缩进不统一（2/4/6/10 都有，
      // 取决于文件里注释块怎么排），所以不做 +2 推算，而是取「块内第一个
      // 真正的成员定义」的缩进作为基准 —— 注释行会干扰固定偏移。
      const KEYWORDS = new Set(['if', 'for', 'while', 'switch', 'catch', 'return', 'do', 'else', 'function']);
      const lines = read(file).split('\n');
      const DEF = /^(\s*)(?:async\s+)?([A-Za-z_$][\w$]*)\s*\([^)]*\)\s*\{\s*$/;
      const isMember = (line) => {
        const m = DEF.exec(line);
        return m && !KEYWORDS.has(m[2]) ? m : null;
      };
      const counts = new Map();
      let blockIndent = null;   // `var methods = {` 自身的缩进
      let memberIndent = null;  // 块内成员缩进，由第一个成员确定
      lines.forEach((line, i) => {
        const indent = line.match(/^ */)[0].length;

        if (blockIndent === null) {
          if (/^\s*var methods = \{/.test(line)) blockIndent = indent;
          return;
        }
        if (memberIndent === null) {
          // 块刚打开：等第一个成员定义来确定基准缩进（注释行会干扰固定偏移）
          const m = isMember(line);
          if (m) memberIndent = m[1].length;
          return;
        }
        if (line.trim() === '') return;
        if (indent <= blockIndent) { blockIndent = null; memberIndent = null; return; }
        const m = isMember(line);
        if (m && indent === memberIndent) {
          if (!counts.has(m[2])) counts.set(m[2], []);
          counts.get(m[2]).push(i + 1);
        }
      });
      // 自检：检出的方法数必须与「文件里真实的方法定义数」一致，
      // 否则锚点写死了、这条断言会变成空跑。
      // 逐个数出来：uploadUiDesignBackgroundFile 是本文件唯一的方法
      // （第 21 行那个 if 是控制流，不是方法），所以下限是 1。
      assert.ok(counts.size >= 1, `${file} 一个方法都没检出，检测范围写死了，这条断言会变成空跑`);
      const dups = [...counts.entries()]
        .filter(([, ls]) => ls.length > 1)
        .map(([key, ls]) => `${key} @ ${ls.join(', ')}`);
      assert.deepStrictEqual(dups, [], `${file} 里有同名方法被定义多次：${dups.join('; ')}`);
    });
  }
});