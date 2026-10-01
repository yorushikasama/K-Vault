const assert = require('assert');

const { classifyFailure } = require('../server/lib/services/media-resolve-service');

// The exact stderr Douyin's extractor emits — measured on 2026-09-30, byte
// identical for a deleted video, an empty cookie jar and a missing one.
const DOUYIN_FRESH_COOKIES = [
  'ERROR: [Douyin] 7677245422716407049: Fresh cookies (not necessarily logged in)',
  'are needed; please report this issue on  https://github.com/yt-dlp/yt-dlp/issues',
].join(' ');

describe('classifyFailure douyin fresh-cookies ambiguity', function () {
  it('keeps AUTH_REQUIRED when no cookie jar is configured', function () {
    const error = classifyFailure(DOUYIN_FRESH_COOKIES, 1);
    assert.strictEqual(error.code, 'MEDIA_RESOLVE_AUTH_REQUIRED');
  });

  it('keeps AUTH_REQUIRED for a generic cookies error even with a jar', function () {
    const error = classifyFailure('ERROR: Sign in to confirm your age', 1, { cookiesConfigured: true });
    assert.strictEqual(error.code, 'MEDIA_RESOLVE_AUTH_REQUIRED');
  });

  it('reclassifies the douyin message as unavailable once a jar exists', function () {
    const error = classifyFailure(DOUYIN_FRESH_COOKIES, 1, { cookiesConfigured: true });
    assert.strictEqual(error.code, 'MEDIA_RESOLVE_UNAVAILABLE_VIDEO');
    assert.strictEqual(error.status, 422);
  });

  it('matches the message case-insensitively', function () {
    const error = classifyFailure(DOUYIN_FRESH_COOKIES.toUpperCase(), 1, { cookiesConfigured: true });
    assert.strictEqual(error.code, 'MEDIA_RESOLVE_UNAVAILABLE_VIDEO');
  });
});

describe('classifyFailure unchanged branches', function () {
  it('still maps unsupported urls', function () {
    const error = classifyFailure('ERROR: Unsupported URL: https://example.invalid/x', 1);
    assert.strictEqual(error.code, 'MEDIA_RESOLVE_UNSUPPORTED_SITE');
  });

  it('reports yt-dlp piracy blocklist hits as blocked sites', function () {
    const stderr = [
      'ERROR: [Piracy] This website is no longer supported since it has been',
      'determined to be primarily used for piracy. DO NOT open issues for it',
    ].join(' ');
    const error = classifyFailure(stderr, 1, { cookiesConfigured: true });
    assert.strictEqual(error.code, 'MEDIA_RESOLVE_BLOCKED_SITE');
    assert.strictEqual(error.status, 422);
  });

  it('still maps genuinely unavailable videos', function () {
    const error = classifyFailure('ERROR: This video is unavailable', 1);
    assert.strictEqual(error.code, 'MEDIA_RESOLVE_UNAVAILABLE_VIDEO');
  });

  it('still maps forbidden responses', function () {
    const error = classifyFailure('ERROR: unable to download video data: HTTP Error 403: Forbidden', 1);
    assert.strictEqual(error.code, 'MEDIA_RESOLVE_FORBIDDEN');
  });

  it('still maps missing js runtimes', function () {
    const error = classifyFailure('ERROR: nsig extraction failed; JavaScript runtime not found', 1);
    assert.strictEqual(error.code, 'MEDIA_RESOLVE_JS_RUNTIME_REQUIRED');
  });

  it('maps unknown failures to a generic error', function () {
    const error = classifyFailure('ERROR: something entirely unexpected', 1);
    assert.strictEqual(error.code, 'MEDIA_RESOLVE_FAILED');
  });
});
