const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

describe('deployment entrypoint contract', function () {
  const root = path.resolve(__dirname, '..');

  it('keeps Cloudflare Pages deployment rooted at repository static pages', function () {
    const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));

    assert.match(pkg.scripts.build, /No build step required/);
    assert.doesNotMatch(pkg.scripts.build, /frontend|vite|dist/);
    assert.strictEqual(pkg.scripts['pages:deploy'], 'npx wrangler pages deploy .');
  });

  it('does not keep old frontend build assets as deployable UI', function () {
    const removedPaths = [
      'frontend/index.html',
      'frontend/landing',
      'frontend/src',
      'frontend/package.json',
      'frontend/vite.config.js',
      'frontend/Dockerfile',
      'frontend/nginx.conf',
      'server/Dockerfile',
      '_nuxt',
    ];

    for (const relativePath of removedPaths) {
      assert.strictEqual(fs.existsSync(path.join(root, relativePath)), false, `${relativePath} should not exist`);
    }
  });

  it('serves Docker from the same root static pages and proxies share routes', function () {
    const dockerfile = fs.readFileSync(path.join(root, 'Dockerfile'), 'utf8');
    const entrypoint = fs.readFileSync(path.join(root, 'docker', 'entrypoint.sh'), 'utf8');
    const nginx = fs.readFileSync(path.join(root, 'docker', 'nginx.conf'), 'utf8');
    const compose = fs.readFileSync(path.join(root, 'docker-compose.yml'), 'utf8');
    const imageWorkflow = fs.readFileSync(path.join(root, '.github', 'workflows', 'docker-image.yml'), 'utf8');

    assert.match(dockerfile, /COPY index\.html admin\.html gallery\.html webdav\.html/);
    assert.doesNotMatch(dockerfile, /_nuxt|frontend\/dist|frontend\/landing/);
    assert.match(dockerfile, /ENTRYPOINT \["yoruvault-entrypoint"\]/);
    assert.match(entrypoint, /ensure_secret CONFIG_ENCRYPTION_KEY/);
    assert.match(entrypoint, /runtime\.env/);
    assert.match(nginx, /location\s+\/s\//);
    assert.match(nginx, /GET\/HEAD render the root upload UI/);
    // 镜像仍是上游发布的那一个：本 fork 未在 ghcr 另发镜像，改成自己的名字会拉不到。
    assert.match(compose, /ghcr\.io\/katelya77\/k-vault:latest/);
    assert.match(compose, /required:\s+false/);
    assert.doesNotMatch(compose, /kvault-api|kvault-web|frontend\/Dockerfile|server\/Dockerfile/);
    assert.match(imageWorkflow, /IMAGE_NAME: yoruvault/);
    assert.doesNotMatch(imageWorkflow, /yoruvault-api|yoruvault-web|matrix:/);
  });

  it('keeps the names that address existing state', function () {
    // 改名时最容易伤到的是「看着像名字、其实是既有状态键」的那一批。
    // 这些一旦被顺手改成新名，后果都是静默的：数据卷挂空、库开新文件、
    // 已上传的文件找不到、已签发的令牌验不过。
    const root = path.resolve(__dirname, '..');
    const read = (f) => fs.readFileSync(path.join(root, f), 'utf8');
    const compose = read('docker-compose.yml');
    const dockerfile = read('Dockerfile');

    // docker 卷名：改了等于换一个空卷挂载，数据「消失」
    assert.match(compose, /kvault_data:\/app\/data/);
    assert.match(compose, /kvault_redis:\/data/);
    // 数据库文件名：改了等于服务去开一个新空库
    assert.match(dockerfile, /DB_PATH=\/app\/data\/k-vault\.db/);
    // GitHub 存储的 release tag：改了会让已上传的文件在新 tag 下全部找不到
    assert.match(read('server/lib/storage/adapters/github.js'), /'k-vault-storage'/);
    assert.match(read('functions/utils/github.js'), /'k-vault-storage'/);
    // API token 前缀：新签发的用新前缀
    assert.match(read('server/lib/repos/api-token-repo.js'), /TOKEN_PREFIX = 'yoruvault_'/);
    assert.match(read('functions/utils/api-token.js'), /TOKEN_PREFIX = 'yoruvault_'/);
    // 会话 cookie 名：改了等于所有人被登出
    assert.match(read('functions/utils/auth.js'), /'k_vault_session'/);
  });

  it('still accepts tokens and secrets issued under the old name', function () {
    // 改名最容易造成的一次性破坏：已签发的 API token 明文是 kvault_…，
    // 解析正则只认新前缀的话，所有在用的集成当场失效；脱敏正则只认新前缀
    // 的话，旧 token 会以明文落进日志。两条都必须同时认新旧。
    const root = path.resolve(__dirname, '..');
    const read = (f) => fs.readFileSync(path.join(root, f), 'utf8');

    for (const f of [
      'server/lib/repos/api-token-repo.js',
      'functions/utils/api-token.js',
      'functions/api/v1/_middleware.js',
    ]) {
      assert.match(read(f), /\(\?:yoruvault\|kvault\)_/,
        `${f} 的令牌解析必须同时接受新旧前缀，否则旧令牌全部失效`);
    }
    for (const f of ['server/lib/utils/redact.js', 'functions/utils/redact.js']) {
      assert.match(read(f), /\(\?:yoruvault\|kvault\)_\[A-Za-z0-9_-\]\{6,\}/,
        `${f} 的脱敏正则必须覆盖旧前缀，否则旧令牌会明文进日志`);
    }

    // 行为验证：旧前缀的令牌仍能解析出 id
    const legacy = 'kvault_abc123def456_' + 'x'.repeat(24);
    const newForm = 'yoruvault_abc123def456_' + 'x'.repeat(24);
    const re = /^(?:yoruvault|kvault)_([A-Za-z0-9_-]{6,128})_([A-Za-z0-9_-]{16,256})$/;
    assert.ok(re.test(legacy), '旧前缀令牌应仍可解析');
    assert.ok(re.test(newForm), '新前缀令牌应可解析');
    assert.strictEqual(re.exec(legacy)[1], 'abc123def456');
  });

  it('name changes keep working for existing installs', function () {
    // 改名不能是破坏性的：容器名与镜像可覆盖变量都保留了旧值回退，
    // 这样用户 .env 里已经写好的 KVAULT_IMAGE 继续生效。
    const root = path.resolve(__dirname, '..');
    const compose = fs.readFileSync(path.join(root, 'docker-compose.yml'), 'utf8');
    assert.match(compose, /YORUVAULT_IMAGE:-/);
    assert.match(compose, /\$\{KVAULT_IMAGE:-/, '丢弃 KVAULT_IMAGE 回退会让既有 .env 失效');

    // 运维脚本的环境变量新名优先、旧名兜底
    const ssh = fs.readFileSync(path.join(root, 'scripts', 'remote-ssh.py'), 'utf8');
    assert.match(ssh, /os\.environ\.get\("YV_SSH_PASSWORD"/);
    assert.match(ssh, /or os\.environ\.get\("KV_SSH_PASSWORD"/);
  });
});
