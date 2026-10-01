const assert = require('assert');

const {
  extractStreamCandidates,
  extractIframeSrcs,
  isStreamTargetUrl,
  MediaResolveService,
} = require('../server/lib/services/media-resolve-service');

function serviceWith(settings) {
  return new MediaResolveService({ config: { mediaResolve: settings } });
}

// The exact player config shape used by MacCMS-family play pages (slashes
// escaped as \/ because the blob sits inside a <script> block).
const MACCMS_PAGE = String.raw`
<script>var player_aaaa={"flag":"play","encrypt":0,"trysee":0,"points":0,
"link":"\/play\/2148260166\/2\/1.html","link_next":"",
"url":"https:\/\/v.cdn.example.com\/20260927\/10982_c387387b\/index.m3u8",
"url_next":"","from":"lzm3u8","server":"no","note":"","id":"2148260166"};</script>
`;

describe('extractStreamCandidates', function () {
  it('pulls the stream out of a MacCMS player config', function () {
    const candidates = extractStreamCandidates(MACCMS_PAGE);
    assert.strictEqual(candidates[0], 'https://v.cdn.example.com/20260927/10982_c387387b/index.m3u8');
  });

  it('decodes URI-encoded (encrypt=1) configs', function () {
    const page = '<script>player_aaaa={"encrypt":1,"url":"https%3A%2F%2Fv.example.com%2Fa.m3u8"};</script>';
    assert.strictEqual(extractStreamCandidates(page)[0], 'https://v.example.com/a.m3u8');
  });

  it('decodes base64 (encrypt=2) configs', function () {
    const encoded = Buffer.from('https://v.example.com/b.m3u8').toString('base64');
    const page = `<script>player_aaaa={"encrypt":2,"url":"${encoded}"};</script>`;
    assert.strictEqual(extractStreamCandidates(page)[0], 'https://v.example.com/b.m3u8');
  });

  it('keeps relative <source> targets for the caller to absolutize', function () {
    const page = '<video><source src="/hls/ep1/index.m3u8" type="application/x-mpegURL"></video>';
    assert.strictEqual(extractStreamCandidates(page)[0], '/hls/ep1/index.m3u8');
  });

  it('prefers the player config over a blind URL sweep', function () {
    const page = `${MACCMS_PAGE}
      <a href="https://ads.example.com/track.m3u8">x</a>`;
    const candidates = extractStreamCandidates(page);
    assert.strictEqual(candidates[0], 'https://v.cdn.example.com/20260927/10982_c387387b/index.m3u8');
  });

  it('falls back to bare m3u8/mp4 URLs when no config exists', function () {
    const page = '<div>https://cdn.example.com/movie.mp4?token=1 and https://cdn.example.com/list.m3u8</div>';
    const candidates = extractStreamCandidates(page);
    assert.deepStrictEqual(candidates, [
      'https://cdn.example.com/list.m3u8',
      'https://cdn.example.com/movie.mp4?token=1',
    ]);
  });

  it('deduplicates candidates and caps the list', function () {
    const many = Array.from({ length: 30 }, (_, i) => `https://cdn.example.com/v${i}.m3u8`).join(' ');
    assert.strictEqual(extractStreamCandidates(many).length, 8);
  });

  it('returns nothing for pages without streams', function () {
    assert.deepStrictEqual(extractStreamCandidates('<div>hello</div>'), []);
    assert.deepStrictEqual(extractStreamCandidates(''), []);
  });

  it('accepts DASH manifests and player_data variants in the sweep', function () {
    const page = '<script>var player_data={"encrypt":0,"url":"https://cdn.example.com/dash.mpd"};</script>';
    assert.strictEqual(extractStreamCandidates(page)[0], 'https://cdn.example.com/dash.mpd');
  });

  it('accepts a tokenized stream URL declared via JSON-LD contentUrl', function () {
    const page = `<script type="application/ld+json">
      {"@type":"VideoObject","contentUrl":"https://cdn.example.com/manifest.m3u8?tok=abc"}</script>`;
    assert.strictEqual(extractStreamCandidates(page)[0], 'https://cdn.example.com/manifest.m3u8?tok=abc');
  });

  it('ignores JSON-LD contentUrl pointing at a watch page, not a stream', function () {
    const page = `<script type="application/ld+json">
      {"@type":"VideoObject","contentUrl":"https://example.com/watch/123"}</script>`;
    assert.deepStrictEqual(extractStreamCandidates(page), []);
  });

  it('decodes chained base64+URI-encoded configs', function () {
    const inner = encodeURIComponent('https://v.example.com/c.m3u8');
    const page = `<script>player_data={"encrypt":2,"url":"${Buffer.from(inner).toString('base64')}"}</script>`;
    assert.strictEqual(extractStreamCandidates(page)[0], 'https://v.example.com/c.m3u8');
  });
});

describe('extractIframeSrcs', function () {
  it('absolutizes iframes and puts player-looking ones first', function () {
    const page = `
      <iframe src="/ads/banner.html"></iframe>
      <iframe src="https://cdn.example.com/static/player/?url=abc123"></iframe>
      <iframe src="//other.example.com/embed/9"></iframe>`;
    const srcs = extractIframeSrcs(page, 'https://www.example.com/play/1.html');
    assert.strictEqual(srcs[0], 'https://cdn.example.com/static/player/?url=abc123');
    assert.ok(srcs.includes('https://other.example.com/embed/9'));
    assert.ok(srcs.includes('https://www.example.com/ads/banner.html'));
  });
});

describe('isStreamTargetUrl', function () {
  it('recognises stream targets regardless of query strings', function () {
    for (const url of [
      'https://cdn.example.com/movie/index.m3u8',
      'https://cdn.example.com/hls/ep1/playlist.m3u8?token=abc',
      'https://cdn.example.com/video.mp4',
      'https://cdn.example.com/dash/manifest.mpd',
    ]) {
      assert.strictEqual(isStreamTargetUrl(url), true, `expected ${url} to be a stream target`);
    }
  });

  it('treats pages and extension-less endpoints as sniffable', function () {
    for (const url of [
      'https://www.example.com/play/2148260166/2/1.html',
      'https://www.example.com/video',
      'https://www.example.com/get/stream?format=m3u8',
    ]) {
      assert.strictEqual(isStreamTargetUrl(url), false, `expected ${url} to be sniffable`);
    }
  });

  it('returns false for garbage', function () {
    assert.strictEqual(isStreamTargetUrl(''), false);
    assert.strictEqual(isStreamTargetUrl('not a url'), false);
  });
});

describe('pickAllowedStream policy gate', function () {
  const service = serviceWith({ allowUnknownHosts: true });

  it('skips candidates that fail the host policy and keeps scanning', function () {
    const found = service.pickAllowedStream(
      ['http://169.254.169.254/latest.m3u8', 'https://cdn.example.com/ok.m3u8'],
      'https://www.example.com/play/1.html'
    );
    assert.strictEqual(found.parsed.href, 'https://cdn.example.com/ok.m3u8');
    assert.strictEqual(found.referer, 'https://www.example.com/play/1.html');
  });

  it('absolutizes relative candidates against the containing page', function () {
    const found = service.pickAllowedStream(
      ['/hls/ep1/index.m3u8'],
      'https://www.example.com/play/1.html'
    );
    assert.strictEqual(found.parsed.href, 'https://www.example.com/hls/ep1/index.m3u8');
  });

  it('returns null when every candidate is refused', function () {
    const found = service.pickAllowedStream(
      ['http://127.0.0.1:8787/x.m3u8'],
      'https://www.example.com/play/1.html'
    );
    assert.strictEqual(found, null);
  });
});
