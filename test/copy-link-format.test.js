const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

/**
 * 复制链接时套的外壳必须与文件类型相符。
 *
 * 用户问「视频这里这个复制格式是什么东西，为什么有这些」。查下来是
 * `formatLink` 把标签写死成了 `<img>`：复制一个 mp4 选 MD，粘出去是
 * `![旅行 vlog.mp4](…mp4)` —— Markdown 会去渲染成一张**图片**，然后裂开。
 * HTML 是 `<img src="…mp4">`，BBCode 是 `[img]…[/img]`，三个都产出坏标记。
 *
 * 这个函数原本只服务图库（那里全是图片，碰巧成立）。视频页沿用之后，
 * 同一件事从「特性」变成「bug」：控件本身没错，错的是它默认了文件类型。
 *
 * 这组测试钉住「标签由类型决定」，并专门钉住不可渲染图片 —— RAW / PSD /
 * tiff / heic 归类是图片，但浏览器画不出来，套 ![](…) 粘出去仍是裂图。
 * 那正是本项目此前拆开「归类 vs 能渲染」的原因，这里必须用同一口径，
 * 否则同一批文件在图库里是占位卡、在复制链接时又变回碎图标记。
 */
describe('copied links are wrapped for their actual file type', function () {
  const root = path.resolve(__dirname, '..');
  const read = (f) => fs.readFileSync(path.join(root, f), 'utf8');
  const shared = read('kv-shared.js');

  /** 在沙箱里求值 formatLink，验证行为而不是源码长相。 */
  const formatLink = (() => {
    global.window = {};
    new Function('window', shared)(global.window);
    return global.window.KVShared.formatLink;
  })();
  const URL_ = 'https://example.test/file/abc';

  describe('each type gets markup that can actually render it', function () {
    it('images keep the original embedding (the gallery depends on it)', function () {
      // 回归护栏：图床是本项目的主场景，这四种产物一个字都不能动。
      assert.strictEqual(formatLink(URL_, '海报.png', 'url'), URL_);
      assert.strictEqual(formatLink(URL_, '海报.png', 'markdown'), `![海报.png](${URL_})`);
      assert.strictEqual(formatLink(URL_, '海报.png', 'html'), `<img src="${URL_}" alt="海报.png">`);
      assert.strictEqual(formatLink(URL_, '海报.png', 'bbcode'), `[img]${URL_}[/img]`);
      assert.strictEqual(formatLink(URL_, '海报.png', 'ubb'), `[IMG]${URL_}[/IMG]`);
    });

    it('videos never get an image tag', function () {
      // 这三条就是用户会实际粘出去的东西。改动任何一个，用户粘进任何
      // 论坛或笔记软件都会看到一张裂图。
      for (const ext of ['mp4', 'mkv', 'webm', 'mov', 'm4v', 'mxf', 'rmvb']) {
        const name = `片段.${ext}`;
        assert.strictEqual(formatLink(URL_, name, 'markdown'), `[${name}](${URL_})`,
          `${ext} 的 Markdown 应是普通链接，不是 ![]() —— 后者会被渲染成裂图`);
        assert.strictEqual(formatLink(URL_, name, 'html'), `<video src="${URL_}" controls></video>`,
          `${ext} 的 HTML 应是 <video>`);
        assert.strictEqual(formatLink(URL_, name, 'bbcode'), `[video]${URL_}[/video]`);
        assert.doesNotMatch(formatLink(URL_, name, 'html'), /<img/,
          `${ext} 绝不能产出 <img>：这是本组测试要防的那个 bug`);
      }
    });

    it('audio gets an audio tag, not an image tag', function () {
      for (const ext of ['mp3', 'flac', 'm4a', 'opus', 'aiff']) {
        const name = `曲目.${ext}`;
        assert.strictEqual(formatLink(URL_, name, 'html'), `<audio src="${URL_}" controls></audio>`);
        assert.strictEqual(formatLink(URL_, name, 'bbcode'), `[audio]${URL_}[/audio]`);
        assert.doesNotMatch(formatLink(URL_, name, 'markdown'), /^\!/,
          `${ext} 的 Markdown 不该带 ! 前缀`);
      }
    });

    it('documents get a download link rather than an inline embed', function () {
      // 文档没有「内联显示」这个概念。套 <img> 只会裂，退回链接才是能用的产物。
      for (const ext of ['pdf', 'zip', 'epub', 'dwg', 'glb']) {
        const name = `文档.${ext}`;
        assert.strictEqual(formatLink(URL_, name, 'html'), `<a href="${URL_}">${name}</a>`);
        assert.strictEqual(formatLink(URL_, name, 'markdown'), `[${name}](${URL_})`);
      }
    });

    it('undecodable images fall back to a link, not a broken image', function () {
      // RAW / PSD / tiff / heic 是图片没错，但浏览器画不出来。套 ![](…)
      // 粘出去是裂图 —— 与图库卡片、preview 页用同一个口径，那两处已经
      // 给占位卡了。三处口径不一致的话，同一个文件在图库里是占位卡、
      // 复制链接时又变回碎图标记。
      for (const ext of ['cr3', 'nef', 'arw', 'dng', 'raw', 'psd', 'ai', 'tiff', 'heic', 'jxl']) {
        const name = `照片.${ext}`;
        const md = formatLink(URL_, name, 'markdown');
        assert.ok(!md.startsWith('!'),
          `${ext} 浏览器解不了码，Markdown 不得带 ! 前缀（会渲染成裂图），实际得到 ${md}`);
        assert.strictEqual(md, `[${name}](${URL_})`);
        assert.match(formatLink(URL_, name, 'html'), /^<a href=/,
          `${ext} 的 HTML 应是下载链接`);
      }
    });

    it('extension matching is case-insensitive', function () {
      assert.strictEqual(formatLink(URL_, 'A.MP4', 'markdown'), `[A.MP4](${URL_})`);
      assert.strictEqual(formatLink(URL_, 'A.PNG', 'markdown'), `![A.PNG](${URL_})`);
      assert.strictEqual(formatLink(URL_, 'A.CR3', 'markdown'), `[A.CR3](${URL_})`);
    });
  });

  describe('unknown formats stay a bare link', function () {
    it('returns the raw URL for url and anything unrecognised', function () {
      // 多套一层壳对用户没有价值 —— 只有他明确选了某种格式才该包。
      for (const format of ['url', 'plain', '', undefined, null, 'yaml', 'ubb2']) {
        assert.strictEqual(formatLink(URL_, '任意.mp4', format), URL_,
          `格式 ${JSON.stringify(format)} 应当返回裸链接`);
      }
    });

    it('a nameless file does not break', function () {
      // 无扩展名判成 document，产出下载链接；不能是 ![](…) —— 那等于凭空的
      // 图片标记，粘出去必然裂。
      assert.strictEqual(formatLink(URL_, '', 'markdown'), `[](${URL_})`);
      assert.strictEqual(formatLink(URL_, '', 'html'), `<a href="${URL_}"></a>`);
      assert.doesNotThrow(() => formatLink(URL_, undefined, 'html'));
      assert.doesNotThrow(() => formatLink(URL_, null, 'bbcode'));
    });
  });

  describe('every caller passes a filename, not a storage key', function () {
    /* formatLink 靠 name 的扩展名判类型。若调用方传了 key
     * （telegram_1791733102845_n2f75p.mp4 / webdav:xxx.jpg 这类存储标识），
     * 类型仍可能判对，但标签里的 alt/文字会变成没人看得懂的内部串。
     * 四个调用方都必须传 metadata.fileName。 */
    const files = {
      'admin-shared.js': read('admin-shared.js'),
      'gallery-app.js': read('gallery-app.js'),
      'video-app.js': read('video-app.js'),
      'upload-app.js': read('upload-app.js'),
    };

    it('admin passes the display filename in all three of its call sites', function () {
      const src = files['admin-shared.js'];
      const calls = [...src.matchAll(/KVShared\.formatLink\([^)]*\)/g)].map((m) => m[0]);
      assert.ok(calls.length >= 3, `只找到 ${calls.length} 个调用点`);
      for (const call of calls) {
        assert.match(call, /\bname\b/,
          `admin 的调用没传 name：${call} —— 标签里的 alt 会变成存储标识`);
      }
      assert.match(src, /const name = file\?\.metadata\?\.fileName \|\| key;/,
        'admin 的 name 应来自 metadata.fileName');
    });

    it('gallery and video both derive the name from metadata', function () {
      for (const f of ['gallery-app.js', 'video-app.js']) {
        assert.match(
          files[f],
          /const name = \w+\.metadata\?\.fileName \|\| \w+\.name;/,
          `${f} 的复制名应取 metadata.fileName`
        );
      }
    });

    it('upload passes a name derived from fileName or url path', function () {
      assert.match(
        files['upload-app.js'],
        /KVShared\.formatLink\(this\.getCleanFileUrl\(file\), this\.getDisplayName\(file\)/,
        'upload 应传 getDisplayName(file)'
      );
    });
  });

  describe('the type lists stay the single source', function () {
    it('embeds resolve through the shared extension lists, not a local copy', function () {
      assert.match(
        shared,
        /if \(VIEWABLE_IMAGE_EXTS\.indexOf\(ext\) !== -1\) return "image";/,
        '图片判定要用可渲染子集 —— 与图库卡片、preview 页同一口径'
      );
      assert.match(shared, /if \(VIDEO_EXTS\.indexOf\(ext\) !== -1\) return "video";/);
      assert.match(shared, /if \(AUDIO_EXTS\.indexOf\(ext\) !== -1\) return "audio";/);
      // 归类清单只用于「是不是图片」，不用于「能不能内联显示」。
      assert.doesNotMatch(
        shared,
        /if \(IMAGE_EXTS\.indexOf\(ext\) !== -1\) return "image";/,
        'linkEmbedKind 若按归类清单判图片，RAW 又会变回碎图标记'
      );
    });
  });
});