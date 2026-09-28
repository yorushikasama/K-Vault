function normalizeErrorMessage(error, fallback = 'Unknown storage error') {
  if (!error) return fallback;
  let message;
  if (typeof error === 'string') {
    message = error;
  } else if (error instanceof Error && error.message) {
    message = error.message;
  } else if (typeof error.message === 'string' && error.message) {
    message = error.message;
  } else {
    try {
      message = JSON.stringify(error);
    } catch {
      return fallback;
    }
  }

  // undici hides the real reason in `cause`: a failed upload reports
  // "fetch failed", which is useless without knowing whether it was ECONNRESET,
  // a premature body close or something else entirely.
  const cause = error && error.cause;
  if (cause) {
    const causeText = cause.code || cause.message || String(cause);
    if (causeText) message += ` (cause: ${causeText})`;
  }
  return message;
}

function classifyStorageError(error, status) {
  const message = normalizeErrorMessage(error).toLowerCase();
  const statusCode = Number(status || 0);

  const byStatus = (codes) => codes.includes(statusCode);
  const byMessage = (pattern) => pattern.test(message);

  if (
    byStatus([401, 403]) ||
    byMessage(/\bauth|unauthori[sz]ed|forbidden|invalid token|permission denied\b/)
  ) {
    return {
      code: 'AUTH_FAILED',
      message: 'Authentication failed or permission denied.',
      retriable: false,
    };
  }

  if (
    byStatus([429]) ||
    byMessage(/\brate limit|too many requests|flood wait|throttle\b/)
  ) {
    return {
      code: 'RATE_LIMITED',
      message: 'Rate limit reached, retry later.',
      retriable: true,
    };
  }

  if (
    byStatus([413, 507, 509]) ||
    byMessage(/\bquota|insufficient storage|storage limit|file too large|payload too large\b/)
  ) {
    return {
      code: 'QUOTA_EXCEEDED',
      message: 'Storage quota or size limit exceeded.',
      retriable: false,
    };
  }

  if (
    byStatus([404]) ||
    byMessage(/\bnot found|path does not exist|no such file|missing resource\b/)
  ) {
    return {
      code: 'PATH_NOT_FOUND',
      message: 'Target path or resource does not exist.',
      retriable: false,
    };
  }

  if (
    byMessage(/\bnot configured|missing required|requires .*token|requires .*id\b/)
  ) {
    return {
      code: 'NOT_CONFIGURED',
      message: 'Storage adapter is not configured yet.',
      retriable: false,
    };
  }

  if (
    byStatus([408, 502, 503, 504]) ||
    byMessage(/\bnetwork|timeout|timed out|fetch failed|econn|enotfound|eai_again|socket\b/)
  ) {
    return {
      code: 'NETWORK_ERROR',
      message: 'Network timeout or upstream connectivity issue.',
      retriable: true,
    };
  }

  return {
    code: 'UNKNOWN',
    message: 'Unexpected storage error.',
    retriable: false,
  };
}

function toStorageErrorPayload(error, status) {
  const normalized = classifyStorageError(error, status);
  return {
    ...normalized,
    detail: normalizeErrorMessage(error),
    status: Number(status || 0) || undefined,
  };
}

module.exports = {
  classifyStorageError,
  normalizeErrorMessage,
  toStorageErrorPayload,
};
