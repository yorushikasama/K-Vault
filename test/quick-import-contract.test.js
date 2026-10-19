const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

/**
 * 「快速转存」（常驻 URL 表单主按钮）的行为契约。
 *
 * 需求背景：原 URL 转存要三步交互——展开表单、粘贴、弹清晰度选择器手
 * 动挑档位。第十四批 UI 改版后 URL 表单常驻，「快速转存」是表单主按钮
 * （回车/点击皆可）：输入框有链接直接用，为空读剪贴板；分享链接直接
 * submitMediaUpload(url, null) 让服务端一次调用内完成解析+最佳清晰度+
 * 入库。「手动选择」按钮保留原 fetchMediaInfo + 选择器完整流程。
 *
 * 这组测试钉住六件事：
 *   1. 表单常驻（无 v-if）、submit 绑定快速路径、手动按钮仅在视频解析
 *      可用时出现；
 *   2. 快速路径**不做** fetchMediaInfo 预解析、**不弹** openQualityPicker
 *      —— 这两条任一回流，「快速」就退化回完整流程（预解析正是被砍掉
 *      的那半段等待）；
 *   3. 剪贴板读取失败必须兜底聚焦常驻输入框（移动端 iOS 权限被拒时不判
 *      死刑），showUrlInput 折叠状态不得回流；
 *   4. 失败回填：最佳清晰度超限等失败时链接留在表单里，用户改走「手动
 *      选择」不必重新复制；
 *   5. runMediaUpload 必须返回成败（快速路径靠返回值决定回填），且
 *      401 会话过期要跳登录而不是无限重试；
 *   6. 窄屏触摸目标：来源按钮与输入框行按钮 44px、快速/手动两列等分
 *      （移动端可用性）；图标 bolt 必须在 icons-subset.js 里（漏打时
 *      kv-icon 渲染成空白方块）。
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

  it('index.html keeps the URL form always visible with quick as its primary action', function () {
    // 第十四批 UI 改版：URL 表单常驻（无 v-if），「快速转存」是表单主按钮
    // （type=submit，回车即快速转存），「手动选择」走原 fetchMediaInfo 流程。
    assert.ok(
      /<form id="upload-url-form" class="upload-url-form" @submit\.prevent="quickImportFromClipboard">/.test(indexHtml),
      'URL 表单必须常驻且 submit 走 quickImportFromClipboard（回车=快速转存）',
    );
    assert.ok(
      !/v-if="showUrlInput"/.test(indexHtml),
      'URL 表单不得再用 v-if 折叠（旧「从 URL 转存」开关已拆除）',
    );
    assert.ok(
      /type="submit" :disabled="!canAddUploads \|\| urlSubmitting"/.test(indexHtml)
        && /name="bolt"/.test(indexHtml),
      '快速转存必须是 submit 主按钮（禁用态覆盖 urlSubmitting，空输入框允许点以读剪贴板）',
    );
    assert.ok(
      /v-if="mediaResolve\.available"[\s\S]{0,300}?@click="uploadFromUrl"/.test(indexHtml),
      '「手动选择」按钮须绑定 uploadFromUrl，且仅在视频解析可用时出现（直链场景没有选择器可弹）',
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

  it('clipboard source falls back to focusing the always-visible input', function () {
    const body = methodBody(mediaJs, 'quickImportFromClipboard');
    // 移动端兜底：表单已常驻，读取被拒时聚焦输入框让用户粘贴。
    assert.ok(
      /clipboard\.readText/.test(body) && /catch[\s\S]{0,400}?this\.\$refs\.urlInput/.test(body),
      '剪贴板读取失败必须聚焦输入框兜底（表单常驻后无需再展开）',
    );
    // 表单里已有内容优先于剪贴板：用户贴好了再点快速 = 只想跳过选择器。
    assert.ok(
      /urlToUpload \|\| ""/.test(body),
      '链接来源必须先取表单里已有的 urlToUpload',
    );
    assert.ok(
      !/showUrlInput/.test(body),
      'showUrlInput 状态已随折叠开关一起拆除，不得回流',
    );
  });

  it('mobile browsers without the clipboard API get the two-step fallback, not a dead end', function () {
    const body = methodBody(mediaJs, 'quickImportFromClipboard');
    // 前置检测：HeyTapBrowser 等国产移动浏览器不暴露 clipboard API，
    // 不试就知道失败——直接展开表单，别闪「读取中」再报错。
    assert.ok(
      /typeof navigator\.clipboard\.readText === "function"/.test(body),
      '调用 readText 前必须先检测 navigator.clipboard.readText 是否存在',
    );
    // 兜底 toast 必须指路「粘贴后再点一次快速转存」（表单优先语义），
    // 而不是把用户赶去「加入转存队列」的完整三步流程。
    assert.ok(
      /再点一次「快速转存」/.test(body),
      '剪贴板不可用的兜底文案必须引导用户粘贴后再点一次快速转存',
    );
    assert.ok(
      (body.match(/再点一次「快速转存」/g) || []).length >= 2,
      '前置检测不通过与运行时被拒两条兜底路径都要有此指引',
    );
  });

  it('a failed quick import leaves the URL in the form for the full flow', function () {
    const body = methodBody(mediaJs, 'quickImportFromClipboard');
    assert.ok(/this\.urlToUpload = submittedUrl;/.test(body),
      '快速转存失败必须把链接回填表单（改走完整流程不必重新复制）');
    assert.ok(/手动选择/.test(body),
      '失败 toast 必须指引用户改用「手动选择」挑清晰度');
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
      'workbench.css 窄屏断点必须给来源按钮（粘贴上传）44px 触摸目标',
    );
    assert.ok(
      /\.upload-field-row > \.btn \{ min-height: 44px/.test(workbenchCss),
      '窄屏断点必须给输入框行的快速/手动按钮 44px 触摸目标',
    );
    assert.ok(
      /\.upload-field-row \{[\s\S]{0,120}?grid-template-columns: repeat\(2, minmax\(0, 1fr\)\)/.test(workbenchCss),
      '窄屏输入框行须为两列网格：快速/手动各占一列等分，不堆叠',
    );
  });

  it('the bolt icon ships in icons-subset.js', function () {
    assert.ok(/\bBolt\b/.test(iconSubset), 'icons-subset.js 必须包含 Bolt，否则快速按钮图标渲染成空白');
  });

  it('upload-app.js declares the quickReading state', function () {
    assert.ok(/quickReading: false/.test(appJs), '剪贴板读取态 quickReading 必须在 data 中声明');
  });
});