const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

/**
 * 死路由清理契约——被 Pages 文件路由"隐式引用"的端点。
 *
 * 背景（2026-10-21 审计发现，高危）：functions/api/r2/upload.js 是首次
 * 提交就带进来的脚手架，前端零引用、测试零引用、文档零提及、Docker 端
 * 无对应路由——实际上传走 /upload 与 /api/chunked-upload/*。dead:check
 * 扫不到它：其导出被 Pages 文件路由机制隐式引用（见
 * docs/dead-code-boundaries.md 第四节），静态"无引用"判定对路由文件
 * 天然失明。
 *
 * 它却是一颗活雷：无会话/Basic 鉴权、无访客限额、arrayBuffer() 无上限、
 * 任意 MIME；GET 以 inline + attacker-controlled Content-Type +
 * Cache-Control: public 返回内容（存储型 XSS），fileName 未转义
 * （Content-Disposition 注入）。开着 BASIC_USER/PASS 的部署，任何人
 * 仍可 POST 任意文件写满 R2 免费额度。
 *
 * 为什么可以证死（与边界文档"不能证死"的三类不同）：路由文件的唯一
 * "引用方"是框架的文件路由，真正的调用方只能是发起 HTTP 请求的人——
 * 除框架外全仓零调用的路由，其调用方就只剩攻击者。
 *
 * 这组测试钉住两件事：
 *   1. 已删的路由不许回来；
 *   2. 任何新增的 R2_BUCKET.put 写入点必须挂鉴权链——按"能力"而不是
 *      按文件名设防，换名字绕不过去。
 */
describe('dead route stays dead (functions/api/r2/upload.js)', function () {
  const root = path.resolve(__dirname, '..');

  it('functions/api/r2/ 目录不存在', function () {
    assert.strictEqual(
      fs.existsSync(path.join(root, 'functions', 'api', 'r2')),
      false,
      'functions/api/r2/ 又出现了——它是无鉴权、无限额的裸上传端点，' +
      '实际入口是 /upload 与 /api/chunked-upload/*。若确需新端点，' +
      '必须走鉴权链（checkAuthentication）并补访客限额与大小限制。'
    );
  });

  it('每个 R2_BUCKET.put 调用点都必须处于鉴权闸门之内', function () {
    // 合法写入点（2026-10-21 核对）分两类：
    //   - 文件自带闸门：functions/upload.js（会话/Basic + 访客限额 + 大小
    //     上限）、functions/api/chunked-upload/chunk.js、
    //     functions/api/upload-from-url.js（认证 → 未认证走访客限额，
    //     与 Docker 端同名端点对齐）
    //   - 子树中间件兜底：functions/api/v1/* 由 v1/_middleware.js 做令牌
    //     鉴权（verifyApiToken），文件本体不需要再 import
    // 判定按内容而不是白名单：新写入点若两层闸门都不沾即失败。
    const AUTH_SYMBOLS = /checkAuthentication|isAuthRequired|verifyApiToken|requireApiToken/;
    const functionsRoot = path.join(root, 'functions');

    /** 从 dir 往上收集到 functions/ 为止的全部 _middleware.js 源码。 */
    const middlewareSources = (dir) => {
      const sources = [];
      let cur = dir;
      while (cur.startsWith(functionsRoot)) {
        const mw = path.join(cur, '_middleware.js');
        if (fs.existsSync(mw)) sources.push(fs.readFileSync(mw, 'utf8'));
        const parent = path.dirname(cur);
        if (parent === cur) break;
        cur = parent;
      }
      return sources;
    };

    const offenders = [];
    const walk = (dir) => {
      for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) { walk(full); continue; }
        if (!entry.name.endsWith('.js')) continue;
        const src = fs.readFileSync(full, 'utf8');
        if (!/R2_BUCKET\s*\.\s*put\s*\(/.test(src)) continue;
        const selfGated = AUTH_SYMBOLS.test(src);
        const subtreeGated = middlewareSources(path.dirname(full)).some((mw) => AUTH_SYMBOLS.test(mw));
        if (!selfGated && !subtreeGated) {
          offenders.push(path.relative(root, full));
        }
      }
    };
    walk(functionsRoot);
    assert.deepStrictEqual(offenders, [],
      '以下文件向 R2 写入数据却不在任何鉴权闸门之内（文件自身无 ' +
      'checkAuthentication/verifyApiToken，祖先目录的 _middleware.js 也不做鉴权）' +
      '——开启 BASIC_USER/PASS 的部署上这是任何人可写的免费额度黑洞');
  });
});
