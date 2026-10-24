/**
 * 认证工具模块
 * 支持 Cookie-based 会话认证和 Basic Auth
 */

const SESSION_COOKIE_NAME = 'k_vault_session';
const LEGACY_SESSION_COOKIE_NAME = 'katelya_session';
const SESSION_DURATION = 24 * 60 * 60 * 1000; // 24小时

/**
 * 生成会话令牌
 */
export function generateSessionToken() {
  const array = new Uint8Array(32);
  crypto.getRandomValues(array);
  return Array.from(array, byte => byte.toString(16).padStart(2, '0')).join('');
}

/**
 * 验证 Basic Auth 凭据
 */
export function verifyBasicAuth(request, env) {
  const authorization = request.headers.get('Authorization');
  if (!authorization) return null;

  const [scheme, encoded] = authorization.split(' ');
  if (!encoded || scheme !== 'Basic') return null;

  try {
    const buffer = Uint8Array.from(atob(encoded), c => c.charCodeAt(0));
    const decoded = new TextDecoder().decode(buffer).normalize();
    const index = decoded.indexOf(':');
    
    if (index === -1 || /[\0-\x1F\x7F]/.test(decoded)) return null;

    const user = decoded.substring(0, index);
    const pass = decoded.substring(index + 1);

    if (env.BASIC_USER === user && env.BASIC_PASS === pass) {
      return { user, authenticated: true };
    }
  } catch (e) {
    console.error('Basic auth decode error:', e);
  }
  return null;
}

/**
 * 从 Cookie 获取会话
 */
export function getSessionFromCookie(request) {
  const cookieHeader = request.headers.get('Cookie');
  if (!cookieHeader) return null;

  const cookies = cookieHeader.split(';').map(c => c.trim());
  for (const cookie of cookies) {
    // 只在第一个 = 处切开：cookie 值本身可以含 =（base64 填充、JWT）。
    // `cookie.split('=')` 解构会把值里第一个 = 之后的部分整个丢掉，
    // 与 server/lib/utils/auth.js 的 rest.join('=') 不一致——同一段
    // Cookie 头在两个后端会解析出不同的会话令牌。
    const [name, ...rest] = cookie.split('=');
    if (name === SESSION_COOKIE_NAME || name === LEGACY_SESSION_COOKIE_NAME) {
      return rest.join('=');
    }
  }
  return null;
}

/**
 * 验证会话令牌
 */
export async function verifySession(sessionToken, env) {
  if (!sessionToken || !env.img_url) return false;
  
  try {
    const sessionData = await env.img_url.get(`session:${sessionToken}`, { type: 'json' });
    if (!sessionData) return false;
    
    // 检查会话是否过期
    if (Date.now() > sessionData.expiresAt) {
      await env.img_url.delete(`session:${sessionToken}`);
      return false;
    }
    
    return true;
  } catch (e) {
    console.error('Session verify error:', e);
    return false;
  }
}

/**
 * 创建会话
 */
export async function createSession(user, env) {
  const token = generateSessionToken();
  const sessionData = {
    user,
    createdAt: Date.now(),
    expiresAt: Date.now() + SESSION_DURATION
  };
  
  await env.img_url.put(`session:${token}`, JSON.stringify(sessionData), {
    expirationTtl: Math.floor(SESSION_DURATION / 1000)
  });
  
  return token;
}

/**
 * 删除会话
 */
export async function deleteSession(sessionToken, env) {
  if (sessionToken && env.img_url) {
    await env.img_url.delete(`session:${sessionToken}`);
  }
}

/**
 * 创建带会话 Cookie 的响应
 */
export function createSessionCookieHeader(token, maxAge = SESSION_DURATION / 1000) {
  return `${SESSION_COOKIE_NAME}=${token}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${maxAge}`;
}

/**
 * 创建清除会话 Cookie 的响应头
 */
export function createClearSessionCookieHeader() {
  return `${SESSION_COOKIE_NAME}=; Path=/; HttpOnly; SameSite=Strict; Max-Age=0`;
}

export function createLegacyClearSessionCookieHeader() {
  return `${LEGACY_SESSION_COOKIE_NAME}=; Path=/; HttpOnly; SameSite=Strict; Max-Age=0`;
}

/**
 * 检查是否需要认证
 *
 * 必须返回严格布尔值：`&&` 会返回最后一个操作数的「值」而非布尔值，
 * 直接 return env.BASIC_USER && env.BASIC_PASS 会把 BASIC_PASS 明文
 * 泄漏给任何序列化该返回值的调用方（历史漏洞：GET /api/auth/login）。
 */
export function isAuthRequired(env) {
  return Boolean(env?.BASIC_USER && env?.BASIC_PASS);
}

/**
 * 综合认证检查
 */
export async function checkAuthentication(context) {
  const { request, env } = context;
  
  // 如果没有配置认证，直接放行
  if (!isAuthRequired(env)) {
    return { authenticated: true, reason: 'no-auth-required' };
  }
  
  // 检查 Cookie 会话
  const sessionToken = getSessionFromCookie(request);
  if (sessionToken && await verifySession(sessionToken, env)) {
    return { authenticated: true, reason: 'session', token: sessionToken };
  }
  
  // 检查 Basic Auth
  const basicAuth = verifyBasicAuth(request, env);
  if (basicAuth) {
    return { authenticated: true, reason: 'basic-auth', user: basicAuth.user };
  }
  
  return { authenticated: false };
}
