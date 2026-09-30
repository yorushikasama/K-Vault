const assert = require('assert');

const {
  PRESETS,
  normalizeOptions,
  resolveContainer,
  buildDownloadArgs,
  buildFormatArgs,
  parseProgressLine,
  classifyOutputFiles,
  mimeTypeForFile,
  YtdlpOptionError,
} = require('../server/lib/services/ytdlp-options');

// A capability set that unlocks everything, so option gating does not mask the
// argv assertions. Individual tests turn pieces off to check that gating.
const FULL = { ffmpeg: true, impersonate: true };

describe('ytdlp-options validation', function () {
  it('rejects extractor-args that decide where requests are sent', function () {
    // These keys are the SSRF primitive: the allow-list checks the pasted URL,
    // but api_hostname makes yt-dlp talk to a host that was never checked.
    for (const key of ['api_hostname', 'base_url', 'host', 'proxy']) {
      assert.throws(
        () => normalizeOptions({ extractorArgs: `tiktok:${key}=evil.example` }, { capabilities: FULL }),
        (error) => error instanceof YtdlpOptionError && error.code === 'MEDIA_RESOLVE_OPTION_FORBIDDEN',
        `expected ${key} to be refused`
      );
    }
  });

  it('allows benign extractor-args', function () {
    const { options } = normalizeOptions(
      { extractorArgs: 'youtube:player_client=default,-web' },
      { capabilities: FULL }
    );
    assert.deepStrictEqual(options.extractorArgs, ['youtube:player_client=default,-web']);
  });

  it('refuses a format id that could reach yt-dlp expression syntax', function () {
    assert.throws(
      () => normalizeOptions({ formatId: 'bv*+ba[height>100]' }, { capabilities: FULL }),
      (error) => error.code === 'MEDIA_RESOLVE_INVALID_OPTION'
    );
    const { options } = normalizeOptions({ formatId: '137' }, { capabilities: FULL });
    assert.strictEqual(options.formatId, '137');
  });

  it('rejects malformed download sections and playlist items', function () {
    assert.throws(() => normalizeOptions({ downloadSections: '*../../etc/passwd' }), { code: 'MEDIA_RESOLVE_INVALID_OPTION' });
    assert.throws(() => normalizeOptions({ playlistItems: '1;rm -rf /' }), { code: 'MEDIA_RESOLVE_INVALID_OPTION' });
    assert.strictEqual(
      normalizeOptions({ downloadSections: '*00:01:00-00:03:00' }).options.downloadSections,
      '*00:01:00-00:03:00'
    );
    assert.strictEqual(normalizeOptions({ playlistItems: '1,3,5-7' }).options.playlistItems, '1,3,5-7');
  });

  it('rejects unknown presets, sponsorblock categories and impersonate targets', function () {
    assert.throws(() => normalizeOptions({ preset: 'nope' }), { code: 'MEDIA_RESOLVE_INVALID_OPTION' });
    assert.throws(() => normalizeOptions({ sponsorblockMark: ['not_a_category'] }), { code: 'MEDIA_RESOLVE_INVALID_OPTION' });
    assert.throws(() => normalizeOptions({ impersonate: 'chrome;rm' }), { code: 'MEDIA_RESOLVE_INVALID_OPTION' });
  });

  it('accepts only impersonate targets the build actually advertises', function () {
    // With a probed list, that list is authoritative.
    assert.throws(
      () => normalizeOptions({ impersonate: 'safari' }, { capabilities: { impersonate: true, impersonateTargets: ['chrome'] } }),
      { code: 'MEDIA_RESOLVE_INVALID_OPTION' }
    );
    const { options } = normalizeOptions(
      { impersonate: 'chrome:windows-10' },
      { capabilities: { impersonate: true, impersonateTargets: ['chrome'] } }
    );
    assert.strictEqual(options.impersonate, 'chrome:windows-10');
  });

  it('drops a pinned video format when the preset is audio-only', function () {
    const { options, warnings } = normalizeOptions(
      { preset: 'mp3', formatId: '137', needsAudio: true },
      { capabilities: FULL }
    );
    assert.strictEqual(options.formatId, '');
    assert.strictEqual(options.needsAudio, false);
    assert.ok(warnings.some((warning) => warning.code === 'FORMAT_OVERRIDDEN'));
  });

  it('reports ffmpeg-dependent options as skipped rather than dropping them silently', function () {
    const { options, warnings } = normalizeOptions(
      { embedThumbnail: true, embedMetadata: true, embedChapters: true },
      { capabilities: { ffmpeg: false } }
    );
    assert.strictEqual(options.embedThumbnail, false);
    assert.strictEqual(options.embedMetadata, false);
    assert.strictEqual(options.embedChapters, false);
    assert.strictEqual(warnings.filter((warning) => warning.code === 'FFMPEG_UNAVAILABLE').length, 3);
  });

  it('reports impersonation as unavailable when the build lacks it', function () {
    const { options, warnings } = normalizeOptions(
      { impersonate: 'chrome' },
      { capabilities: { ffmpeg: true, impersonate: false } }
    );
    assert.strictEqual(options.impersonate, '');
    assert.ok(warnings.some((warning) => warning.code === 'IMPERSONATE_UNAVAILABLE'));
  });

  it('defaults subtitle languages and format when subtitles are requested bare', function () {
    const { options } = normalizeOptions({ subtitles: true }, { capabilities: FULL });
    assert.strictEqual(options.subtitleLangs, 'zh.*,en');
    assert.strictEqual(options.subtitleFormat, 'srt');
  });

  it('validates language selectors, including the wildcard form', function () {
    assert.strictEqual(normalizeOptions({ subtitleLangs: 'zh.*,en,pt-BR' }).options.subtitleLangs, 'zh.*,en,pt-BR');
    assert.throws(() => normalizeOptions({ subtitleLangs: 'en;rm' }), { code: 'MEDIA_RESOLVE_INVALID_OPTION' });
  });

  it('validates rate limits and rejects shell-shaped values', function () {
    assert.strictEqual(normalizeOptions({ limitRate: '4.2M' }).options.limitRate, '4.2M');
    assert.throws(() => normalizeOptions({ limitRate: '4.2M; rm' }), { code: 'MEDIA_RESOLVE_INVALID_OPTION' });
  });

  it('bounds numeric options', function () {
    assert.throws(() => normalizeOptions({ concurrentFragments: 999 }, { capabilities: FULL, limits: { maxConcurrentFragments: 16 } }), { code: 'MEDIA_RESOLVE_INVALID_OPTION' });
    assert.throws(() => normalizeOptions({ maxHeight: 10 }), { code: 'MEDIA_RESOLVE_INVALID_OPTION' });
    assert.throws(() => normalizeOptions({ sleepInterval: 60, maxSleepInterval: 10 }), { code: 'MEDIA_RESOLVE_INVALID_OPTION' });
  });

  it('ignores unknown payload keys entirely', function () {
    // normalizeOptions only reads the fields it knows about, so an attacker
    // cannot smuggle an arbitrary flag through an unexpected key.
    const { options } = normalizeOptions({ '--exec': 'rm -rf /', evil: true }, { capabilities: FULL });
    assert.strictEqual(options['--exec'], undefined);
    assert.strictEqual(options.evil, undefined);
  });
});

describe('ytdlp-options argv construction', function () {
  it('produces a complete argv for the default preset', function () {
    const { options } = normalizeOptions({}, { capabilities: FULL });
    const args = buildDownloadArgs(options, { hasFfmpeg: true, outputTemplate: 'out/%(id)s.%(ext)s' });

    assert.ok(args.includes('--merge-output-format'), 'merge format must be set');
    assert.ok(args.includes('mp4'));
    assert.ok(args.includes('-o'));
    assert.ok(args.includes('out/%(id)s.%(ext)s'));
    // No format selector is emitted for the default preset; yt-dlp picks the
    // best video plus best audio on its own.
    assert.ok(!args.includes('-f'), 'default preset must not pin a format');
  });

  it('emits a height-capped selector when maxHeight is set', function () {
    const { options } = normalizeOptions({ maxHeight: 720 }, { capabilities: FULL });
    const args = buildDownloadArgs(options, { hasFfmpeg: true, outputTemplate: 'o' });
    const index = args.indexOf('-f');
    assert.notStrictEqual(index, -1);
    assert.ok(args[index + 1].includes('height<=720'));
  });

  it('falls back to a single-file selector without ffmpeg', function () {
    const { options } = normalizeOptions({}, { capabilities: { ffmpeg: false } });
    const args = buildFormatArgs(options, { hasFfmpeg: false });
    assert.deepStrictEqual(args, ['-f', 'b']);
    // And no merge flag, because the merge step cannot run.
    const full = buildDownloadArgs(options, { hasFfmpeg: false, outputTemplate: 'o' });
    assert.ok(!full.includes('--merge-output-format'));
  });

  it('appends the best audio track when a video-only format is pinned', function () {
    const { options } = normalizeOptions({ formatId: '137', needsAudio: true }, { capabilities: FULL });
    const args = buildFormatArgs(options, { hasFfmpeg: true });
    assert.deepStrictEqual(args, ['-f', '137+ba/b']);
  });

  it('does not append audio to a format that already carries it', function () {
    const { options } = normalizeOptions({ formatId: '18', needsAudio: false }, { capabilities: FULL });
    assert.deepStrictEqual(buildFormatArgs(options, { hasFfmpeg: true }), ['-f', '18']);
  });

  it('enables playlists only when items are selected', function () {
    const bare = buildDownloadArgs(normalizeOptions({}, { capabilities: FULL }).options, { hasFfmpeg: true, outputTemplate: 'o' });
    assert.ok(!bare.includes('--yes-playlist'));

    const picked = buildDownloadArgs(normalizeOptions({ playlistItems: '2,4' }, { capabilities: FULL }).options, { hasFfmpeg: true, outputTemplate: 'o' });
    assert.ok(picked.includes('--yes-playlist'));
    assert.ok(picked.includes('--playlist-items'));
  });

  it('emits subtitle, enrichment and sponsorblock flags together', function () {
    const { options } = normalizeOptions({
      subtitles: true,
      autoSubtitles: true,
      embedSubtitles: true,
      embedThumbnail: true,
      embedMetadata: true,
      sponsorblockRemove: ['sponsor'],
    }, { capabilities: FULL });
    const args = buildDownloadArgs(options, { hasFfmpeg: true, outputTemplate: 'o' });

    for (const flag of ['--write-subs', '--write-auto-subs', '--sub-langs', '--convert-subs', '--embed-subs',
      '--write-thumbnail', '--embed-thumbnail', '--embed-metadata', '--sponsorblock-remove']) {
      assert.ok(args.includes(flag), `expected ${flag} in argv`);
    }
  });

  it('resolves the output container from the preset', function () {
    assert.strictEqual(resolveContainer(normalizeOptions({}, { capabilities: FULL }).options), 'mp4');
    assert.strictEqual(resolveContainer(normalizeOptions({ preset: 'mkv' }, { capabilities: FULL }).options), 'mkv');
    assert.strictEqual(resolveContainer(normalizeOptions({ preset: 'mp3' }, { capabilities: FULL }).options), 'mp3');
    assert.strictEqual(resolveContainer(normalizeOptions({ preset: 'm4a' }, { capabilities: FULL }).options), 'm4a');
  });

  it('marks audio presets as audio-only', function () {
    for (const [name, preset] of Object.entries(PRESETS)) {
      const { options } = normalizeOptions({ preset: name }, { capabilities: FULL });
      assert.strictEqual(options.audioOnly, preset.audioOnly, `${name} audioOnly flag`);
    }
  });
});

describe('ytdlp-options progress parsing', function () {
  it('parses a download progress line', function () {
    const parsed = parseProgressLine('KVPROG|download|downloading|524288|1048576|NA|131072|8');
    assert.strictEqual(parsed.stage, 'download');
    assert.strictEqual(parsed.status, 'downloading');
    assert.strictEqual(parsed.downloadedBytes, 524288);
    assert.strictEqual(parsed.totalBytes, 1048576);
    assert.strictEqual(parsed.percent, 50);
    assert.strictEqual(parsed.speedBytesPerSecond, 131072);
    assert.strictEqual(parsed.etaSeconds, 8);
  });

  it('falls back to the estimated total when the exact one is absent', function () {
    const parsed = parseProgressLine('KVPROG|download|downloading|500|NA|1000|NA|NA');
    assert.strictEqual(parsed.totalBytes, 1000);
    assert.strictEqual(parsed.percent, 50);
  });

  it('reports zero percent when the total is unknown', function () {
    const parsed = parseProgressLine('KVPROG|download|downloading|500|NA|NA|NA|NA');
    assert.strictEqual(parsed.totalBytes, 0);
    assert.strictEqual(parsed.percent, 0);
  });

  it('parses a postprocess line', function () {
    const parsed = parseProgressLine('KVPROG|postprocess|started|Merger|||');
    assert.strictEqual(parsed.stage, 'postprocess');
    assert.strictEqual(parsed.processor, 'Merger');
  });

  it('ignores lines that are not progress', function () {
    assert.strictEqual(parseProgressLine('[youtube] Extracting URL'), null);
    assert.strictEqual(parseProgressLine(''), null);
    assert.strictEqual(parseProgressLine('KVPROG|unknown|a'), null);
  });
});

describe('ytdlp-options output classification', function () {
  it('picks the largest media file as the primary output', function () {
    const result = classifyOutputFiles([
      { name: 'v.mp4', size: 900 },
      { name: 'v.f137.mp4', size: 100 },
      { name: 'v.en.srt', size: 4 },
      { name: 'v.jpg', size: 10 },
      { name: 'v.info.json', size: 2 },
    ]);
    assert.strictEqual(result.primary.name, 'v.mp4');
    assert.strictEqual(result.subtitles.length, 1);
    assert.strictEqual(result.thumbnails.length, 1);
    assert.strictEqual(result.metadata.length, 1);
  });

  it('ignores unrelated files', function () {
    const result = classifyOutputFiles([{ name: 'notes.md', size: 1 }, { name: 'v.mp4', size: 5 }]);
    assert.strictEqual(result.other.length, 1);
    assert.strictEqual(result.primary.name, 'v.mp4');
  });

  it('returns a null primary when nothing playable was produced', function () {
    const result = classifyOutputFiles([{ name: 'v.en.srt', size: 4 }]);
    assert.strictEqual(result.primary, null);
  });

  it('maps sidecar extensions to sensible MIME types', function () {
    // The storage layer derives the stored extension from the MIME type, so an
    // octet-stream subtitle would come back as .bin and stop being a subtitle.
    assert.strictEqual(mimeTypeForFile('a.srt'), 'application/x-subrip');
    assert.strictEqual(mimeTypeForFile('a.nfo'), 'text/xml');
    assert.strictEqual(mimeTypeForFile('a.jPg'), 'image/jpeg');
    assert.strictEqual(mimeTypeForFile('a.mkv'), 'video/x-matroska');
    assert.strictEqual(mimeTypeForFile('a.bin'), 'application/octet-stream');
    assert.strictEqual(mimeTypeForFile('noext'), 'application/octet-stream');
  });
});
