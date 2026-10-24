const assert = require('node:assert');

/**
 * Cookie 解析双端一致性契约。
 *
 * 起因：functions/utils/auth.js 曾用 `cookie.split('=')` 解构取值，
 * cookie 值本身含 = 时（base64 填充、JWT），第一个 = 之后的部分被整个
 * 丢掉；server/lib/utils/auth.js 用 rest.join('=') 则正确保留。同一份
 * Cookie 头在两个后端解析出不同的会话令牌 —— Pages 部署上表现为"明明
 * 登录了，部分接口仍 401"，且取决于走了哪条后端，极难排查。
 *
 * 本契约加载两个真实模块，断言同一组 Cookie 头解析出同一个会话令牌。
 * 两个后端签发的令牌都是 hex（不含 = 与 %），所以这里只钉「= 的切分」
 * 这一处；值的百分号解码差异（server 写 encodeURIComponent）是各端
 * 写入方式的对称结果，不属于本契约。
 */
describe('cookie parsing parity (functions vs server)', function () {
  let getSessionFromCookie;
  let parseCookies;

  before(async function () {
    ({ getSessionFromCookie } = await import('../functions/utils/auth.js'));
    ({ parseCookies } = require('../server/lib/utils/auth.js'));
  });

  const functionsSide = (header) =>
    getSessionFromCookie(new Request('https://example.com/', { headers: { Cookie: header } }));

  // server 端按名字查表（parseCookies 是通用解析器，取哪个名字由调用方
  // 决定——getServiceTokenFromRequest 依次试现名与旧名，这里照做）。
  const serverSide = (header, name) => parseCookies(header)[name] ?? null;

  // [说明, Cookie 头, functions 端应返回, server 端应查的名字]
  const CASES = [
    ['普通值', 'k_vault_session=abc123', 'abc123', 'k_vault_session'],
    // base64 填充、JWT 式载荷都会带的尾随 =
    ['值含单个 =', 'k_vault_session=abc=def', 'abc=def', 'k_vault_session'],
    ['值含尾随 ==', 'k_vault_session=abc==', 'abc==', 'k_vault_session'],
    ['值全由 = 组成', 'k_vault_session===', '==', 'k_vault_session'],
    ['目标不在第一位', 'theme=dark=1; k_vault_session=tok; other=x=y', 'tok', 'k_vault_session'],
    // trim 只作用于片段两端，值内部的空格保留
    ['值带内部空格', 'k_vault_session=  spaced  ', '  spaced', 'k_vault_session'],
    ['旧 cookie 名', 'katelya_session=legacy=tok=', 'legacy=tok=', 'katelya_session'],
  ];

  for (const [label, header, expected, serverName] of CASES) {
    it(`${label}：双端一致且与预期相同（${header}）`, function () {
      assert.strictEqual(functionsSide(header), expected, 'functions 端解析不符');
      assert.strictEqual(serverSide(header, serverName), expected, 'server 端解析不符');
    });
  }

  it('空值与缺 = 的片段不抛错，双端都拿到空', function () {
    assert.strictEqual(functionsSide('k_vault_session='), '');
    assert.strictEqual(serverSide('k_vault_session=', 'k_vault_session'), '');

    // 没有 = 的片段：functions 端返回 ''（rest 为空 join 成空串），
    // server 端也是 ''（rawValue || ''），两者对调用方（if (!token)）等价。
    assert.strictEqual(functionsSide('k_vault_session'), '');
    assert.strictEqual(serverSide('k_vault_session', 'k_vault_session'), '');
  });
});
