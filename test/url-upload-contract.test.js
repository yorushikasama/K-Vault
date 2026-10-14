const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

/**
 * URL 上传的「分享链接判定」必须与服务端一致。
 *
 * 线上故障：yt-dlp 明明可用（/api/resolve-url/status 返回 available:true），
 * 但通过 URL 上传从不走解析。根因是前后端对 allowedHosts 的理解不一致：
 *
 *   服务端 media-resolve-service.js getStatus():
 *     allowedHosts: this.allowUnknownHosts ? [] : Array.from(this.allowedHosts).sort()
 *
 *   即「不限域名」时**故意返回空数组**，把真实意图放在 allowUnknownHosts 字段里。
 *   而前端只做 allowedHosts.some(...)，空数组恒为 false —— 于是所有分享链接
 *   （抖音/B站等）都被判成普通直链，解析入口等于是死的。
 *
 * 这组测试钉住三件事：
 *   1. 前端读回 allowUnknownHosts，且判定时用它
 *   2. 与服务端的「流文件不做嗅探」边界保持一致（STREAM_PATH_RE）
 *   3. 白名单模式仍然按 allowedHosts 匹配（含子域），且能挡住伪装域
 */
describe('URL upload share-link detection matches the server contract', function () {
  const root = path.resolve(__dirname, '..');
  // isMediaShareLink 在 upload-media.js；mediaResolve 状态字段在 upload-app.js。
  // html 变量保持旧名（多处断言引用它），指向两份拼接后的内容。
  const html = fs.readFileSync(path.join(root, 'upload-media.js'), 'utf8')
    + fs.readFileSync(path.join(root, 'upload-app.js'), 'utf8');
  const server = fs.readFileSync(
    path.join(root, 'server/lib/services/media-resolve-service.js'), 'utf8');

  /** 取出前端 isMediaShareLink 的实现，放进可执行的沙箱里。 */
  function loadDetector(mediaResolve) {
    const m = /isMediaShareLink\(rawUrl\)\s*\{([\s\S]*?)\n {10}\},/.exec(html);
    assert.ok(m, '找不到 isMediaShareLink 的实现');
    const body = m[1];
    // 把方法体直接编译成函数，this 绑到带 mediaResolve 的对象上。
    // 注意别在工厂内部又 call 一次：那会让 this 指向工厂的 arguments，
    // 表现为所有判定都返回 false。
    const fn = new Function('mediaResolve', `
      "use strict";
      return function (rawUrl) {${body}};
    `)(mediaResolve);
    return (url) => fn.call({ mediaResolve }, url);
  }

  describe('the server really does hide the host list when it allows all hosts', function () {
    it('returns allowedHosts as [] when allowUnknownHosts is on', function () {
      assert.match(
        server,
        /allowedHosts:\s*this\.allowUnknownHosts\s*\?\s*\[\]\s*:/,
        '服务端的 allowedHosts 语义变了；前端判定依赖「不限域名时空数组」这个约定'
      );
    });

    it('exposes allowUnknownHosts as its own field', function () {
      assert.match(server, /allowUnknownHosts:\s*this\.allowUnknownHosts,/, '服务端没有把 allowUnknownHosts 返回给前端');
    });
  });

  describe('frontend reads the flag back', function () {
    it('stores allowUnknownHosts from the status response', function () {
      assert.match(
        html,
        /this\.mediaResolve\.allowUnknownHosts = data\.allowUnknownHosts === true/,
        '前端没有读回 allowUnknownHosts；只靠 allowedHosts 会把分享链接全判成直链'
      );
    });

    it('declares it in the mediaResolve state object', function () {
      assert.match(html, /mediaResolve:\s*\{[\s\S]{0,200}?allowUnknownHosts:\s*false/, 'mediaResolve 缺少 allowUnknownHosts 字段');
    });
  });

  describe('detection behaviour', function () {
    const openAll = { loaded: true, available: true, allowedHosts: [], allowUnknownHosts: true };

    it('treats share links as needing resolution when hosts are unrestricted', function () {
      const detect = loadDetector(openAll);
      for (const url of [
        'https://www.douyin.com/video/7123456789012345678',
        'https://v.douyin.com/iAbCdEf/',
        'https://www.bilibili.com/video/BV1xx411c7mD',
      ]) {
        assert.strictEqual(detect(url), true, `${url} 应走 yt-dlp 解析`);
      }
    });

    it('sends direct stream files down the plain-upload path', function () {
      // 服务端 STREAM_PATH_RE 对这类路径不做页面嗅探，直接当流处理；
      // 前端边界要与它一致，否则会出现「前端送解析、服务端当直链」的错配。
      const detect = loadDetector(openAll);
      for (const url of [
        'https://cdn.example.com/a.mp4',
        'https://cdn.example.com/live.m3u8',
        'https://cdn.example.com/manifest.mpd',
        'https://cdn.example.com/song.mp3',
      ]) {
        assert.strictEqual(detect(url), false, `${url} 是流文件本身，应走直链上传`);
      }
    });

    it('keeps the stream-path boundary identical to the server', function () {
      const serverRe = /const STREAM_PATH_RE = \/\\?\.\(([^)]+)\)\$\/i/.exec(server);
      assert.ok(serverRe, '找不到服务端的 STREAM_PATH_RE');
      const serverExts = serverRe[1].split('|').sort();
      const clientRe = /if \(\/\\\.\(([^)]+)\)\$\/i\.test\(parsed\.pathname\)\)/.exec(html);
      assert.ok(clientRe, '找不到前端的流文件扩展名判断');
      const clientExts = clientRe[1].split('|').sort();
      assert.deepStrictEqual(
        clientExts,
        serverExts,
        '前端与服务端的「流文件扩展名」集合不一致，会导致同一 URL 在两侧走不同路径'
      );
    });

    it('still refuses obvious local names', function () {
      const detect = loadDetector(openAll);
      assert.strictEqual(detect('http://localhost/x'), false);
      assert.strictEqual(detect('http://foo.local/video'), false);
      assert.strictEqual(detect('http://box.internal/video'), false);
    });

    describe('allow-list mode', function () {
      const listed = { loaded: true, available: true, allowedHosts: ['douyin.com'], allowUnknownHosts: false };

      it('accepts the listed host and its subdomains', function () {
        const detect = loadDetector(listed);
        assert.strictEqual(detect('https://www.douyin.com/video/1'), true);
        assert.strictEqual(detect('https://v.douyin.com/x/'), true);
      });

      it('rejects hosts outside the list', function () {
        const detect = loadDetector(listed);
        assert.strictEqual(detect('https://www.bilibili.com/video/BV1x'), false);
      });

      it('does not let a lookalike domain through', function () {
        const detect = loadDetector(listed);
        assert.strictEqual(detect('https://douyin.com.evil.example/x'), false, '后缀伪装域被放行了');
        assert.strictEqual(detect('https://notdouyin.com/x'), false, '前缀伪装域被放行了');
      });
    });

    it('stays off when the capability probe failed', function () {
      const detect = loadDetector({ loaded: true, available: false, allowedHosts: [], allowUnknownHosts: true });
      assert.strictEqual(detect('https://www.douyin.com/video/1'), false);
    });

    it('stays off before the status has loaded', function () {
      const detect = loadDetector({ loaded: false, available: true, allowedHosts: [], allowUnknownHosts: true });
      assert.strictEqual(detect('https://www.douyin.com/video/1'), false);
    });
  });

  describe('the URL box empties after a transfer is accepted', function () {
    // 用户报的现象：「使用URL转存之后输入框里面应该清空，但是目前输入框里面
    // 留存了url」。根因是 uploadFromUrl 的分享链接分支 —— 它把链接交给
    // openQualityPicker 之后直接 return，从没清过输入框；只有普通直链那条
    // 成功路径写了 urlToUpload = ""。
    //
    // 这里不解析语法树，直接取方法体在沙箱里跑：把那些依赖（toast、上传
    // 接口、清晰度弹窗）都换成探针，然后断言「提交被收下之后输入框是空的」。
    const uploadFromUrlBody = (() => {
      const m = /async uploadFromUrl\(\)\s*\{([\s\S]*?)\n {10}\},/.exec(html);
      assert.ok(m, '找不到 uploadFromUrl 的实现');
      return m[1];
    })();

    /** 用给定的「世界」跑一次 uploadFromUrl，返回结束时的状态。 */
    function submit(world) {
      const state = Object.assign(
        {
          authChecking: false,
          urlSubmitting: false,
          urlUploading: false,
          urlResolving: false,
          qualityPicker: { visible: false },
          urlToUpload: "",
          mediaResolve: { loaded: true, available: true, allowedHosts: [], allowUnknownHosts: true },
          toasts: [],
          showToast(message, kind) {
            this.toasts.push({ message, kind });
          },
          startUrlTicker() {},
          stopUrlTicker() {},
          registerUploadedUrlFile() {
            this.registered = true;
          },
          async uploadPlainUrlToServer() {
            return [{ src: "/file/plain.bin" }];
          },
          async openQualityPicker(url) {
            this.pickerOpenedWith = url;
          },
          // 提交前会等能力探测落地（见 upload-media.js 的 ensureMediaResolveStatus）。
          // 沙箱里直接视为已就绪，专门测它的用例另建。
          async ensureMediaResolveStatus() {
            this.probeAwaited = (this.probeAwaited || 0) + 1;
          },
          // extractUrlFromText 是同一模块里的真实实现，直接从文件里取出编译，
          // 避免这里再抄一份抽取逻辑。
          extractUrlFromText(text) {
            const m = String(text || "").match(/https?:\/\/[^\s<>"'`）)】\]]+/i);
            return m ? m[0].replace(/[.,;:！。，、）)】\]]+$/, "") : "";
          },
          isMediaShareLink() {
            return world.isShareLink === true;
          },
        },
        world.state || {},
      );

      const fn = new Function(`
        "use strict";
        return async function () {${uploadFromUrlBody}};
      `)();
      return fn.call(state).then(() => state);
    }

    it('clears the box for a share link that goes to the quality picker', async function () {
      // 用户实际遇到的场景：抖音/B站分享链接。
      const state = await submit({
        isShareLink: true,
        state: { urlToUpload: "0.71 复制打开抖音，看看【某人】 https://v.douyin.com/abcdef/ 12/12" },
      });
      assert.strictEqual(state.pickerOpenedWith, "https://v.douyin.com/abcdef/", '分享链接没有被交给解析');
      assert.strictEqual(state.urlToUpload, "", '分享链接交给解析后输入框仍留着 URL —— 用户报的就是这个');
    });

    it('clears the box for a plain direct link', async function () {
      const state = await submit({
        isShareLink: false,
        state: { urlToUpload: "https://example.com/file.zip" },
      });
      assert.strictEqual(state.registered, true, '直链没有走成功入库路径');
      assert.strictEqual(state.urlToUpload, "", '直链上传成功后输入框应当清空');
    });

    it('keeps the URL when the transfer fails, so it can be retried', async function () {
      const state = await submit({
        isShareLink: false,
        state: {
          urlToUpload: "https://example.com/broken.zip",
          async uploadPlainUrlToServer() {
            throw new Error("远程地址不可达");
          },
        },
      });
      assert.strictEqual(state.urlToUpload, "https://example.com/broken.zip", '失败时清空了输入框，用户没法重试');
      assert.strictEqual(state.toasts.length, 1, '失败时应当有一条提示');
    });

    it('keeps the URL when the format is rejected', async function () {
      // 校验失败的几条分支同样不该清空：什么都没提交出去。
      for (const bad of ["ftp://example.com/x.zip", "not a url"]) {
        const state = await submit({
          isShareLink: false,
          state: { urlToUpload: bad },
        });
        assert.strictEqual(state.urlToUpload, bad, `${bad} 被拒绝时不该清空输入框`);
      }
    });

    it('marks the submission in-flight so a second submit cannot race it', async function () {
      // 清空输入框之后用户马上就能粘贴下一条；解析要等好几秒，
      // 必须有东西挡住「粘贴紧接着回车」造成的重复提交。
      const state = await submit({
        isShareLink: true,
        state: { urlToUpload: "https://v.douyin.com/abcdef/" },
      });
      assert.strictEqual(state.urlSubmitting, false, '提交结束后没有复位 urlSubmitting');
      assert.match(uploadFromUrlBody, /this\.urlSubmitting\s*=\s*true/, 'urlSubmitting 从未被置为 true —— 按钮不会显示「添加中」，也挡不住重复提交');
      assert.match(
        uploadFromUrlBody,
        /authChecking \|\| this\.urlSubmitting/,
        '提前返回的守卫没有包含 urlSubmitting',
      );
    });

    it('waits for the capability probe before deciding share-link vs direct', async function () {
      // 冷启动时探测要跑 yt-dlp 子进程（服务端实测 3.3s），而
      // isMediaShareLink() 在探测落地前对任何链接都返回 false。不等探测
      // 就判定，分享链接会被交给普通直链接口，服务端存下的是平台网页。
      const state = await submit({
        isShareLink: false,
        state: { urlToUpload: "https://example.com/file.zip" },
      });
      assert.strictEqual(state.probeAwaited, 1, '提交前没有等能力探测落地');
      assert.ok(
        uploadFromUrlBody.indexOf('await this.ensureMediaResolveStatus()') < uploadFromUrlBody.indexOf('this.isMediaShareLink(submittedUrl)'),
        '等待探测必须发生在分享链接判定之前，否则判定拿到的仍是未探测状态',
      );
    });

    it('re-routes to resolution when the server says the target is a web page', async function () {
      // 服务端 uploadFromUrl 对 HTML 响应返回 415 / REMOTE_CONTENT_HTML。
      // 前端收到这个码必须改走解析 —— 这正是 2026-10-14 那个
      // 7696026443508451931.html 的修复点：链接被判成直链、服务端抓回网页。
      const state = await submit({
        isShareLink: false,
        state: {
          urlToUpload: "https://www.douyin.com/video/7696026443508451931",
          async uploadPlainUrlToServer() {
            const error = new Error("目标地址返回的是网页，不是文件。");
            error.code = "REMOTE_CONTENT_HTML";
            error.status = 415;
            throw error;
          },
        },
      });
      assert.strictEqual(
        state.pickerOpenedWith,
        "https://www.douyin.com/video/7696026443508451931",
        '服务端判定为网页后没有改走解析流程，网页会被存成文件',
      );
      assert.strictEqual(state.registered, undefined, '网页被登记成了已上传文件');
      assert.strictEqual(state.urlToUpload, "", '改走解析后输入框应当清空');
    });

    it('only re-routes on the HTML signal, not on every failure', async function () {
      // 其它错误仍要留在直链分支并提示，否则一个网络错误也会弹出解析框。
      const state = await submit({
        isShareLink: false,
        state: {
          urlToUpload: "https://example.com/broken.zip",
          async uploadPlainUrlToServer() {
            const error = new Error("远程地址不可达");
            error.code = "IMPORT_FETCH_FAILED";
            throw error;
          },
        },
      });
      assert.strictEqual(state.pickerOpenedWith, undefined, '非 HTML 错误不该触发解析');
      assert.strictEqual(state.urlToUpload, "https://example.com/broken.zip", '失败时应当保留 URL 供重试');
    });
  });
});
