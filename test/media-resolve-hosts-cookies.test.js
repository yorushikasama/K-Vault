const assert = require('assert');

const {
  MediaResolveService,
  isPrivateOrLocalHost,
} = require('../server/lib/services/media-resolve-service');
const { parseCookiesByHost } = require('../server/lib/config');

function serviceWith(settings) {
  return new MediaResolveService({ config: { mediaResolve: settings } });
}

describe('isPrivateOrLocalHost', function () {
  const privateCases = [
    'localhost', 'foo.localhost', '127.0.0.1', '127.8.8.8', '10.1.2.3',
    '172.16.0.1', '172.31.255.255', '192.168.1.1', '169.254.169.254',
    '0.0.0.0', '100.64.0.1', '::1', '::', 'fe80::1', 'fc00::1', 'fd12:3456::a',
    '::ffff:192.168.0.1', '::ffff:127.0.0.1',
    // Non-dotted encodings that still resolve to loopback.
    '2130706433', '0x7f000001', '0177.0.0.1', 'metadata.google.internal',
    // WHATWG URL normalization turns dotted IPv4-mapped IPv6 into hex:
    // ::ffff:7f00:1 is 127.0.0.1, ::ffff:c0a8:1 is 192.168.0.1,
    // ::ffff:a9fe:101 is 169.254.1.1.
    '::ffff:7f00:1', '::ffff:c0a8:1', '::ffff:a9fe:101',
  ];
  for (const host of privateCases) {
    it(`refuses ${host}`, function () {
      assert.strictEqual(isPrivateOrLocalHost(host), true, `expected ${host} to be private`);
    });
  }

  const publicCases = [
    'example.com', 'www.bilibili.com', '8.8.8.8', '172.32.0.1', '100.128.0.1',
    '2606:4700::1111', '1.2.3.4', '::ffff:808:808',
  ];
  for (const host of publicCases) {
    it(`allows ${host}`, function () {
      assert.strictEqual(isPrivateOrLocalHost(host), false, `expected ${host} to be public`);
    });
  }
});

describe('host allow-list under allowUnknownHosts', function () {
  it('blocks loopback and private ranges even when unknown hosts are allowed', function () {
    const service = serviceWith({ allowUnknownHosts: true });
    assert.strictEqual(service.isHostAllowed('example.com'), true);
    assert.strictEqual(service.isHostAllowed('127.0.0.1'), false);
    assert.strictEqual(service.isHostAllowed('169.254.169.254'), false);
    assert.strictEqual(service.isHostAllowed('192.168.1.10'), false);
  });

  it('still allows hosts an operator explicitly added', function () {
    const service = serviceWith({ allowUnknownHosts: true, extraHosts: 'media.internal.lan' });
    assert.strictEqual(service.isHostAllowed('media.internal.lan'), true);
  });

  it('stays closed without allowUnknownHosts', function () {
    const service = serviceWith({});
    assert.strictEqual(service.isHostAllowed('example.com'), false);
  });

  it('lets bracketed IPv6 pastes reach the host-policy layer', async function () {
    // The share-sentence extractor truncates at ']', which IPv6 literals
    // contain; prepareTarget falls back to the full text so the policy —
    // not a parse error — decides.
    const service = serviceWith({ allowUnknownHosts: true });
    await assert.rejects(
      service.prepareTarget('http://[::ffff:127.0.0.1]:8787/index.html'),
      (error) => error.code === 'MEDIA_RESOLVE_HOST_NOT_ALLOWED'
    );
  });
});

describe('parseCookiesByHost', function () {
  it('parses semicolon and newline separated pairs', function () {
    const pairs = parseCookiesByHost('bilibili.com=/jars/bili.txt\nyoutube.com=/jars/yt.txt');
    assert.deepStrictEqual(pairs, [
      { host: 'bilibili.com', path: '/jars/bili.txt' },
      { host: 'youtube.com', path: '/jars/yt.txt' },
    ]);
  });

  it('lowercases hosts and drops malformed pairs', function () {
    const pairs = parseCookiesByHost('Bilibili.COM=/jars/bili.txt; noeq; =empty; host=; trailing=');
    assert.deepStrictEqual(pairs, [{ host: 'bilibili.com', path: '/jars/bili.txt' }]);
  });

  it('returns an empty list for blank input', function () {
    assert.deepStrictEqual(parseCookiesByHost(''), []);
    assert.deepStrictEqual(parseCookiesByHost(undefined), []);
  });
});

describe('selectCookiesFile', function () {
  const service = serviceWith({
    cookiesFile: '/jars/generic.txt',
    cookiesByHost: [
      { host: 'bilibili.com', path: '/jars/bili.txt' },
      { host: 'www.youtube.com', path: '/jars/yt-exact.txt' },
      { host: 'youtube.com', path: '/jars/yt-suffix.txt' },
    ],
  });

  it('falls back to the generic jar for unmapped hosts', function () {
    assert.strictEqual(service.selectCookiesFile('example.com'), '/jars/generic.txt');
    assert.strictEqual(service.selectCookiesFile(''), '/jars/generic.txt');
  });

  it('matches subdomains through the suffix mapping', function () {
    assert.strictEqual(service.selectCookiesFile('www.bilibili.com'), '/jars/bili.txt');
  });

  it('prefers the exact host over the suffix', function () {
    assert.strictEqual(service.selectCookiesFile('www.youtube.com'), '/jars/yt-exact.txt');
  });

  it('uses the suffix mapping for other subdomains', function () {
    assert.strictEqual(service.selectCookiesFile('m.youtube.com'), '/jars/yt-suffix.txt');
  });
});
