const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

/**
 * 视频库页与图库页必须保持同一套推导逻辑。
 *
 * 视频库是照着图库的结构新建的：同一个数据源（/api/manage/list）、
 * 同样的四层派生链、同样的计数口径。这么做的前提是两边不会各自漂移 ——
 * 图库页当初的 bug 正是"同一个概念被实现多次"造成的：页头数 images.length
 * （不过滤的原始列表），正文数 filteredImages.length（过滤后的），两个数字
 * 各自都对，放在一起自相矛盾。
 *
 * 所以这里不比"文案像不像"，而是比结构：哪些层存在、每层管什么、计数从哪来。
 * 任何一边改了派生链而另一边没跟上，这组测试会失败。
 */
describe('video library mirrors the gallery derivation chain', function () {
  const root = path.resolve(__dirname, '..');
  const read = (f) => fs.readFileSync(path.join(root, f), 'utf8');
  const videoApp = read('video-app.js');
  const videoHtml = read('video.html');
  const videoCss = read('video.css');
  const galleryApp = read('gallery-app.js');
  const galleryHtml = read('gallery.html');
  const shared = read('kv-shared.js');
  const apiList = read('functions/api/manage/list.js');
  const adminApp = read('admin-app.js');
  const adminHtml = read('admin.html');

  /** 取一个 computed 属性的方法体，按缩进定位（两页缩进一致）。 */
  function bodyOf(src, name) {
    const m = new RegExp(`\\n\\s{6}${name}\\(\\)\\s*\\{([\\s\\S]*?)\\n\\s{6}\\},`).exec(src);
    assert.ok(m, `找不到 ${name} 的实现`);
    return m[1];
  }

  describe('same four stages, same division of labour', function () {
    it('declares the same stage names as the gallery', function () {
      for (const stage of ['videoItems', 'searchedVideos', 'filteredVideos']) {
        assert.match(
          videoApp,
          new RegExp(`\\n\\s{6}${stage}\\(\\)`),
          `视频页缺少派生层 ${stage} —— 与图库同构是这里存在的前提`
        );
      }
    });

    it('filters by type exactly once, in the first stage', function () {
      const items = bodyOf(videoApp, 'videoItems');
      assert.match(items, /isVideoName/, 'videoItems 应当按扩展名筛出视频');
      assert.doesNotMatch(items, /searchQuery/, 'videoItems 不该管搜索，否则计数与网格又会分叉');

      const searched = bodyOf(videoApp, 'searchedVideos');
      assert.match(searched, /searchQuery/, 'searchedVideos 才是处理搜索的那一层');
      assert.doesNotMatch(searched, /isVideoName/, '类型筛选只应在 videoItems 做一次');

      assert.match(bodyOf(videoApp, 'filteredVideos'), /slice\(/, 'filteredVideos 负责分页切片');
    });

    it('counts the searched set, never the raw response', function () {
      // 与图库同一条约束。总数取原始列表就是那个 bug 的原形。
      assert.match(
        videoApp,
        /totalCount\(\)\s*\{\s*return this\.searchedVideos\.length;/,
        'totalCount 必须取 searchedVideos.length'
      );
      assert.doesNotMatch(
        videoApp,
        /totalCount\(\)\s*\{\s*return this\.videos\.length;/,
        'totalCount 取 videos.length 会把非视频文件算进总数，与空状态自相矛盾'
      );
      assert.match(videoApp, /totalPages\(\)\s*\{\s*return Math\.ceil\(this\.searchedVideos\.length/,
        '总页数必须由 searchedVideos 推导');
      assert.match(videoApp, /selectedCount\(\)\s*\{\s*return this\.videoItems\.filter/,
        '已选数应基于视频集合');
    });

    it('never reimplements the extension filter inline', function () {
      assert.doesNotMatch(
        videoApp,
        /\['mp4',\s*'webm'|videoExts\s*=/,
        'video-app.js 里又出现了一份内联的视频扩展名数组 —— 请改用 KVShared.isVideoName'
      );
      assert.match(videoApp, /KVShared\.isVideoName\(vid\.name\)/, '应委托给 KVShared');
    });
  });

  describe('the video extension list matches everywhere it is duplicated', function () {
    const sharedList = () => {
      const m = /var VIDEO_EXTS = \[([\s\S]*?)\];/.exec(shared);
      assert.ok(m, 'kv-shared.js 里找不到 VIDEO_EXTS');
      return [...m[1].matchAll(/"([a-z0-9]+)"/g)].map((x) => x[1]);
    };

    it('kv-shared.js declares and exports it', function () {
      const list = sharedList();
      assert.ok(list.length >= 10, `清单只有 ${list.length} 项，像是没加载出来`);
      assert.strictEqual(new Set(list).size, list.length, '清单里有重复项');
      assert.match(shared, /window\.KVShared = \{[\s\S]*?isVideoName: isVideoName,/, 'isVideoName 没有导出');
      assert.match(shared, /window\.KVShared = \{[\s\S]*?VIDEO_EXTS: VIDEO_EXTS,/, 'VIDEO_EXTS 没有导出');
    });

    it('the server copy matches the shared copy item for item', function () {
      const apiMatch = /const VIDEO_EXTS = new Set\(\[([\s\S]*?)\]\);/.exec(apiList);
      assert.ok(apiMatch, 'functions/api/manage/list.js 里找不到 VIDEO_EXTS');
      const apiItems = [...apiMatch[1].matchAll(/'([a-z0-9]+)'/g)].map((x) => x[1]);
      const sharedItems = sharedList();
      assert.deepStrictEqual(
        apiItems.slice().sort(),
        sharedItems.slice().sort(),
        `前端与服务端的视频扩展名清单不一致。\n  前端: ${sharedItems.join(',')}\n  服务端: ${apiItems.join(',')}`
      );
    });

    it("the files page's private copy still agrees", function () {
      // admin-app.js 的 fileConfig.video 是本文件的私有清单（Workers 之外的
      // 最后一处）。图片/视频已独立成页，但 admin 仍用 fileConfig 判断类型做
      // 图标与统计，所以这两份也得一致，否则同一批文件在两页算成两类。
      const m = /video:\s*\{\s*name: '视频',[\s\S]{0,400}?exts: \[([\s\S]*?)\],/.exec(adminApp);
      assert.ok(m, 'admin-app.js 里找不到 fileConfig.video');
      const adminItems = [...m[1].matchAll(/'([a-z0-9]+)'/g)].map((x) => x[1]);
      const sharedItems = sharedList();
      assert.deepStrictEqual(
        adminItems.slice().sort(),
        sharedItems.slice().sort(),
        `admin-app.js 与 kv-shared.js 的视频清单不一致。\n  共享: ${sharedItems.join(',')}\n  admin: ${adminItems.join(',')}`
      );
    });

    it('covers the containers yt-dlp actually produces', function () {
      // server/lib/services/ytdlp-options.js 的预设产出 mp4 / mkv / m4a。
      // mp4、mkv 必须在清单里，否则转存来的视频在视频库里列不出来。
      const list = sharedList();
      for (const ext of ['mp4', 'mkv', 'webm', 'mov']) {
        assert.ok(list.includes(ext), `清单缺少 ${ext}：该格式的视频存了却不会出现在视频库里`);
      }
    });
  });

  describe('the page itself is wired the way the markup expects', function () {
    it('loads the shared shell, icons and shared helpers', function () {
      assert.match(videoHtml, /href="\/app-shell\.css/, '缺少应用外壳样式');
      assert.match(videoHtml, /src="\/kv-shared\.js/, '缺少 kv-shared.js —— isVideoName 从那里来');
      assert.match(videoHtml, /src="\/icons\.js/, '缺少图标渲染脚本');
      assert.match(videoHtml, /id="logoutBtn"/, '缺少顶栏退出按钮');
    });

    it('marks the grid as the video page and not the image page', function () {
      assert.match(videoHtml, /class="video-grid"/, '缺少视频网格');
      assert.match(videoHtml, /class="video-card-media"/, '卡片里应当是 <video>');
      // 卡片不该再套一层 hover 遮罩：真正的操作对象是播放器，
      // 遮罩盖上去就把原生控件挡死了。
      assert.doesNotMatch(videoHtml, /video-card-overlay/, '视频卡片不要用图库那套悬停遮罩');
    });

    it('does not preload every player on the page', function () {
      // 一页 12 个 <video> 同时 preload="metadata" 会让首屏多打 12 个
      // Range 请求，移动网络上尤其明显。
      assert.match(
        videoHtml,
        /<video class="video-card-media"[\s\S]{0,200}preload="none"/,
        '视频卡片应 preload="none"，否则首屏并发十几个 Range 请求'
      );
      assert.doesNotMatch(videoHtml, /preload="metadata"/, '视频卡片不应预载元数据');
    });

    it('keeps the click on the player from selecting the card', function () {
      // 点击播放器是"播放"，不是"选中"。选中框是独立按钮，
      // 播放器本身没有选择语义。
      assert.match(videoHtml, /video-card-checkbox[\s\S]{0,400}@click\.stop="toggleSelect\(vid\)"/,
        '选择框应显式阻止冒泡');
      assert.doesNotMatch(
        videoHtml,
        /<video[^>]*v-on:click|@click="toggleSelect\(vid\)"[^>]*>\s*<video/,
        '播放器上不应绑定选中'
      );
    });

    it('styles every class the markup emits', function () {
      const stripComments = (s) => s.replace(/\/\*[\s\S]*?\*\//g, '');
      const css = stripComments(videoCss);
      for (const cls of [
        'video-grid', 'video-card', 'video-card-stage', 'video-card-media',
        'video-card-checkbox', 'video-card-body', 'video-card-name',
        'video-card-meta', 'video-card-format', 'video-card-actions',
      ]) {
        assert.ok(css.includes(`.${cls}`), `video.css 缺少 .${cls} —— 模板会产出带这个类的元素`);
      }
    });

    it('uses the same layout width as the gallery', function () {
      // 两个页面来回切时内容区横向错位会显得像两个站。
      assert.match(videoCss, /#app\s*\{[\s\S]{0,120}--ui-width-wide/,
        '视频页内容区应与图库共用版面宽度 token');
      assert.match(galleryCssWidth(), /--ui-width-wide/, '图库仍在使用版面宽度 token');
    });

    function galleryCssWidth() {
      return /#app\s*\{[\s\S]{0,120}--ui-width-wide/.test(read('gallery.css'))
        ? '--ui-width-wide'
        : '';
    }

    it('resolves every token it references', function () {
      const theme = read('theme.css');
      const used = new Set(
        [...videoCss.matchAll(/var\((--[a-z0-9-]+)/g)].map((m) => m[1])
      );
      for (const token of used) {
        assert.ok(
          theme.includes(`${token}:`),
          `video.css 引用了 ${token}，theme.css 里没有定义 —— 会解析成空值`
        );
      }
    });
  });

  describe('the empty state says something true', function () {
    it('separates "no videos" from "search matched nothing"', function () {
      assert.match(videoHtml, /v-if="searchQuery\.trim\(\)"/, '空状态没有区分两种情况');
      assert.match(videoHtml, /没有匹配的视频/, '缺少搜索无结果的文案');
      assert.match(videoHtml, /清空搜索/, '搜索无结果时应提供清空搜索的出口');
      assert.match(videoHtml, /这里还没有视频/, '缺少空库文案');
    });

    it('relabels the count so its meaning follows the search state', function () {
      assert.match(videoHtml, /匹配<strong>\{\{ totalCount \}\}/, '搜索时标签应为「匹配」');
      assert.match(videoHtml, /视频<strong>\{\{ totalCount \}\}/, '非搜索时标签应为「视频」');
    });
  });

  describe('the files page hands media over instead of duplicating it', function () {
    it('sends the image filter to the gallery and the video filter to the video page', function () {
      // 同一个东西有两个入口时，两边的清单各自会漂移。所以 admin 不再
      // 自己筛图片/视频，而是给一条明确的路。
      assert.match(
        adminApp,
        /if \(type === 'image' \|\| type === 'video'\) \{[\s\S]{0,320}gallery\.html[\s\S]{0,200}video\.html/,
        "admin 的图片/视频筛选应当跳转到对应页面"
      );
    });

    it('does not bounce the user off the files page on load', function () {
      // 这条是真实踩过的坑：mount 时会调 switchFileType(this.fileType, false)
      // 应用 localStorage 里的设置，而老版本留下的键可能是 'image'。
      // 如果 showMessage===false 时也跳转，用户打开文件工作台就被弹去图库；
      // 更糟的是跳转前没清 localStorage，于是每次打开都弹一次，用户永远
      // 回不到文件页。存量键必须在这里清掉。
      const fn = /switchFileType\(type, showMessage = true\)\s*\{([\s\S]*?)\n {6}\},/.exec(adminApp);
      assert.ok(fn, '找不到 switchFileType 的实现');
      const body = fn[1];
      const branch = /if \(type === 'image' \|\| type === 'video'\) \{([\s\S]*?)\n {8}\}/.exec(body);
      assert.ok(branch, '找不到图片/视频的跳转分支');
      assert.match(
        branch[1],
        /if \(showMessage\)\s*\{[\s\S]*?window\.location\.href/,
        '跳转必须包在 if (showMessage) 里 —— mount 时的恢复调用也会命中这个分支'
      );
      assert.match(
        branch[1],
        /localStorage\.removeItem\('fileType'\)/,
        "必须清掉老版本留下的 fileType 键，否则用户每次打开文件页都被弹走"
      );
    });

    it('still offers audio and documents inline', function () {
      // 这两类没有独立页面，仍由文件工作台负责 —— 不能连它们一起砍掉。
      assert.match(adminHtml, /command="audio">音频/, '音频筛选不应被移除');
      assert.match(adminHtml, /command="document">文档及其他文件/, '文档筛选不应被移除');
    });

    it('labels the media filters as links elsewhere', function () {
      assert.match(adminHtml, /command="image"[^>]*>[^<]*图库/, '图片项应说明去向是图库');
      assert.match(adminHtml, /command="video"[^>]*>[^<]*视频库/, '视频项应说明去向是视频库');
    });
  });

  describe('the two media pages do not leak into each other', function () {
    it('the gallery has no video-only markup and vice versa', function () {
      assert.doesNotMatch(galleryHtml, /video-card|video-grid/, '图库不该出现视频卡的类');
      assert.doesNotMatch(videoHtml, /image-card|image-grid/, '视频页不该出现图片卡的类');
    });

    it('each page filters by its own type', function () {
      assert.match(galleryApp, /KVShared\.isImageName\(img\.name\)/, '图库应按图片筛');
      assert.doesNotMatch(videoApp, /isImageName/, '视频页不该按图片筛');
      assert.doesNotMatch(galleryApp, /isVideoName/, '图库不该按视频筛');
    });
  });
});