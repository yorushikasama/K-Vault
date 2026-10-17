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

  describe('security response headers on both deployments', function () {
    // 两套部署各有一套响应头来源：Pages 走 _headers，Docker 走 nginx.conf。
    // 任何一侧漏配，同一份前端在两种部署下防护等级就不同，所以这里双端一起锁。
    it('sets nosniff on versioned assets in _headers', function () {
      for (const pattern of ['/*.css', '/*.js', '/*.svg', '/*.woff2']) {
        const block = (headers.split(pattern)[1] || '').split(/\n\/|\n#/)[0];
        assert.match(block, /X-Content-Type-Options:\s*nosniff/, `${pattern} 缺 nosniff`);
      }
    });

    it('sets nosniff on the asset location in nginx', function () {
      const at = nginx.indexOf('location ~* \\.(?:css|js|svg');
      assert.notStrictEqual(at, -1, '找不到静态资源 location 块');
      const block = nginx.slice(at, nginx.indexOf('}', at));
      assert.match(block, /X-Content-Type-Options\s+"?\s*nosniff/, 'nginx 静态资源块缺 nosniff');
    });

    it('denies framing on HTML in both deployments', function () {
      const htmlBlocks = [headers.slice(headers.indexOf('/*.html'))];
      for (const marker of ['location ~* \\.html$ {', 'location / {']) {
        const at = nginx.indexOf(marker);
        assert.notStrictEqual(at, -1, `找不到 ${marker}`);
        htmlBlocks.push(nginx.slice(at, nginx.indexOf('}', at)));
      }
      for (const block of htmlBlocks) {
        assert.match(block, /X-Frame-Options:\s*DENY|X-Frame-Options\s+"?\s*DENY/i,
          'HTML 响应缺 X-Frame-Options: DENY');
      }
    });
  });

  it('ships the generated icon subset in the Docker image', function () {
    // 图标子集是本地文件而非 CDN 依赖，漏拷进镜像的话 Docker 部署会整站没图标。
    const dockerfile = fs.readFileSync(path.join(root, 'Dockerfile'), 'utf8');
    const copiesAllJs = /^COPY\s+(?:[^\n]*\s)?\*\.js\b/m.test(dockerfile);
    const copiesSubset = /^COPY\s+(?:[^\n]*\s)?icons-subset\.js\b/m.test(dockerfile);
    assert.ok(copiesAllJs || copiesSubset, 'Dockerfile 没有把 icons-subset.js 拷进镜像');
  });

  describe('wallpaper files cache, public file links do not', function () {
    /**
     * /file/ 直链的默认策略必须是 no-store：文件可能被删除、封禁或移入白名单，
     * 缓存住了就会继续被读到。
     *
     * 但站点壁纸也走 /file/，每次切页都重下整张图（线上 514 KB）是切页卡顿的
     * 主因。所以两套部署都按「请求是否带 v 版本参数」分流：带 v 是调用方在
     * 声明 URL 内容不变，放行长缓存；不带就是普通直链，维持 no-store。
     */
    const nodeServer = fs.readFileSync(path.join(root, 'server', 'app.js'), 'utf8');
    const pagesFn = fs.readFileSync(path.join(root, 'functions', 'file', '[id].js'), 'utf8');
    const themeEffects = fs.readFileSync(path.join(root, 'theme-effects.js'), 'utf8');

    it('node server branches on the v parameter', function () {
      assert.match(nodeServer, /immutable: Boolean\(c\.req\.query\('v'\)\)/,
        'server/app.js 没有按 v 参数分流缓存策略');
      assert.match(nodeServer, /options\.immutable \? 'public, max-age=31536000, immutable' : 'no-store, max-age=0'/,
        'server/app.js 的 Cache-Control 分流不见了');
    });

    it('cloudflare function branches on the v parameter', function () {
      assert.match(pagesFn, /new URL\(request\.url\)\.searchParams\.has\('v'\)/,
        'functions/file/[id].js 没有按 v 参数分流缓存策略');
      assert.match(pagesFn, /requestDeclaresImmutable \? 'public, max-age=31536000, immutable' : 'no-store, max-age=0'/,
        'functions/file/[id].js 的 Cache-Control 分流不见了');
    });

    it('wallpaper URLs carry the v fingerprint', function () {
      // 前端不带 v 的话服务端永远走 no-store，优化等于没做。
      assert.match(themeEffects, /function withWallpaperCacheKey\(url\)/,
        'theme-effects.js 缺少壁纸 URL 的 v 指纹生成');
      assert.match(themeEffects, /searchParams\.set\("v", hash\.toString\(36\)\)/,
        '壁纸 v 指纹没有写进 URL');
    });

    it('external wallpapers are left untouched', function () {
      // 外部图床不归本站代理，加参数只会打扰对方服务器。
      assert.match(themeEffects, /if \(parsed\.origin !== window\.location\.origin\) return url;/,
        '外部壁纸 URL 不应被附加 v 参数');
    });
  });

  describe('dynamic file routes outrank the static-asset regex', function () {
    /**
     * nginx 的正则 location 优先级高于普通前缀 location —— 这条规则本身没错，
     * 但两处叠起来会出事：修 WebDAV 遗留 404 时加的静态资源 404 规则
     *   location ~* \.(?:css|js|svg|png|jpe?g|gif|webp|ico|...)$ { try_files $uri =404; }
     * 会把 /file/<id>.<图片后缀> 也收走，而文件 ID 是以真实扩展名结尾的
     * （gallery 用 /file/<name> 取图）。后果是整个图库全挂，而 .mp4 不在
     * 正则列表里幸免 —— 看起来像「只有图片坏了」，很难联想到路由。
     *
     * 2026-10-14 实测：Node 直连 /file/<id>.avif 返回 200 image/avif，
     * 经过裸机 nginx 变 404。修法是给 /file/ 加 ^~（此前缀命中后不再评估
     * 正则 location）。这里钉住它，防止有人「整理配置」时把 ^~ 去掉。
     */
    const staticRegex = /location ~\* \\\.\(\?:[^)]*(?:png|jpe?g|gif|webp|avif|svg|ico)[^)]*\)\$/;

    it('docker/nginx.conf marks /file/ as ^~', function () {
      assert.match(nginx, staticRegex, 'docker/nginx.conf 里找不到静态资源正则 location，测试前提变了');
      assert.match(
        nginx,
        /location \^~ \/file\/ \{/,
        'docker/nginx.conf 的 /file/ 缺少 ^~，带图片后缀的文件会被静态资源正则抢走并 404'
      );
    });

    it('the ^~ prefix is explained, not just present', function () {
      // ^~ 看起来是可有可无的修饰符，很容易在「精简配置」时被删掉，
      // 所以要求就地留下理由。
      const m = /location \^~ \/file\/ \{/.exec(nginx);
      const before = nginx.slice(Math.max(0, m.index - 700), m.index);
      assert.match(before, /\^~/, '^~ 旁边没有说明它为什么必须留着');
    });

    it('docker/nginx.conf marks /api/ as ^~ (SEC-10)', function () {
      // 2026-10-17 生产实测：/api/manage/delete/<id>.html 被 \.html$ 静态
      // 正则截胡返回 nginx 404 —— 凡文件 ID 以 .html 等扩展名结尾的 manage
      // 端点（delete/editName/block/white/toggleLike）与 DELETE /api/v1/file/:id
      // 全部中招，与 /file/ 的坑同源，修法同样是 ^~。
      assert.match(
        nginx,
        /location \^~ \/api\/ \{/,
        'docker/nginx.conf 的 /api/ 缺少 ^~，带 .html 后缀文件 ID 的 manage/v1 端点会被静态正则抢走并 404'
      );
    });

    it('file IDs keep their extensions in the frontend', function () {
      // 这条是上面那条规则的前提：如果前端改成用没有扩展名的 ID，
      // ^~ 就不再是必需的，这条断言会失败，提醒重新评估。
      const gallery = fs.readFileSync(path.join(root, 'gallery.html'), 'utf8');
      assert.match(gallery, /:src="'\/file\/' \+ img\.name"/,
        'gallery 不再用 /file/<name> 取图；若已改成无后缀 ID，请重新评估 /file/ 的 ^~ 是否还需要');
    });
  });
});
