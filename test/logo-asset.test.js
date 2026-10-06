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
    const pages = fs.readdirSync(root).filter((f) => f.endsWith('.html'));
    const users = pages.filter((p) => fs.readFileSync(path.join(root, p), 'utf8').includes('/logo.png'));
    assert.ok(users.length >= 9, `只有 ${users.length} 个页面引用 logo.png，引用可能被误删`);
  });
});
