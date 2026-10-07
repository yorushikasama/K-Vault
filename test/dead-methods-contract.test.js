const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

/**
 * 死方法清理契约。
 *
 * 这几页各自内联了一份 3000 行左右的 Vue 选项，随迭代长出过一批「定义了但没人调用」
 * 的方法——迁移到 Lucide 后废弃的图标类名方法、上传入口改造后遗留的 handler 等。
 * 它们不影响运行，但会让人误以为某功能还在（比如 uploadFiles 还在，实际上传入口
 * 早已改成跳转上传中心），也让后续重构难以判断哪些能改。
 *
 * 这组测试钉住两件事：
 *   1. 已删的方法不许回来（回来通常意味着「想恢复某功能却只加了方法名」）；
 *   2. 删的时候不能伤到同名但属于别的页面的实现。
 *
 * 判定一个方法是不是死代码，需要两条独立证据：
 *   - 静态：全仓搜索，除了定义本身没有任何出现
 *   - 运行时：浏览器里挂计数器跑一轮交互，计数为 0
 * 单靠静态会漏掉动态调用，单靠运行时覆盖不到未触发的分支，所以只删两边都确认的。
 */
describe('pruned dead methods stay pruned', function () {
  const root = path.resolve(__dirname, '..');
  const read = (f) => fs.readFileSync(path.join(root, f), 'utf8');

  /** name -> 定义它的页面。注意同名可能属于不同页面的独立实现。 */
  const REMOVED = {
    'admin.html': [
      'uploadFiles',
      'showLoginBackgroundSettings',
      'beginResourceMutation',
      'finishResourceMutation',
      'shouldShowImage',
      'viewModeIcon',
    ],
    'admin-imgtc.html': ['uploadFiles'],
    'index.html': [
      'getFileIconClass',
      'getCleanFilePath',
      'formatBytes',
      'getStatusText',
      'imageCompressPanelExpanded',
      'previewImage',
      'uploadPendingCompressed',
      'uploadPendingOriginal',
    ],
  };

  for (const [page, names] of Object.entries(REMOVED)) {
    describe(page, function () {
      const src = read(page);
      // 只看 Vue 选项区，避免把模板里的同名 DOM 属性误判成方法定义
      const vueAt = src.search(/\bnew Vue\s*\(/);
      const options = vueAt === -1 ? src : src.slice(vueAt);

      for (const name of names) {
        it(`does not define ${name} again`, function () {
          const defRe = new RegExp(`^[ \\t]+(?:async\\s+)?${name}\\s*\\([^)]*\\)\\s*\\{`, 'm');
          assert.doesNotMatch(
            options,
            defRe,
            `${page} 又重新定义了 ${name}。如果是有意恢复某功能，请一并把调用方和入口补上；` +
            `只加方法不改调用方等于没恢复。`
          );
        });
      }
    });
  }

  describe('same-named methods that belong to other pages are untouched', function () {
    // 清理时最容易误伤的就是同名方法。这两处必须保留。
    it('keeps gallery.html previewImage (its own implementation, wired to the template)', function () {
      const src = read('gallery.html');
      assert.match(src, /^\s+previewImage\s*\([^)]*\)\s*\{/m, 'gallery.html 的 previewImage 被误删了');
      assert.match(src, /@click\.stop="previewImage\(/, 'gallery 模板里还在调用 previewImage，实现不能删');
    });

    it('keeps webdav.html uploadFiles (standalone function, has call sites)', function () {
      const src = read('webdav.html');
      assert.match(src, /function uploadFiles\s*\(/, 'webdav.html 的 uploadFiles 被误删了');
      assert.match(src, /uploadFiles\(\)\.catch/, 'webdav 里还有调用点，实现不能删');
    });
  });

  /**
   * 反向检查：模板与代码引用了、但 Vue 选项里没有定义的方法。
   *
   * 2026-10 实测踩过：3257348 引入上传队列时写了调用点
   *   `await this.uploadRemoteTask(item, signal)`
   * 和模板绑定 `@click="cancelQualityPicker"`（三处），却从没写实现。
   * 于是粘贴抖音链接后 this.uploadRemoteTask 是 undefined，调用即抛
   * TypeError；模板那三处点击同样抛。服务端其实已经返回 200
   * （nginx access 里有 POST /api/resolve-url 200），页面却一直转圈——
   * nginx 日志看起来一切正常，只有黑盒点一次才能发现。
   *
   * 死方法测试抓不到这一类：它只钉「删掉的别回来」，不查「引用的有没有」。
   */
  describe('no template or code reference points at a missing method', function () {
    const PAGES = ['index.html', 'gallery.html', 'webdav.html', 'admin.html',
      'admin-imgtc.html', 'admin-waterfall.html', 'preview.html',
      'block-img.html', 'whitelist-on.html'];

    for (const page of PAGES) {
      it(`${page} defines everything it references`, function () {
        const src = read(page);
        const vueAt = src.search(/\bnew Vue\s*\(/);
        const options = vueAt === -1 ? src : src.slice(vueAt);

        // 方法/computed 定义：选项区里 `name(...) {` 或 `name() {`
        const defined = new Set();
        for (const m of options.matchAll(/^[ \t]+(?:async\s+)?([A-Za-z_$][\w$]*)\s*\([^)]*\)\s*\{/gm)) {
          defined.add(m[1]);
        }

        // data() 与 computed() 的键也是合法引用目标。两种缩进都要认：
        //   data: { urlToUpload: "" }     —— 8 空格
        //   urlToUpload: "",              —— 10 空格（选项对象内部）
        for (const m of options.matchAll(/^[ \t]{6,10}([A-Za-z_$][\w$]*)\s*[:(]/gm)) {
          defined.add(m[1]);
        }

        // 引用点：this.foo(...) 与模板 @click/@input 等指令
        const referenced = new Set();
        for (const m of src.matchAll(/this\.([A-Za-z_$][\w$]*)\s*\(/g)) referenced.add(m[1]);
        for (const m of src.matchAll(/@(?:click|input|change|submit|keyup|keydown|focus|blur|close|cancel|paste|drop|dragover|error|contextmenu)(?:\.[\w-]+)?="([A-Za-z_$][\w$]*)/g)) {
          referenced.add(m[1]);
        }

        // Vue 与 Element UI 挂在原型上的成员，以及 admin-shared.js 以 mixin
        // 形式注入的方法，都不是本页自己定义的，不算缺失。
        const EXTERNAL = new Set([
          '$nextTick', '$set', '$delete', '$forceUpdate', '$watch', '$emit', '$refs', '$el',
          '$confirm', '$message', '$alert', '$prompt', '$notify', '$loading', '$msgbox',
          // 模板作用域里的局部变量，不是方法引用
          '$event', '$refs',
        ]);
        const sharedSrc = read('admin-shared.js');
        for (const m of sharedSrc.matchAll(/^[ \t]+(?:async\s+)?([A-Za-z_$][\w$]*)\s*\([^)]*\)\s*\{/gm)) {
          EXTERNAL.add(m[1]);
        }

        const missing = [...referenced].filter((name) => !defined.has(name) && !EXTERNAL.has(name));
        assert.deepStrictEqual(
          missing,
          [],
          `${page} 引用了未定义的方法：${missing.join(', ')}。` +
            `调用即抛 TypeError 且不报错——点一次才看得出来。`
        );
      });
    }
  });

  describe('computed properties are never assigned directly', function () {
    // urlUploading / urlResolving / urlStage 是 computed（由 uploadingFiles 推导），
    // 旧代码却在 12 处写 `this.urlResolving = false`。Vue 2 对 computed 赋值会
    // 静默忽略并在控制台报警告，赋值根本不生效，于是转��结束后的清理全部失效，
    // 界面一直显示「等待中」。这类错误没有任何运行时症状，只能静态查。
    it('index.html has no `this.<computed> =` assignments', function () {
      const src = read('index.html');
      const computedNames = new Set();
      for (const m of src.matchAll(/^\s{10}([A-Za-z_$][\w$]*)\s*\(\)\s*\{/gm)) {
        // 只取 computed 段（第 749 行附近）里的无参 getter
        computedNames.add(m[1]);
      }
      const offenders = [];
      for (const name of computedNames) {
        if (new RegExp(`this\\.${name}\\s*=`).test(src)) offenders.push(name);
      }
      assert.deepStrictEqual(
        offenders,
        [],
        `对这些 computed 直接赋值无效：${offenders.join(', ')}。要改状态请改它依赖的数据源。`
      );
    });
  });

  describe('the pruning script can verify its own work', function () {
    it('is runnable in check mode without a parser', function () {
      // 删除模式依赖 acorn（可选依赖，不写进 package.json），
      // 但 --check 必须只靠字符串就能跑，否则 CI 上会因缺依赖失败。
      const script = read('scripts/prune-dead-methods.cjs');
      assert.match(script, /--check/, '脚本没有 --check 模式');
      assert.match(script, /只校验（CI 用，不需要 acorn）/, '没有说明 --check 不需要解析器');
      assert.match(script, /双?重?确认|运行时/, '没有写明判定依据包含运行时验证');
    });
  });
});
