const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

describe('WebDAV page contract', function () {
  it('handles legacy array upload responses for URL uploads and targets WebDAV storage', function () {
    // 应用脚本已拆到 webdav-app.js：契约检查针对实现本体。
    const app = fs.readFileSync(path.join(__dirname, '..', 'webdav-app.js'), 'utf8');

    assert.match(app, /storageMode:\s*"webdav"/);
    assert.match(app, /Array\.isArray\(payload\)\s*\?\s*payload\[0\]\s*:\s*payload/);
    assert.match(app, /URL 上传成功/);
  });
});
