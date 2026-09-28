/**
 * SSRF-safe remote fetch, shared by the two endpoints that pull an arbitrary
 * URL server-side: POST /api/upload-from-url and POST /api/v1/import.
 *
 * Both used to carry their own copy of this logic, and only the v1 one had the
 * safety checks. Keeping a single implementation means a fix cannot land in one
 * caller and silently miss the other.
 *
 * Responsibility split:
 *   - this module throws for structural failures only (unsafe URL, unsafe
 *     redirect, too many redirects, transport error);
 *   - HTTP error *statuses* are deliberately NOT interpreted here — the response
 *     is handed back as-is so each caller keeps its own error contract.
 */

const { assertSafeRemoteUrl, validateRedirectLocation, MAX_REDIRECTS } = require('./ssrf-guard');

function remoteFetchError(code, status, message) {
  const error = new Error(message);
  error.code = code;
  error.status = status;
  return error;
}

/**
 * Fetch `url`, re-validating every redirect hop.
 *
 * Validating only the first URL is pointless: any public host can answer
 * `302 Location: http://127.0.0.1:8787/...` and reach the internal network.
 * Redirects are therefore followed manually, one hop at a time, with a full
 * DNS + literal-address check on each target.
 */
async function fetchRemote({
  url,
  headers = null,
  timeoutMs = 30000,
  maxRedirects = MAX_REDIRECTS,
} = {}) {
  let currentUrl = String(url || '').trim();

  for (let hop = 0; hop <= maxRedirects; hop += 1) {
    const safety = await assertSafeRemoteUrl(currentUrl);
    if (!safety.ok) {
      throw remoteFetchError(
        safety.code || 'SSRF_BLOCKED',
        safety.code === 'INVALID_URL' ? 400 : 403,
        safety.message || 'Unsafe remote URL.'
      );
    }

    let response;
    try {
      response = await fetch(currentUrl, {
        redirect: 'manual',
        headers: headers ? { ...headers } : undefined,
        signal: AbortSignal.timeout(Math.max(1000, Number(timeoutMs) || 30000)),
      });
    } catch (error) {
      throw remoteFetchError(
        'IMPORT_FETCH_FAILED',
        502,
        `Failed to fetch remote URL: ${error?.message || 'network error'}`
      );
    }

    if (response.status >= 300 && response.status < 400) {
      const location = response.headers.get('location') || '';
      if (!location) {
        throw remoteFetchError(
          'IMPORT_REDIRECT_INVALID',
          502,
          'Remote server returned a redirect without a location.'
        );
      }
      const redirectCheck = validateRedirectLocation(location, currentUrl);
      if (!redirectCheck.ok) {
        throw remoteFetchError(
          redirectCheck.code || 'SSRF_BLOCKED',
          redirectCheck.code === 'INVALID_REDIRECT' ? 502 : 403,
          redirectCheck.message || 'Unsafe redirect target.'
        );
      }
      try {
        await response.body?.cancel();
      } catch {
        // The socket may already be gone; nothing to release.
      }
      currentUrl = redirectCheck.url.href;
      continue;
    }

    return { response, finalUrl: currentUrl };
  }

  throw remoteFetchError(
    'IMPORT_TOO_MANY_REDIRECTS',
    502,
    `Too many redirects (max ${maxRedirects}).`
  );
}

/**
 * Read a response body into a Buffer while enforcing `maxBytes`.
 *
 * Two layers, because either alone is insufficient:
 *   1. a declared Content-Length over the cap is refused before a single byte is
 *      allocated — buffering a file only to reject it costs several times its
 *      size on the heap;
 *   2. the body is then streamed with a running total, so a body that lies about
 *      (or omits) its length is still abandoned the moment it crosses the cap.
 *
 * `maxBytes` is a hard ceiling with no special case for 0: pass `Infinity` to
 * opt out explicitly. Both callers already always pass a configured limit, and
 * silently reading an unbounded body would be the worst possible default.
 */
async function readBodyWithLimit(response, maxBytes, buildError) {
  const body = response.body;
  if (!body) return Buffer.alloc(0);

  const declared = Number(response.headers.get('content-length'));
  if (Number.isFinite(declared) && declared > maxBytes) {
    try {
      await body.cancel();
    } catch {
      // Already closed.
    }
    throw buildError();
  }

  const reader = body.getReader();
  const chunks = [];
  let received = 0;

  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      received += value.byteLength;
      if (received > maxBytes) throw buildError();
      // Copy rather than view: a view would alias the runtime's buffer, and a
      // silent aliasing bug is far worse than one transient 64KB copy.
      chunks.push(Buffer.from(value));
    }
  } finally {
    try {
      await reader.cancel();
    } catch {
      // Already closed by the reader or the peer.
    }
  }

  return Buffer.concat(chunks);
}

module.exports = {
  fetchRemote,
  readBodyWithLimit,
  MAX_REDIRECTS,
};
