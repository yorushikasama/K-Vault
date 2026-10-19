const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

/**
 * 「快速转存」按钮的行为契约。
 *
 * 需求背景：原 URL 转存对视频分享链接要三步交互——展开表单粘贴、等
 * fetchMediaInfo 预解析、弹清晰度选择器手动挑档位。「快速转存」一键
 * 完成：读剪贴板（表单已有内容优先）→ 判定 → 直接 submitMediaUpload
 * (url, null) 让服务端一次调用内完成解析+最佳清晰度+入库。
 *
 * 这组测试钉住六件事：
 *   1. 按钮存在、绑定正确、禁用态覆盖提交中；
 *   2. 快速路径**不做** fetchMediaInfo 预解析、**不弹** openQualityPicker
 *      —— 这两条任一回流，「快速」就退化回完整流程（预解析正是被砍掉
 *      的那半段等待）；
 *   3. 剪贴板读取失败必须兜底展开 URL 表单（移动端 iOS 权限被拒时不判
 *      死刑）；
 *   4. 失败回填：最佳清晰度超限等失败时链接留在表单里，用户改走完整
 *      流程不必重新复制；
 *   5. runMediaUpload 必须返回成败（快速路径靠返回值决定回填），且
 *      401 会话过期要跳登录而不是无限重试；
 *   6. 窄屏触摸目标：来源按钮区 44px（移动端可用性）；图标 bolt 必须
 *      在 icons-subset.js 里（漏打时 kv-icon 渲染成空白方块）。
 */
describe('quick import (one-tap URL transfer) contract', function () {
  const root = path.resolve(__dirname, '..');
  const read = (name) => fs.readFileSync(path.join(root, name), 'utf8');

  const indexHtml = read('index.html');
  const mediaJs = read('upload-media.js');
  const appJs = read('upload-app.js');
  const workbenchCss = read('workbench.css');
  const iconSubset = read('icons-subset.js');

  /** 抽出 quickImportFromClipboard 方法体（到方法名行缩进对应的 `},` 为止）。 */
  function methodBody(src, name) {
    const re = new RegExp(`async ${name}\\([^)]*\\)\\s*\\{([\\s\\S]*?)\\n\\s{10}\\},`);
    const m = re.exec(src);
    assert.ok(m, `upload-media.js 缺少 ${name} 实现`);
    return m[1];
  }

  it('index.html wires the quick button next to the URL-transfer button', function () {
    assert.ok(
      /从 URL 转存<\/button>[\s\S]{0,400}?@click="quickImportFromClipboard"/.test(indexHtml),
      '快速转存按钮必须紧跟「从 URL 转存」按钮，且绑定 quickImportFromClipboard',
    );
    assert.ok(
      /name="bolt"/.test(indexHtml),
      '快速按钮用 bolt 图标（Lucide 1.49 中 zap 已改名，运行时找不到会渲染空白）',
    );
    // 提交中必须禁用，防止连点出双任务。
    assert.ok(
      /:disabled="!canAddUploads \|\| urlSubmitting" @click="quickImportFromClipboard"/.test(indexHtml),
      '快速按钮的禁用态必须覆盖 urlSubmitting',
    );
  });

  it('the quick path never re-routes through the quality picker or a pre-resolve', function () {
    const body = methodBody(mediaJs, 'quickImportFromClipboard');
    assert.ok(
      !/openQualityPicker/.test(body),
      '快速路径不得调用 openQualityPicker —— 弹回选择器等于退化回完整流程',
    );
    assert.ok(
      !/fetchMediaInfo/.test(body),
      '快速路径不得做 fetchMediaInfo 预解析 —— 那是纯为弹选择器服务的半段等待',
    );
    // 服务端取最佳清晰度的语义：runMediaUpload(url, null)（variant 为空）。
    assert.ok(
      /runMediaUpload\(submittedUrl,\s*null\)/.test(body),
      '分享链接必须直接 runMediaUpload(url, null) 让服务端取最佳清晰度',
    );
  });

  it('clipboard source falls back to the manual form when reading is refused', function () {
    const body = methodBody(mediaJs, 'quickImportFromClipboard');
    // 移动端兜底：iOS 权限框被拒时不判死刑，展开表单走完整流程。
    assert.ok(
      /clipboard\.readText/.test(body) && /catch[\s\S]{0,400}?this\.showUrlInput = true/.test(body),
      '剪贴板读取失败必须展开 URL 表单兜底（showUrlInput = true）',
    );
    // 表单里已有内容优先于剪贴板：用户贴好了再点快速 = 只想跳过选择器。
    assert.ok(
      /urlToUpload \|\| ""/.test(body),
      '链接来源必须先取表单里已有的 urlToUpload',
    );
  });

  it('a failed quick import leaves the URL in the form for the full flow', function () {
    const body = methodBody(mediaJs, 'quickImportFromClipboard');
    assert.ok(/this\.urlToUpload = submittedUrl;/.test(body),
      '快速转存失败必须把链接回填表单（改走完整流程不必重新复制）');
    assert.ok(/快速转存失败/.test(body),
      '失败 toast 必须指引用户改走完整流程');
  });

  it('runMediaUpload reports success/failure and routes 401 to the login page', function () {
    const body = methodBody(mediaJs, 'runMediaUpload');
    assert.ok(/return true;/.test(body) && /return false;/.test(body),
      'runMediaUpload 必须返回 true/false（快速路径靠返回值决定回填）');
    assert.ok(/unauthorized[\s\S]{0,200}?redirectToLogin/.test(body),
      '401 会话过期必须 redirectToLogin，不能让过期用户无限重试');
    // submitMediaUpload 的 401 特判是 runMediaUpload 能收到 unauthorized 的前提。
    const submit = methodBody(mediaJs, 'submitMediaUpload');
    assert.ok(/401[\s\S]{0,200}?unauthorized = true/.test(submit),
      'submitMediaUpload 必须把 401 标记为 unauthorized');
  });

  it('the mobile layout keeps 44px touch targets for the source buttons', function () {
    assert.ok(
      /@media \(max-width: 768px\)[\s\S]*?\.upload-source-actions \.btn \{[^}]*min-height: 44px/.test(workbenchCss),
      'workbench.css 窄屏断点必须给来源按钮区（粘贴/URL/快速）44px 触摸目标',
    );
  });

  it('the bolt icon ships in icons-subset.js', function () {
    assert.ok(/\bBolt\b/.test(iconSubset), 'icons-subset.js 必须包含 Bolt，否则快速按钮图标渲染成空白');
  });

  it('upload-app.js declares the quickReading state', function () {
    assert.ok(/quickReading: false/.test(appJs), '剪贴板读取态 quickReading 必须在 data 中声明');
  });
});