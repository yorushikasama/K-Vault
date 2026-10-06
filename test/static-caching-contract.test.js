const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

/**
 * 静态资源缓存契约，两套部署都要覆盖。
 *
 * 强缓存和版本串是一对：URL 不随内容变化就设 immutable，用户会拿着旧资源一年。
 * 所以这里既校验缓存头，也校验版本串机制本身还在工作。
 */
describe('static asset caching contract', function () {
  const root = path.resolve(__dirname, '..');
  const headers = fs.readFileSync(path.join(root, '_headers'), 'utf8');
  const nginx = fs.readFileSync(path.join(root, 'docker', 'nginx.conf'), 'utf8');

  describe('every local CSS/JS reference carries a content hash', function () {
    const pages = fs.readdirSync(root).filter((f) => f.endsWith('.html'));

    it('leaves no unversioned reference behind', function () {
      const offenders = [];
      for (const page of pages) {
        const src = fs.readFileSync(path.join(root, page), 'utf8');
        // 本地资源（以 / 或 ./ 开头），排除 CDN 绝对 URL。
        for (const m of src.matchAll(/(?:href|src)="(\.?\/[a-z0-9][a-z0-9.-]*\.(?:css|js))(\?v=[^"]*)?"/g)) {
          if (!m[2]) offenders.push(`${page}: ${m[1]}`);
        }
      }
      assert.deepStrictEqual(offenders, [], '这些引用没有版本串，配上 immutable 会把旧资源锁死一年');
    });

    it('matches the hash of the file on disk', function () {
      const { execFileSync } = require('node:child_process');
      try {
        execFileSync(process.execPath, [path.join(root, 'scripts', 'stamp-asset-versions.cjs'), '--check'], {
          cwd: root,
          stdio: 'pipe',
        });
      } catch (err) {
        const detail = `${err.stdout || ''}${err.stderr || ''}`.trim();
        assert.fail(`资源版本串与文件内容不同步：${detail}`);
      }
    });
  });

  describe('_headers syntax', function () {
    // `wrangler pages dev` 不处理 _headers（本地所有资源都是 wrangler 自己的
    // max-age=0），只有 Pages 边缘才会应用它。行为没法在本地验证，所以这里
    // 按官方文档的规则做静态校验，至少保证不会因为写错格式而整段失效。
    const lines = headers.split(/\r?\n/);
    const rules = lines.filter((l) => l.trim() && !l.trimStart().startsWith('#') && !/^\s/.test(l));

    it('stays within the 100-rule limit', function () {
      assert.ok(rules.length <= 100, `规则数 ${rules.length} 超过 Pages 的 100 条上限`);
      assert.ok(rules.length > 0, '一条规则都没解析出来，格式可能错了');
    });

    it('uses at most one splat per pattern', function () {
      for (const rule of rules) {
        const splats = (rule.match(/\*/g) || []).length;
        assert.ok(splats <= 1, `"${rule}" 有 ${splats} 个 *，Pages 只允许一个`);
      }
    });

    it('keeps every line within the 2000 character limit', function () {
      for (const [i, line] of lines.entries()) {
        assert.ok(line.length <= 2000, `第 ${i + 1} 行有 ${line.length} 字符，超过 2000 上限`);
      }
    });

    it('indents every header under a rule', function () {
      // 顶格的 `Name: value` 会被当成一条新规则（URL），静默失效。
      let sawRule = false;
      for (const [i, line] of lines.entries()) {
        if (!line.trim() || line.trimStart().startsWith('#')) continue;
        if (!/^\s/.test(line)) {
          sawRule = true;
          assert.ok(line.startsWith('/') || line.startsWith('https://'),
            `第 ${i + 1} 行 "${line}" 既不是缩进的头部，也不像一个路径规则`);
        } else {
          assert.ok(sawRule, `第 ${i + 1} 行的头部前面没有任何规则`);
          assert.match(line, /^\s+!?[A-Za-z][A-Za-z0-9-]*:\s*\S/, `第 ${i + 1} 行不是合法的头部写法`);
        }
      }
    });
  });

  describe('Cloudflare Pages (_headers)', function () {
    it('caches versioned assets immutably', function () {
      for (const pattern of ['/*.css', '/*.js']) {
        const block = headers.split(pattern)[1] || '';
        assert.match(block.split(/\n\/|\n#/)[0], /max-age=31536000/, `${pattern} 没设一年强缓存`);
        assert.match(block.split(/\n\/|\n#/)[0], /immutable/, `${pattern} 缺 immutable`);
      }
    });

    it('keeps HTML revalidating', function () {
      // HTML 里写着带哈希的资源 URL，页面本身被强缓存的话新资源永远到不了用户手里。
      const htmlBlock = headers.slice(headers.indexOf('/*.html'));
      assert.match(htmlBlock, /Cache-Control: public, no-cache/);
      assert.doesNotMatch(htmlBlock, /immutable/);
    });

    it('does not strong-cache the unversioned icons', function () {
      // favicon / logo 按固定路径引用，没有版本串可打。
      for (const asset of ['/favicon.ico', '/logo.png']) {
        const block = headers.slice(headers.indexOf(asset));
        const firstRule = block.split(/\n\/|\n#/)[0];
        assert.doesNotMatch(firstRule, /immutable/, `${asset} 没有版本串，不能设 immutable`);
        assert.match(firstRule, /must-revalidate/, `${asset} 应带回源校验`);
      }
    });
  });

  describe('Docker (nginx)', function () {
    it('compresses the text assets', function () {
      assert.match(nginx, /^\s*gzip on;/m, '页面是未压缩的手写 CSS/JS，gzip 是主要收益来源');
      assert.match(nginx, /gzip_types[\s\S]*?text\/css/, 'gzip_types 没包含 CSS');
      assert.match(nginx, /gzip_types[\s\S]*?application\/javascript/, 'gzip_types 没包含 JS');
      assert.match(nginx, /gzip_vary on;/, '缺 gzip_vary，CDN 可能把压缩版发给不支持的客户端');
    });

    it('caches versioned assets immutably', function () {
      assert.match(nginx, /location ~\* \\\.\(\?:css\|js\|svg[^)]*\)\$/, '缺静态资源 location 块');
      const block = nginx.slice(nginx.indexOf('location ~* \\.(?:css|js|svg'));
      assert.match(block.slice(0, block.indexOf('}')), /max-age=31536000, immutable/);
    });

    it('declares the static asset block before the catch-all', function () {
      // nginx 里 `location /` 的 try_files 会先把请求答掉，缓存头就永远不生效。
      const assetAt = nginx.indexOf('location ~* \\.(?:css|js|svg');
      const catchAllAt = nginx.indexOf('location / {');
      assert.ok(assetAt !== -1 && catchAllAt !== -1);
      assert.ok(assetAt < catchAllAt, '静态资源块必须排在 location / 之前');
    });

    it('keeps HTML revalidating on both the html block and the SPA fallback', function () {
      for (const marker of ['location ~* \\.html$ {', 'location / {']) {
        const at = nginx.indexOf(marker);
        assert.notStrictEqual(at, -1, `找不到 ${marker}`);
        const block = nginx.slice(at, nginx.indexOf('}', at));
        assert.match(block, /Cache-Control "public, no-cache"/, `${marker} 缺 HTML 回源校验`);
      }
    });
  });

  it('keeps _headers out of the Docker image', function () {
    // _headers 是 Pages 专用控制文件；nginx 会把它当普通静态文件发出去。
    const dockerfile = fs.readFileSync(path.join(root, 'Dockerfile'), 'utf8');
    assert.doesNotMatch(dockerfile, /^COPY\s+_headers/m);
  });

  it('ships the generated icon subset in the Docker image', function () {
    // 图标子集是本地文件而非 CDN 依赖，漏拷进镜像的话 Docker 部署会整站没图标。
    const dockerfile = fs.readFileSync(path.join(root, 'Dockerfile'), 'utf8');
    const copiesAllJs = /^COPY\s+(?:[^\n]*\s)?\*\.js\b/m.test(dockerfile);
    const copiesSubset = /^COPY\s+(?:[^\n]*\s)?icons-subset\.js\b/m.test(dockerfile);
    assert.ok(copiesAllJs || copiesSubset, 'Dockerfile 没有把 icons-subset.js 拷进镜像');
  });
});
