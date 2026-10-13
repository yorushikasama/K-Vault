const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

/**
 * 图库的计数必须与网格严格一致。
 *
 * 用户报的现象：页头写「总数 6」，正文写「没有找到图片」。两个数字在各自的
 * 逻辑里都是对的 —— 页头数的是 `images.length`（服务端返回的**全部**文件），
 * 正文看的是 `filteredImages.length`（按图片扩展名过滤之后）。同一批文件被
 * 两道不同的过滤各数了一遍，中间发生了什么从没告诉用户，于是自相矛盾。
 *
 * 这类 bug 的成因是"同一个概念被实现多次"。这里钉住两件事：
 *
 *   1. 派生链唯一。images → imageItems → searchedImages → filteredImages，
 *      每一层只做一件事，计数取 searchedImages.length，与网格同源。
 *   2. 图片扩展名清单只有一份。前后端各有一份（Workers 无法 import 浏览器
 *      脚本），内容必须逐字一致 —— 历史上已经漂移过多次：全站一度有五份
 *      不同的清单，并集 18 个扩展名而没有任何一份是完整的，avif / heic /
 *      tiff 都不在图库那份里，于是这些图片存了却永远列不出来。
 */
describe('gallery list stays internally consistent', function () {
  const root = path.resolve(__dirname, '..');
  const read = (f) => fs.readFileSync(path.join(root, f), 'utf8');
  const galleryApp = read('gallery-app.js');
  const galleryHtml = read('gallery.html');
  const shared = read('kv-shared.js');
  const apiList = read('functions/api/manage/list.js');
  const previewApp = read('preview-app.js');
  const uploadApp = read('upload-app.js');

  describe('one derivation chain, one source for the count', function () {
    it('keeps the four stages, each doing exactly one thing', function () {
      for (const stage of ['imageItems', 'searchedImages', 'filteredImages']) {
        assert.match(
          galleryApp,
          new RegExp(`\\n\\s{8}${stage}\\(\\)`),
          `图库缺少派生层 ${stage} —— 这是把过滤重新散回多处之后留下的痕迹`
        );
      }
      // imageItems 只筛类型；searchedImages 只筛搜索；filteredImages 只切片。
      const body = (name) => {
        const m = new RegExp(`\\n\\s{8}${name}\\(\\)\\s*\\{([\\s\\S]*?)\\n\\s{8}\\},`).exec(galleryApp);
        assert.ok(m, `找不到 ${name} 的实现`);
        return m[1];
      };
      assert.match(body('imageItems'), /isImageName/, 'imageItems 应当按扩展名筛出图片');
      assert.doesNotMatch(body('imageItems'), /searchQuery/, 'imageItems 不该管搜索，否则计数与网格又会分叉');
      assert.match(body('searchedImages'), /searchQuery/, 'searchedImages 才是处理搜索的那一层');
      assert.doesNotMatch(body('searchedImages'), /isImageName/, '类型筛选只应在 imageItems 做一次');
      assert.match(body('filteredImages'), /slice\(/, 'filteredImages 负责分页切片');
    });

    it('counts the searched set, not the raw response', function () {
      // 这条就是用户看到的那个矛盾：总数取 images.length（不过滤），
      // 于是非图片文件也被算进去，与「没有找到图片」同时出现。
      assert.match(
        galleryApp,
        /totalCount\(\)\s*\{\s*return this\.searchedImages\.length;/,
        'totalCount 必须取 searchedImages.length —— 取 images.length 会把非图片文件算进"总数"'
      );
      assert.doesNotMatch(
        galleryApp,
        /totalCount\(\)\s*\{\s*return this\.images\.length;/,
        'totalCount 又变回 images.length 了：非图片文件会被计入总数，与空状态自相矛盾'
      );
    });

    it('selects and paginates from the same set it counts', function () {
      assert.match(galleryApp, /selectedCount\(\)\s*\{\s*return this\.imageItems\.filter/,
        '已选数应基于图片集合 —— 原先基于 images，会把非图片的选中态也算进来');
      assert.match(galleryApp, /totalPages\(\)\s*\{\s*return Math\.ceil\(this\.searchedImages\.length/,
        '总页数必须由 searchedImages 推导；自己再实现一遍过滤就是 bug 的来源');
    });

    it('never reimplements the extension filter inline', function () {
      // 曾经 imageExts 这个数组在 filteredImages 与 totalPages 里各出现一次，
      // 两处都可能被单独改掉，于是"网格数"和"页数"对不上。
      assert.doesNotMatch(
        galleryApp,
        /imageExts|\['jpg',\s*'jpeg'/,
        'gallery-app.js 里又出现了一份内联的图片扩展名数组 —— 请改用 KVShared.isImageName'
      );
      assert.doesNotMatch(
        galleryApp,
        /\['jpg',\s*'jpeg',\s*'png'/,
        'gallery-app.js 里出现了字面量图片扩展名清单 —— 应统一走 KVShared'
      );
    });
  });

  describe('the image extension list exists in exactly one place per runtime', function () {
    /** 取出 kv-shared.js 里那份清单的实际内容。 */
    const sharedList = () => {
      const m = /var IMAGE_EXTS = \[([\s\S]*?)\];/.exec(shared);
      assert.ok(m, 'kv-shared.js 里找不到 IMAGE_EXTS');
      return [...m[1].matchAll(/"([a-z0-9]+)"/g)].map((x) => x[1]);
    };

    it('kv-shared.js declares it once and exports it', function () {
      const list = sharedList();
      assert.ok(list.length >= 10, `清单只有 ${list.length} 项，像是没加载出来`);
      assert.strictEqual(new Set(list).size, list.length, '清单里有重复项');
      assert.match(shared, /window\.KVShared = \{[\s\S]*?isImageName: isImageName,/, 'isImageName 没有导出');
      assert.match(shared, /window\.KVShared = \{[\s\S]*?IMAGE_EXTS: IMAGE_EXTS,/, 'IMAGE_EXTS 没有导出');
    });

    it('isImageName handles the cases that used to break it', function () {
      // 直接在沙箱里求值这个函数，验证行为而不是验证源码长什么样。
      const body = /function isImageName\(name\)\s*\{([\s\S]*?)\n {2}\}/.exec(shared);
      assert.ok(body, '找不到 isImageName 的实现');
      const fn = new Function('IMAGE_EXTS', `"use strict"; return function (name) {${body[1]}}`)(sharedList());
      for (const name of ['a.jpg', 'a.JPEG', 'dir/a.png', 'a.avif', 'a.HEIC', 'a.tiff']) {
        assert.strictEqual(fn(name), true, `${name} 应当被认成图片`);
      }
      for (const name of ['a.bin', 'a.mp4', 'a.pdf', 'noext', 'a.zip']) {
        assert.strictEqual(fn(name), false, `${name} 不该被认成图片`);
      }
    });

    it('the server copy matches the shared copy item for item', function () {
      // Workers 跑不了浏览器脚本，只能抄一份；但抄的内容必须一致。
      // 历史上两份漂移过：图库那份少了 avif/heic/tiff，于是这些图片
      // 存了却永远列不出来。
      const apiMatch = /const IMAGE_EXTS = new Set\(\[([\s\S]*?)\]\);/.exec(apiList);
      assert.ok(apiMatch, 'functions/api/manage/list.js 里找不到 IMAGE_EXTS');
      const apiListItems = [...apiMatch[1].matchAll(/'([a-z0-9]+)'/g)].map((x) => x[1]);
      const sharedItems = sharedList();
      assert.deepStrictEqual(
        apiListItems.slice().sort(),
        sharedItems.slice().sort(),
        `前端与服务端的图片扩展名清单不一致。\n  前端: ${sharedItems.join(',')}\n  服务端: ${apiListItems.join(',')}`
      );
    });

    it('preview and upload pages reuse the shared list', function () {
      // preview-app 原本是全站最全的一份（18 项），upload-app 只有 8 项。
      // 两份都改成引用共享层 —— 抄一份就多一次漂移的机会。
      assert.match(previewApp, /new Set\(window\.KVShared\.IMAGE_EXTS\)/,
        'preview-app.js 应复用 KVShared.IMAGE_EXTS，而不是自带一份');
      assert.match(uploadApp, /isImageFile\(filename\)\s*\{\s*return KVShared\.isImageName\(/,
        'upload-app.js 的 isImageFile 应委托给 KVShared');
      assert.doesNotMatch(uploadApp, /"jpg",\s*\n\s*"jpeg"/,
        'upload-app.js 里还留着内联的图片扩展名数组');
    });

    it('covers the formats this deployment actually stores', function () {
      // avif 是本项目自己壁纸在用的格式（服务端实测存在 telegram_*.avif），
      // 它曾经不在图库那份清单里 —— 这就是"存了却不显示"的另一条路径。
      const list = sharedList();
      for (const ext of ['avif', 'webp', 'heic', 'heif', 'tiff', 'svg']) {
        assert.ok(list.includes(ext), `清单缺少 ${ext}：该格式的图片存了却不会出现在图库里`);
      }
    });
  });

  describe('the empty state says something true', function () {
    it('separates "no images at all" from "search matched nothing"', function () {
      // 两种情况要用户做的事完全不同：前者去上传，后者换搜索词。
      // 此前共用一个文案，搜索无结果时却把人导向"去上传"。
      assert.match(galleryHtml, /v-if="searchQuery\.trim\(\)"/,
        '空状态没有区分搜索无结果与图片库为空');
      assert.match(galleryHtml, /没有匹配的图片/, '缺少搜索无结果的文案');
      assert.match(galleryHtml, /清空搜索/, '搜索无结果时应提供清空搜索的出口');
    });

    it('relabels the count so its meaning follows the search state', function () {
      // 搜索时 totalCount 是"匹配数"，仍叫"总数"就是误导。
      assert.match(galleryHtml, /匹配<strong>\{\{ totalCount \}\}/,
        '搜索时计数标签应改为「匹配」');
      assert.match(galleryHtml, /图片<strong>\{\{ totalCount \}\}/,
        '非搜索时计数标签应是「图片」—— 图库只统计图片，不该叫"总数"');
    });
  });
});