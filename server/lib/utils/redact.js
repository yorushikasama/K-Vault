/**
 * Secret redaction helpers (requirement #13) — Docker/CommonJS variant.
 */

// 两个前缀都要匹配：只认新前缀的话，已经在用的 kvault_… 令牌会以明文
// 落进日志/错误信息/审计记录里 —— 脱敏漏一个前缀就是一次凭据泄露。
const TOKEN_PATTERN = /(?:yoruvault|kvault)_[A-Za-z0-9_-]{6,}/g;
const REDACTED = 'yoruvault_***REDACTED***';

function redactSecrets(input) {
  if (typeof input !== 'string') return input;
  return input.replace(TOKEN_PATTERN, REDACTED);
}

function redactErrorMessage(error) {
  if (error == null) return '';
  const message = typeof error === 'string' ? error : String(error?.message || error);
  return redactSecrets(message);
}

function safeLogError(error, ...rest) {
  try {
    console.error(redactErrorMessage(error), ...rest.map((item) => (
      typeof item === 'string' ? redactSecrets(item) : item
    )));
  } catch {
    // logging must never throw
  }
}

module.exports = {
  redactSecrets,
  redactErrorMessage,
  safeLogError,
};
