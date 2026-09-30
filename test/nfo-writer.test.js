const assert = require('assert');

const {
  buildVideoNfo,
  nfoFileName,
  escapeXml,
  toIsoDate,
  toRuntimeMinutes,
} = require('../server/lib/services/nfo-writer');

describe('nfo-writer escaping', function () {
  it('escapes the characters that appear in real titles', function () {
    // Titles routinely contain these; a malformed NFO makes the media server
    // drop the whole item rather than the single field.
    assert.strictEqual(escapeXml('A & B'), 'A &amp; B');
    assert.strictEqual(escapeXml('<script>'), '&lt;script&gt;');
    assert.strictEqual(escapeXml('say "hi"'), 'say &quot;hi&quot;');
    assert.strictEqual(escapeXml("it's"), 'it&apos;s');
  });

  it('strips control characters XML 1.0 forbids even when escaped', function () {
    assert.strictEqual(escapeXml('a\u0000b\u0001c'), 'abc');
    assert.strictEqual(escapeXml('keep\u0009tab'), 'keep\u0009tab');
  });

  it('renders null and undefined as empty rather than the literal word', function () {
    assert.strictEqual(escapeXml(null), '');
    assert.strictEqual(escapeXml(undefined), '');
  });
});

describe('nfo-writer field conversion', function () {
  it('converts yt-dlp YYYYMMDD dates to ISO', function () {
    assert.strictEqual(toIsoDate('20260930'), '2026-09-30');
  });

  it('drops dates it cannot trust instead of emitting a bad one', function () {
    assert.strictEqual(toIsoDate(''), '');
    assert.strictEqual(toIsoDate('not-a-date'), '');
    assert.strictEqual(toIsoDate('20261330'), '', 'month 13 must be rejected');
    assert.strictEqual(toIsoDate('20260132'), '', 'day 32 must be rejected');
  });

  it('rounds runtime up so a short clip is never 0 minutes', function () {
    assert.strictEqual(toRuntimeMinutes(90), '2');
    assert.strictEqual(toRuntimeMinutes(1), '1');
    assert.strictEqual(toRuntimeMinutes(0), '');
    assert.strictEqual(toRuntimeMinutes('x'), '');
  });

  it('derives the NFO name from the media stem, which is how Kodi matches it', function () {
    assert.strictEqual(nfoFileName('Some Video [abc].mp4'), 'Some Video [abc].nfo');
    assert.strictEqual(nfoFileName('no-extension'), 'no-extension.nfo');
    assert.strictEqual(nfoFileName(''), 'video.nfo');
  });
});

describe('nfo-writer document', function () {
  const entry = {
    id: 'abc123',
    title: 'A & B <test>',
    uploader: 'Some Channel',
    duration: 125,
    upload_date: '20260930',
    description: 'First line\nSecond line',
    webpage_url: 'https://example.com/watch?v=abc123',
    extractor_key: 'Youtube',
    categories: ['Gaming', 'Tech'],
    tags: ['tag1'],
    thumbnail: 'https://example.com/t.jpg',
  };

  it('produces a well-formed movie document', function () {
    const xml = buildVideoNfo(entry);
    assert.ok(xml.startsWith('<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'));
    assert.ok(xml.includes('<movie>'));
    assert.ok(xml.includes('</movie>'));

    // Balanced tags for the elements that carry the identity of the item.
    assert.strictEqual((xml.match(/<movie>/g) || []).length, 1);
    assert.strictEqual((xml.match(/<\/movie>/g) || []).length, 1);
  });

  it('escapes values rather than emitting raw markup', function () {
    const xml = buildVideoNfo(entry);
    assert.ok(xml.includes('<title>A &amp; B &lt;test&gt;</title>'));
    assert.ok(!xml.includes('<test>'), 'raw markup must not survive into the document');
  });

  it('includes the media server fields that matter', function () {
    const xml = buildVideoNfo(entry);
    assert.ok(xml.includes('<premiered>2026-09-30</premiered>'));
    assert.ok(xml.includes('<runtime>2</runtime>'));
    assert.ok(xml.includes('<studio>Some Channel</studio>'));
    assert.ok(xml.includes('<genre>Gaming</genre>'));
    assert.ok(xml.includes('<genre>Tech</genre>'));
    assert.ok(xml.includes('<tag>tag1</tag>'));
    assert.ok(xml.includes('<uniqueid>Youtube:abc123</uniqueid>'));
    assert.ok(xml.includes('<website>https://example.com/watch?v=abc123</website>'));
  });

  it('omits empty elements so a scraper can supply its own value', function () {
    const xml = buildVideoNfo({ id: 'x', title: 'Only a title' });
    assert.ok(!xml.includes('<plot></plot>'));
    assert.ok(!xml.includes('<premiered>'));
    assert.ok(!xml.includes('<thumbnail>'));
    // A missing uploader must not produce an empty actor block.
    assert.ok(!xml.includes('<actor>'));
  });

  it('falls back to a placeholder title rather than emitting an empty one', function () {
    const xml = buildVideoNfo({ id: 'x' });
    assert.ok(xml.includes('<title>Untitled</title>'));
  });

  it('writes season and episode when given a playlist hint', function () {
    const xml = buildVideoNfo(entry, { episodeHint: { season: 1, episode: 7, showTitle: 'My Show' } });
    assert.ok(xml.includes('<season>1</season>'));
    assert.ok(xml.includes('<episode>7</episode>'));
    assert.ok(xml.includes('<showtitle>My Show</showtitle>'));
    // A standalone movie uses originaltitle instead.
    assert.ok(!xml.includes('<originaltitle>'));
  });

  it('survives a hostile description without breaking the document', function () {
    const hostile = buildVideoNfo({
      id: 'x',
      title: ']]></title><script>alert(1)</script>',
      description: '<<<>>>&&&"""',
    });
    assert.ok(hostile.includes('&lt;script&gt;'));
    assert.ok(!hostile.includes('<script>'));
    // Exactly one closing movie tag means the injected markup did not escape
    // its text node.
    assert.strictEqual((hostile.match(/<\/movie>/g) || []).length, 1);
  });
});
