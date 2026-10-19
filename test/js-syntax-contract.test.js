const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

/**
 * 全量 JS 语法守卫。
 *
 * 事故背景（2026-10-19，16edc5b）：upload-media.js 的编辑残留了一个多余的
 * `}`，把方法提前闭合，后继 `const` 处于非法位置——整文件 SyntaxError，
 * Vue 应用没挂载，页面全挂。而当时 672 个测试全绿：契约测试全是正则断言
 * （methodBody 抽取片段），行为验证脚本是一次性 .arts 临时件，**没有任何
 * 测试完整解析过这个文件**。正则断言对「结构性括号错配」是瞎的。
 *
 * 本守卫：扫描所有 HTML 引用的本地 JS，用 vm.Script 完整解析（只编译不
 * 执行，无副作用）。任何语法错误在此处 fail，而不是在用户的手机上。
 */
describe('js syntax contract (every shipped script must parse)', function () {
  const root = path.resolve(__dirname, '..');
  const htmlFiles = [
    'index.html', 'admin.html', 'gallery.html', 'video.html',
    'login.html', 'preview.html', 'block-img.html', 'whitelist-on.html',
  ];

  function collectScripts() {
    const seen = new Map();
    for (const page of htmlFiles) {
      const html = fs.readFileSync(path.join(root, page), 'utf8');
      const re = /<script\b[^>]*\bsrc="([^"]+\.js)(?:\?[^"]*)?"[^>]*>/g;
      let m;
      while ((m = re.exec(html))) {
        const src = m[1];
        if (/^https?:|^\/\//.test(src)) continue; // 外链不管
        const rel = src.replace(/^\//, '');
        if (!seen.has(rel)) seen.set(rel, page);
      }
    }
    return [...seen.entries()];
  }

  it('every local JS referenced by the HTML pages parses with V8', function () {
    const scripts = collectScripts();
    assert.ok(scripts.length >= 10, `应至少收集到 10 个本地 JS，实际 ${scripts.length}`);
    const failures = [];
    for (const [rel, page] of scripts) {
      const file = path.join(root, rel);
      if (!fs.existsSync(file)) {
        failures.push(`${rel}（${page} 引用）文件不存在`);
        continue;
      }
      try {
        new vm.Script(fs.readFileSync(file, 'utf8'), { filename: rel });
      } catch (err) {
        failures.push(`${rel}（${page} 引用）:${err.message.split('\n')[0]}`);
      }
    }
    assert.strictEqual(failures.join('\n'), '', `以下脚本存在语法错误：\n${failures.join('\n')}`);
  });
});