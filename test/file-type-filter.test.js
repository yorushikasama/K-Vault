const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

/**
 * 文件类型筛选器不能因越界值崩溃。
 *
 * 线上事故：`fileType` 从 localStorage 读回旧值，而早期版本支持过若干后来
 * 被删掉的类型键。用户的浏览器里存着那些值，加载后：
 *
 *   filteredTableData: this.fileConfig[this.fileType].exts  → TypeError
 *
 * 后果是文件列表整段渲染不出来（filter 回调抛错 → computed 求值失败）。
 * 当时用 19 条真实数据在本地复现过；空列表时测不出来，因为 filter 回调不执行。
 *
 * 这条测试原先只约束旧版图床页，因为只有那个页面的 fileConfig 没有 'all' 键、
 * 才会被 localStorage 残留值击穿。那个页面已下线，但文件工作台有同一个隐患：
 * admin-app.js 第 306 行 `this.fileConfig[this.fileType].exts` 同样不判空，
 * 而 fileType 同样从 localStorage 读。所以守护改挂在主后台上 —— 被测的代码
 * 换了，活着的 bug 没换。
 */
describe('file type filter tolerates out-of-range values', function () {
  const root = path.resolve(__dirname, '..');
  const src = fs.readFileSync(path.join(root, 'admin-app.js'), 'utf8');
  const vueAt = src.search(/\bnew Vue\s*\(/);
  const options = vueAt === -1 ? src : src.slice(vueAt);

  it('never indexes fileConfig with an unchecked fileType', function () {
    // `this.fileConfig[this.fileType].属性` 这种「直接下标取属性」是危险形态：
    // 键不存在时取到 undefined，再取 .exts 就是 TypeError。
    // 安全写法有两种，都不算违规：
    //   - 先 const config = this.fileConfig[x]，紧接着判空再用
    //   - 所在函数开头用 hasOwnProperty 把值规整成合法键
    //
    // 先剥注释再扫：这个 bug 的说明文字本身就要写出这串代码形态，
    // 不剥的话解释它的注释会被当成一处违规。
    const codeOnly = options
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .replace(/^[ \t]*\/\/.*$/gm, '');
    const lines = codeOnly.split('\n');
    const offenders = [];
    lines.forEach((line, i) => {
      // 直接 `fileConfig[x].prop` 是危险形态；先取到局部变量、下一行判空的
      // 那种不在这条正则里匹配，所以只抓真正「一步到位」的写法。
      if (!/this\.fileConfig\[this\.fileType\]\s*\./.test(line)) return;
      const at = codeOnly.indexOf(line);
      const fnStart = codeOnly.lastIndexOf('\n      ', at);
      const context = codeOnly.slice(Math.max(0, fnStart - 2500), at + line.length);
      const guarded = /hasOwnProperty\.call\(\s*this\.fileConfig/.test(context);
      if (guarded) return;
      offenders.push(`${i + 1}: ${line.trim().slice(0, 90)}`);
    });
    assert.deepStrictEqual(
      offenders,
      [],
      '这几处未校验就 fileConfig[fileType].xxx。fileType 来自 localStorage，' +
        '浏览器里可能存着旧版本留下的键 —— 读到 undefined 再取属性就是 TypeError，' +
        '整个文件列表渲染不出来。\n  ' + offenders.join('\n  ')
    );
  });

  it('does not restore fileType from localStorage without validating it', function () {
    // 真正的防线：恢复设置时把值规整成 fileConfig 里确实存在的键。
    // 原样读回的写法就是当年那次线上事故。
    assert.doesNotMatch(
      options,
      /this\.fileType\s*=\s*localStorage\.getItem\(\s*'fileType'\s*\)/,
      "fileType 仍是从 localStorage 原样读回；越界值会一路进到 fileConfig[fileType]"
    );
  });

  it('validates the restored value against fileConfig', function () {
    const validating = /hasOwnProperty\.call\(\s*this\.fileConfig/.test(options);
    if (validating) {
      assert.ok(true, '已用 hasOwnProperty 规整 localStorage 读回的 fileType');
      return;
    }
    // 退一步的接受形态：显式列出允许的键。
    assert.ok(
      /fileType\s*=\s*\[?\s*'(all|image|video|audio|document)'/.test(options),
      '恢复 fileType 时既没有 hasOwnProperty 校验，也没有列出允许的键'
    );
  });

  describe('the real type keys still work', function () {
    // 防止上面几处防御改过头，把正常筛选也一起短路掉。
    it('still declares all, image, video, audio and document', function () {
      const keys = [...options.matchAll(/^\s{8}(all|image|video|audio|document):\s*\{/gm)].map((m) => m[1]);
      assert.deepStrictEqual(
        [...new Set(keys)].sort(),
        ['all', 'audio', 'document', 'image', 'video'],
        'fileConfig 的类型键变了；这组防御的前提是只有这五种类型'
      );
    });

    it('still has exts for every non-all type', function () {
      for (const type of ['image', 'video', 'audio', 'document']) {
        const at = options.search(new RegExp(`^\\s{8}${type}:\\s*\\{`, 'm'));
        assert.notStrictEqual(at, -1, `fileConfig 缺少 ${type}`);
        assert.match(options.slice(at, at + 600), /exts:\s*\[/, `${type} 缺少 exts 列表，筛选会失效`);
      }
    });

    it('keeps "all" usable, since the type dropdown depends on it', function () {
      // admin.html 的 fileConfig 里真的有 all 键，「全部类型」选项就是它。
      // 为了防越界而把 all 删掉，会让筛选永远落到 document 分支。
      assert.match(options, /^\s{8}all:\s*\{/m, 'fileConfig 少了 all 键');
      assert.match(options, /this\.fileType === 'all'/, '筛选逻辑没有处理 all 分支');
    });
  });
});