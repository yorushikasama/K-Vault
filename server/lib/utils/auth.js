const crypto = require('node:crypto');
const { run, get } = require('../../db');

const LEGACY_COOKIE_NAME = 'katelya_session';

function parseCookies(cookieHeader = '') {
  const result = {};
  if (!cookieHeader) return result;

  cookieHeader.split(';').forEach((chunk) => {
    const [rawName, ...rest] = chunk.trim().split('=');
    if (!rawName) return;
    const rawValue = rest.join('=');
    result[rawName] = decodeURIComponent(rawValue || '');
  });

  return result;
}

class AuthService {
  constructor(db, config) {
    this.db = db;
    this.config = config;
  }

  isAuthRequired() {
    return Boolean(this.config.basicUser && this.config.basicPass);
  }

  generateToken() {
    return crypto.randomBytes(32).toString('hex');
  }

  verifyBasicAuth(headerValue = '') {
    if (!headerValue || !headerValue.startsWith('Basic ')) return null;

    try {
      const encoded = headerValue.slice('Basic '.length).trim();
      const decoded = Buffer.from(encoded, 'base64').toString('utf8');
      const separator = decoded.indexOf(':');
      if (separator === -1) return null;
      const user = decoded.slice(0, separator);
      const pass = decoded.slice(separator + 1);

      if (user === this.config.basicUser && pass === this.config.basicPass) {
        return { authenticated: true, user, reason: 'basic-auth' };
      }
    } catch (error) {
      return null;
    }

    return null;
  }

  createSession(userName, { remember = false } = {}) {
    const now = Date.now();
    // 「记住登录状态」勾上就给长效会话，没勾仍是默认时长。服务端记录
    // remember 而不是只在 cookie 上写 Max-Age：浏览器里那份 Max-Age 只是
    // 客户端的副本，DB 里的 expires_at 才是服务端真正的判定依据（getSession
    // 只看后者）。只改 cookie 会话在服务端照样过期，而浏览器还留着 cookie，
    // 表现就是「明明记住登录了，却一直被踢回登录页」。
    const durationMs = remember
      ? Math.max(this.config.sessionDurationMs, this.config.rememberedSessionDurationMs)
      : this.config.sessionDurationMs;
    const expiresAt = now + durationMs;
    const token = this.generateToken();

    run(
      this.db,
      `INSERT INTO sessions(token, user_name, created_at, expires_at)
       VALUES (?, ?, ?, ?)` ,
      [token, userName, now, expiresAt]
    );

    return { token, expiresAt };
  }

  deleteSession(token) {
    if (!token) return;
    run(this.db, 'DELETE FROM sessions WHERE token = ?', [token]);
  }

  getSession(token) {
    if (!token) return null;
    const row = get(this.db, 'SELECT * FROM sessions WHERE token = ?', [token]);
    if (!row) return null;
    if (Date.now() > row.expires_at) {
      this.deleteSession(token);
      return null;
    }
    return row;
  }

  getSessionTokenFromRequest(request) {
    const cookies = parseCookies(request.headers.get('cookie') || '');
    return cookies[this.config.sessionCookieName] || cookies[LEGACY_COOKIE_NAME] || null;
  }

  createSessionCookie(token, expiresAt = 0) {
    const base = `${this.config.sessionCookieName}=${encodeURIComponent(token)}; Path=/; HttpOnly; SameSite=Strict`;
    // 会话 cookie（不勾「记住登录状态」）：不给 Max-Age，让它在浏览器关闭时
    // 一起消失；勾了则按服务端 expires_at 写到那一天为止，两者一致。
    if (!expiresAt) return base;
    const maxAge = Math.max(0, Math.floor((expiresAt - Date.now()) / 1000));
    return `${base}; Max-Age=${maxAge}`;
  }

  createClearSessionCookies() {
    return [
      `${this.config.sessionCookieName}=; Path=/; HttpOnly; SameSite=Strict; Max-Age=0`,
      `${LEGACY_COOKIE_NAME}=; Path=/; HttpOnly; SameSite=Strict; Max-Age=0`,
    ];
  }

  checkAuthentication(request) {
    if (!this.isAuthRequired()) {
      return { authenticated: true, reason: 'no-auth-required', user: 'anonymous' };
    }

    const sessionToken = this.getSessionTokenFromRequest(request);
    const session = this.getSession(sessionToken);
    if (session) {
      return {
        authenticated: true,
        reason: 'session',
        token: sessionToken,
        user: session.user_name,
      };
    }

    const basicAuth = this.verifyBasicAuth(request.headers.get('authorization') || '');
    if (basicAuth) return basicAuth;

    return { authenticated: false, reason: 'unauthorized' };
  }
}

module.exports = {
  AuthService,
  parseCookies,
};
