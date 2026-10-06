const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

/**
 * 文件类型筛选器不能因越界值崩溃。
 *
 * 线上事故：admin-imgtc.html 的 fileType 会从 localStorage 读回旧值，
 * 而早期版本支持过 "all"（现在只保留 image/video/audio/document 四类）。
 * 用户的浏览器里存着 "all"，加载后：
 *
 *   filteredTableData: this.fileConfig['all'].exts  → TypeError
 *   switchFileType:    this.fileConfig['all'].name  → TypeError
 *
 * 后果是文件列表整段渲染不出来（filter 回调抛错 → computed 求值失败）。
 * 在线上用 19 条真实数据复现过；本地空列表时测不出来，因为 filter 回调不执行。
 *
 * 注意 admin.html 与 admin-imgtc.html 在这里**有意不同**：admin.html 的
 * fileConfig 里真的有 all 键，所以它必须继续支持 'all'。这组测试只约束
 * admin-imgtc.html，别把两页当成同一份代码来改。
 */
describe('admin-imgtc file type filter tolerates out-of-range values', function () {
  const root = path.resolve(__dirname, '..');
  const src = fs.readFileSync(path.join(root, 'admin-imgtc.html'), 'utf8');
  const vueAt = src.search(/\bnew Vue\s*\(/);
  const options = vueAt === -1 ? src : src.slice(vueAt);

  it('does not index fileConfig with an unchecked fileType', function () {
    // 找出所有 `this.fileConfig[this.fileType].属性` 的写法，逐个判断是否安全。
    // 有两处是合法的，不能一棍子打死：
    //   - filteredTableData 里 `const config = this.fileConfig[this.fileType]`
    //     紧接着就判空（!config || ...），取出来本身不危险
    //   - switchFileType 里的消息模板，上一行已把 this.fileType 规整成合法值
    // 所以这里只针对「直接从下标取属性」这一种形态告警。
    const lines = options.split('\n');
    const offenders = [];
    lines.forEach((line, i) => {
      if (!/this\.fileConfig\[this\.fileType\]\s*\./.test(line)) return;
      // 消息模板里连用两次，且所在函数开头有 hasOwnProperty 校验 -> 安全
      const fnStart = options.lastIndexOf('\n      ', options.indexOf(line)) ;
      const context = options.slice(Math.max(0, fnStart - 2000), options.indexOf(line) + line.length);
      const guarded = /hasOwnProperty\.call\(this\.fileConfig,\s*type\)/.test(context);
      if (guarded) return;
      offenders.push(`${i + 1}: ${line.trim().slice(0, 90)}`);
    });
    assert.deepStrictEqual(
      offenders,
      [],
      '这些地方未经校验就索引 fileConfig[fileType]；' +
      'fileType 可能来自 localStorage 的历史值（如 "all"），会抛 TypeError'
    );
  });

  it('guards switchFileType against an unknown type', function () {
    // 必须先判断这个键存在，再使用；否则用户带着旧 localStorage 打开就崩。
    assert.match(
      options,
      /Object\.prototype\.hasOwnProperty\.call\(this\.fileConfig,\s*type\)/,
      'switchFileType 没有校验 type 是否属于 fileConfig'
    );
  });

  it('keeps the fileConfig lookup result guarded in the filter', function () {
    // filteredTableData 里取出 config 之后必须判空再用。
    assert.match(options, /const config = this\.fileConfig\[this\.fileType\]/, '筛选逻辑没有先把 config 取出来');
    assert.match(options, /!config \|\| config\.exts\.includes\(ext\)/, 'config 为空时没有兜底');
  });

  describe('the four real type keys still work', function () {
    // 防止上面几处防御改过头，把正常筛选也一起短路掉。
    it('still defines exactly the four supported types', function () {
      const keys = [...options.matchAll(/^\s{8}(image|video|audio|document):\s*\{/gm)].map((m) => m[1]);
      assert.deepStrictEqual(
        [...new Set(keys)].sort(),
        ['audio', 'document', 'image', 'video'],
        'fileConfig 的类型键变了；这些防御的前提是只有这四种类型'
      );
    });

    it('still has exts for every type', function () {
      for (const type of ['image', 'video', 'audio', 'document']) {
        const at = options.search(new RegExp(`^\\s{8}${type}:\\s*\\{`, 'm'));
        assert.notStrictEqual(at, -1, `fileConfig 缺少 ${type}`);
        const block = options.slice(at, at + 600);
        assert.match(block, /exts:\s*\[/, `${type} 缺少 exts 列表，筛选会失效`);
      }
    });
  });

  describe('admin.html keeps its own "all" support', function () {
    // 两页共用 localStorage 的 fileType 键，但键集不同。admin.html 确实支持
    // "all"，改动前先读这段注释，别为了「统一」把它的能力削掉。
    const admin = fs.readFileSync(path.join(root, 'admin.html'), 'utf8');
    it('still declares all in fileConfig', function () {
      assert.match(admin, /^\s{8}all:\s*\{/m, 'admin.html 的 fileConfig 少了 all 键；它依赖这个键支持「全部」筛选');
    });
  });
});
