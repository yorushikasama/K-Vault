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
  const html = fs.readFileSync(path.join(root, 'index.html'), 'utf8');
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
});
