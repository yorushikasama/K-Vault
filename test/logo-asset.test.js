const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

/**
 * logo.png 曾是 446x559 / 204 KB，而页面上它只以 32x32 显示，
 * 并被九个页面当 apple-touch-icon 引用 —— 每个首屏都要付这 204 KB。
 * 顺带一个 bug：apple-touch-icon 要求方图，非方图会被 iOS 拉伸。
 */
describe('logo asset budget', function () {
  const root = path.resolve(__dirname, '..');
  const logoPath = path.join(root, 'logo.png');
  const buf = fs.readFileSync(logoPath);

  /** 直接读 PNG 的 IHDR，不引图像库。 */
  function pngSize(buffer) {
    assert.strictEqual(buffer.readUInt32BE(0), 0x89504e47, '不是 PNG 文件');
    assert.strictEqual(buffer.toString('ascii', 12, 16), 'IHDR', 'IHDR 不在预期位置');
    return { width: buffer.readUInt32BE(16), height: buffer.readUInt32BE(20) };
  }

  it('stays within a sane byte budget', function () {
    // 九个页面的首屏都会拉它，放宽到 60 KB 留出重新导出的余地，
    // 但远低于原来的 204 KB。
    assert.ok(buf.length < 60 * 1024, `logo.png 是 ${buf.length} 字节，超出预算`);
  });

  it('is square so iOS does not stretch the touch icon', function () {
    const { width, height } = pngSize(buf);
    assert.strictEqual(width, height, `apple-touch-icon 必须是方图，当前 ${width}x${height}`);
  });

  it('is large enough for the retina touch icon but not wastefully so', function () {
    const { width } = pngSize(buf);
    // iOS @3x 的 apple-touch-icon 标准尺寸是 180；页面里的 <img> 只占 32px。
    assert.ok(width >= 180, `${width}px 不够 apple-touch-icon 用`);
    assert.ok(width <= 256, `${width}px 超出任何实际显示尺寸`);
  });

  it('keeps the transparency the logo relies on', function () {
    // 颜色类型 6 = RGBA。曾试过调色板量化，它只能存一个透明索引，
    // 会把实心区域连同抗锯齿边缘一起压成半透明。
    const colorType = buf[25];
    assert.ok([4, 6].includes(colorType), `PNG 颜色类型 ${colorType} 不含 alpha 通道`);
  });

  it('is still referenced by the pages that need it', function () {
    // 逐页点名，而不是写死个数。写死 9 的问题是：下线两个页面后阈值不再
    // 对得上，测试会以「引用被误删」的说法失败，而真实原因只是页面少了
    // —— 报错会把排查方向指到错的���方。
    const pages = fs.readdirSync(root).filter((f) => f.endsWith('.html'));
    const src = Object.fromEntries(
      pages.map((p) => [p, fs.readFileSync(path.join(root, p), 'utf8')])
    );

    const mustHaveLogo = ['index.html', 'admin.html', 'gallery.html', 'video.html', 'login.html'];
    for (const page of mustHaveLogo) {
      assert.ok(
        src[page] && src[page].includes('/logo.png'),
        `${page} 不再引用 logo.png；应用外壳的品牌位会显示空白`
      );
    }

    // 反向：不引用品牌位的页面（preview / block-img / whitelist-on 这类
    // 被服务端 302 过去的落地页）不该硬塞一个 logo进来。
    const landedOnly = ['preview.html', 'block-img.html', 'whitelist-on.html'];
    for (const page of landedOnly) {
      if (!src[page]) continue;
      assert.doesNotMatch(
        src[page],
        /\/logo-[a-z0-9-]+\.png/,
        `${page} 引用了不存在的 logo 变体`
      );
    }
  });
});
