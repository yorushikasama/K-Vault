const assert = require('assert');

const { extractStreamCandidates } = require('../server/lib/services/media-resolve-service');

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
});
