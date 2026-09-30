/**
 * yt-dlp option surface: presets, validation, and argv construction.
 *
 * The service used to build its argument list inline, which meant every new
 * capability had to be threaded through `buildCommonArgs` by hand and nothing
 * validated the client-supplied pieces beyond a single format-id regex. This
 * module is the one place that knows what can be asked of yt-dlp, and it is the
 * boundary where untrusted request fields are turned into argv entries.
 *
 * Two rules shape everything here:
 *
 * 1. Nothing from a request reaches argv without matching a validator. spawn()
 *    without a shell already rules out command injection, but argv entries are
 *    still read by yt-dlp's own parsers — a crafted value could select a
 *    different output path, or redirect yt-dlp at a host the allow-list never
 *    approved.
 * 2. Features that need a binary we do not have are reported, not silently
 *    dropped. A caller that asked for embedded subtitles and got a bare mp4
 *    should be told why.
 *
 * The option names and preset model deliberately mirror alexta69/metube: global
 * defaults, then a named preset, then per-request overrides. Operators who know
 * that project will recognise the shape.
 */

// --- Limits -----------------------------------------------------------------
// Bounds are intentionally generous but finite: every one of these ends up in a
// command line, and Linux caps that at roughly 2MB in total.

const MAX_EXTRACTOR_ARG_LENGTH = 512;
const MAX_SECTION_LENGTH = 256;
const MAX_LANG_LIST_LENGTH = 256;
const MAX_RATE_LENGTH = 32;
const MAX_TRIM_FILENAME_LENGTH = 255;

// Presets. `mp3`/`aac`/`mp4`/`mkv` are yt-dlp's own --preset-alias values, so
// their exact meaning stays with upstream and cannot drift here; `best` and
// `bestaudio` are ours and describe selection rather than postprocessing.
//
// `best` is the historical K-Vault behaviour: best video plus best audio, muxed
// into mp4, with no forced remux — that keeps a picked AV1 stream as AV1 instead
// of repackaging it. `mp4` additionally sorts towards h264/aac and remuxes, which
// is what makes the result play in Telegram's in-app player.
// `container` records what the preset's own flags already produce, so the caller
// never has to reverse-engineer a container out of an argv list. Audio presets
// name the container they extract to; video presets that pass `-t` let yt-dlp
// pick it; `best` and `small` mux without transcoding.
const PRESETS = {
  best: {
    label: '最佳画质（不转码）',
    audioOnly: false,
    container: 'mp4',
    remuxes: false,
    args: [],
  },
  mp4: {
    label: 'MP4（H.264 + AAC，兼容性最好）',
    audioOnly: false,
    container: 'mp4',
    remuxes: true,
    args: ['-t', 'mp4'],
  },
  mkv: {
    label: 'MKV（保留原始轨道）',
    audioOnly: false,
    container: 'mkv',
    remuxes: true,
    args: ['-t', 'mkv'],
  },
  small: {
    label: '最小体积（≤480p）',
    audioOnly: false,
    container: 'mp4',
    remuxes: false,
    args: ['-S', 'res:480,fps,vcodec:h264,acodec:aac'],
  },
  bestaudio: {
    label: '最佳音轨（不转码）',
    audioOnly: true,
    container: 'm4a',
    remuxes: false,
    args: ['-f', 'ba/b', '-x'],
  },
  mp3: {
    label: 'MP3',
    audioOnly: true,
    container: 'mp3',
    remuxes: false,
    args: ['-t', 'mp3'],
  },
  m4a: {
    label: 'M4A（AAC）',
    audioOnly: true,
    container: 'm4a',
    remuxes: false,
    args: ['-f', 'ba[acodec^=mp4a]/ba/b', '-x', '--audio-format', 'm4a', '--audio-quality', '0'],
  },
  aac: {
    label: 'AAC',
    audioOnly: true,
    container: 'm4a',
    remuxes: false,
    args: ['-t', 'aac'],
  },
};

const DEFAULT_PRESET = 'best';

// Container yt-dlp is allowed to remux into. Kept narrow because the storage
// layer keys MIME type off the extension it is handed.
const OUTPUT_CONTAINERS = ['mp4', 'mkv', 'webm', 'mov'];

const SUBTITLE_FORMATS = ['srt', 'vtt', 'ass', 'lrc', 'sami', 'stl', 'best', 'json3', 'srv1', 'srv2', 'srv3'];

// Categories yt-dlp accepts for SponsorBlock. `all` and `default` are upstream
// shorthand rather than categories, but it accepts them in the same position.
const SPONSORBLOCK_CATEGORIES = [
  'sponsor', 'intro', 'outro', 'selfpromo', 'preview', 'filler',
  'interaction', 'music_offtopic', 'poi_highlight', 'hook',
  'all', 'default',
];

// These yt-dlp clients are the ones whose TLS fingerprint actually differs from
// Python's. Listing them explicitly keeps a typo out of argv, where yt-dlp would
// fail the whole run rather than ignore the value.
const IMPERSONATE_TARGETS = [
  'chrome', 'chrome-99', 'chrome-100', 'chrome-101', 'chrome-104', 'chrome-107',
  'chrome-110', 'chrome-116', 'chrome-120', 'chrome-124', 'chrome-131', 'chrome-133',
  'chrome-136',
  'edge', 'edge-99', 'edge-101', 'edge-104', 'edge-107', 'edge-110', 'edge-116',
  'edge-120', 'edge-124', 'edge-131',
  'safari', 'safari-15.3', 'safari-15.5', 'safari-16.0', 'safari-17.0', 'safari-18.0',
  'firefox', 'firefox-133', 'firefox-135',
];

const IMPERSONATE_OS = [
  'windows-10', 'windows-11', 'macos-10.15', 'macos-11', 'macos-12',
  'macos-13', 'macos-14', 'macos-15', 'ubuntu-20.04', 'ubuntu-22.04',
];

// Extractor-arg keys that decide *where* a request goes. Allowing any of these
// from a request would hand the caller an SSRF primitive: the allow-list checks
// the URL the user pasted, but `tiktok:api_hostname=attacker.example` makes
// yt-dlp talk to a host that was never checked. Operators can still set them
// through MEDIA_RESOLVE_EXTRACTOR_ARGS, which is trusted input.
const FORBIDDEN_EXTRACTOR_ARG_KEYS = new Set([
  'api_hostname', 'api_host', 'host', 'hostname', 'base_url', 'endpoint',
  'url', 'proxy', 'hls_key', 'key_query', 'fragment_query', 'variant_query',
  'manifest_url', 'video_url', 'audio_url',
]);

// A file we produced is only ever one of these. Anything else in the job
// directory is treated as an unexpected artefact and left for the sweeper.
const MEDIA_EXTENSIONS = new Set([
  'mp4', 'mkv', 'webm', 'mov', 'avi', 'flv', 'ts', 'm4v', '3gp', 'mpg', 'mpeg',
  'mp3', 'm4a', 'aac', 'opus', 'ogg', 'oga', 'wav', 'flac', 'weba',
]);

const SUBTITLE_EXTENSIONS = new Set(['srt', 'vtt', 'ass', 'lrc', 'sami', 'stl', 'ttml']);
const IMAGE_EXTENSIONS = new Set(['jpg', 'jpeg', 'png', 'webp', 'gif', 'avif']);
const METADATA_EXTENSIONS = new Set(['json', 'nfo', 'description', 'txt']);

// Extension to MIME type, for the sidecar upload path. The storage layer derives
// a public file id's extension from the MIME type it is handed, so a subtitle
// uploaded as application/octet-stream would come back with a .bin suffix and
// stop being a subtitle as far as a media server is concerned.
const MIME_BY_EXTENSION = {
  mp4: 'video/mp4',
  m4v: 'video/mp4',
  mkv: 'video/x-matroska',
  webm: 'video/webm',
  mov: 'video/quicktime',
  avi: 'video/x-msvideo',
  flv: 'video/x-flv',
  ts: 'video/mp2t',
  mp3: 'audio/mpeg',
  m4a: 'audio/mp4',
  aac: 'audio/aac',
  opus: 'audio/opus',
  ogg: 'audio/ogg',
  oga: 'audio/ogg',
  wav: 'audio/wav',
  flac: 'audio/flac',
  weba: 'audio/webm',
  srt: 'application/x-subrip',
  vtt: 'text/vtt',
  ass: 'text/x-ssa',
  lrc: 'text/plain',
  sami: 'text/sami',
  stl: 'text/plain',
  ttml: 'application/ttml+xml',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  png: 'image/png',
  webp: 'image/webp',
  gif: 'image/gif',
  avif: 'image/avif',
  json: 'application/json',
  nfo: 'text/xml',
  description: 'text/plain',
};

function mimeTypeForFile(fileName) {
  const name = String(fileName || '');
  const dot = name.lastIndexOf('.');
  if (dot === -1) return 'application/octet-stream';
  const ext = name.slice(dot + 1).toLowerCase();
  return MIME_BY_EXTENSION[ext] || 'application/octet-stream';
}

class YtdlpOptionError extends Error {
  constructor(code, message, { status = 400, detail = '', field = '' } = {}) {
    super(message);
    this.name = 'YtdlpOptionError';
    this.code = code;
    this.status = status;
    this.detail = detail || message;
    this.field = field;
  }
}

// --- Primitive validators ---------------------------------------------------

function optionError(field, detail) {
  return new YtdlpOptionError(
    'MEDIA_RESOLVE_INVALID_OPTION',
    '解析参数无效。',
    { status: 400, detail: `${field}: ${detail}`, field }
  );
}

function asBool(value, fallback = false) {
  if (value === undefined || value === null || value === '') return fallback;
  if (typeof value === 'boolean') return value;
  const text = String(value).trim().toLowerCase();
  if (['1', 'true', 'yes', 'on'].includes(text)) return true;
  if (['0', 'false', 'no', 'off'].includes(text)) return false;
  return fallback;
}

function asInt(value, fallback = 0) {
  if (value === undefined || value === null || value === '') return fallback;
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function assertString(value, field, { max = 128, pattern = null, allowEmpty = true } = {}) {
  const text = String(value == null ? '' : value).trim();
  if (!text) {
    if (allowEmpty) return '';
    throw optionError(field, 'value is required.');
  }
  if (text.length > max) {
    throw optionError(field, `value is longer than ${max} characters.`);
  }
  if (pattern && !pattern.test(text)) {
    throw optionError(field, 'value contains characters yt-dlp would not accept.');
  }
  return text;
}

function assertEnum(value, field, allowed) {
  const text = assertString(value, field, { max: 64 });
  if (!text) return '';
  if (!allowed.includes(text)) {
    throw optionError(field, `expected one of: ${allowed.slice(0, 12).join(', ')}${allowed.length > 12 ? ', …' : ''}.`);
  }
  return text;
}

function assertBoundedInt(value, field, { min = 0, max = Number.MAX_SAFE_INTEGER } = {}) {
  const text = String(value == null ? '' : value).trim();
  if (!text) return null;
  if (!/^-?\d+$/.test(text)) {
    throw optionError(field, 'value must be an integer.');
  }
  const parsed = Number.parseInt(text, 10);
  if (parsed < min || parsed > max) {
    throw optionError(field, `value must be between ${min} and ${max}.`);
  }
  return parsed;
}

function assertList(value, field, { itemPattern, max = 32 } = {}) {
  if (value === undefined || value === null || value === '') return [];
  const items = Array.isArray(value) ? value : String(value).split(',');
  const out = [];
  for (const raw of items) {
    const text = String(raw == null ? '' : raw).trim();
    if (!text) continue;
    if (text.length > 64) throw optionError(field, 'an entry is too long.');
    if (itemPattern && !itemPattern.test(text)) {
      throw optionError(field, `entry "${text.slice(0, 24)}" contains characters yt-dlp would not accept.`);
    }
    if (!out.includes(text)) out.push(text);
    if (out.length > max) throw optionError(field, `no more than ${max} entries are allowed.`);
  }
  return out;
}

// --- Option normalisation ---------------------------------------------------

// Options that only mean anything with ffmpeg present. Asking for them without
// it is a caller mistake worth reporting rather than a silently thinner file.
const FFMPEG_ONLY_OPTIONS = [
  ['embedSubtitles', '字幕嵌入'],
  ['embedThumbnail', '封面嵌入'],
  ['embedMetadata', '元数据嵌入'],
  ['embedChapters', '章节嵌入'],
  ['forceKeyframesAtCuts', '裁剪处强制关键帧'],
  ['splitChapters', '按章节分片'],
];

// `--download-sections` accepts several comma-separated specs, each of which is
// either a named SponsorBlock section or `[*]START-END` with `inf` allowed as
// the end. Anything outside this shape is rejected so nothing surprising can be
// pasted into the same argv slot.
const SECTION_SPEC_RE = /^\*?[A-Za-z0-9_:.\-]+$/;
const SECTION_SPEC_LANGUAGE_KEYS = new Set(['intro', 'outro', 'sponsor', 'selfpromo', 'preview', 'filler', 'interaction', 'music_offtopic', 'poi_highlight', 'hook']);

function normalizeSections(value, field) {
  const text = assertString(value, field, { max: MAX_SECTION_LENGTH });
  if (!text) return '';
  const specs = text.split(',').map((item) => item.trim()).filter(Boolean);
  if (!specs.length) return '';
  if (specs.length > 16) throw optionError(field, 'no more than 16 ranges are allowed.');
  for (const spec of specs) {
    if (!SECTION_SPEC_RE.test(spec)) {
      throw optionError(field, `range "${spec.slice(0, 24)}" is not a recognised time range.`);
    }
    // A range has to carry a digit somewhere; a bare word is only valid when it
    // names a SponsorBlock section.
    if (!/\d/.test(spec) && !SECTION_SPEC_LANGUAGE_KEYS.has(spec.replace(/^\*/, ''))) {
      throw optionError(field, `range "${spec.slice(0, 24)}" is neither a timestamp nor a known section name.`);
    }
  }
  return specs.join(',');
}

// `--playlist-items` uses yt-dlp's own index syntax: single indices and
// inclusive ranges, comma separated.
const PLAYLIST_ITEMS_RE = /^\d+(-\d*)?(,\d+(-\d*)?)*$/;

function normalizePlaylistItems(value, field) {
  const text = assertString(value, field, { max: 512 });
  if (!text) return '';
  if (!PLAYLIST_ITEMS_RE.test(text)) {
    throw optionError(field, 'expected indices like "1,3,5-7".');
  }
  return text;
}

// `-r 4.2M`, `--limit-rate 500K`. yt-dlp parses the suffix itself, so the job
// here is only to keep the token to digits plus one unit letter.
const RATE_RE = /^\d+(\.\d+)?[KkMmGg]?$/;

function normalizeRate(value, field) {
  const text = assertString(value, field, { max: MAX_RATE_LENGTH, pattern: RATE_RE });
  return text;
}

// Subtitle language selectors are language codes with optional wildcards, e.g.
// "zh.*,en,ja". The `.*` form is how yt-dlp spells "every Chinese variant".
const LANG_RE = /^[A-Za-z0-9_.*\-]+$/;

function normalizeExtractorArgs(value, field) {
  const entries = Array.isArray(value) ? value : (value ? [value] : []);
  const out = [];

  for (const raw of entries) {
    const text = assertString(raw, field, { max: MAX_EXTRACTOR_ARG_LENGTH, allowEmpty: false });
    for (const chunk of text.split(';')) {
      const spec = chunk.trim();
      if (!spec) continue;
      const colon = spec.indexOf(':');
      if (colon <= 0) {
        throw optionError(field, 'expected "extractor:key=value".');
      }
      const extractor = spec.slice(0, colon);
      const assignment = spec.slice(colon + 1);
      if (!/^[a-z0-9_]+$/i.test(extractor)) {
        throw optionError(field, `extractor name "${extractor.slice(0, 24)}" is not valid.`);
      }
      const eq = assignment.indexOf('=');
      const key = eq === -1 ? assignment : assignment.slice(0, eq);
      const val = eq === -1 ? '' : assignment.slice(eq + 1);
      if (!/^[a-z0-9_]+$/i.test(key)) {
        throw optionError(field, `argument name "${key.slice(0, 24)}" is not valid.`);
      }
      if (FORBIDDEN_EXTRACTOR_ARG_KEYS.has(key.toLowerCase())) {
        throw new YtdlpOptionError(
          'MEDIA_RESOLVE_OPTION_FORBIDDEN',
          '该参数不允许由请求指定。',
          {
            status: 403,
            detail: `extractor-args "${key}" decides where yt-dlp sends requests and is restricted to operator configuration (MEDIA_RESOLVE_EXTRACTOR_ARGS).`,
            field,
          }
        );
      }
      // Values are compared against fixed lists by yt-dlp, so no URL-ish
      // characters are needed and their presence means something is off.
      if (val && !/^[A-Za-z0-9_,.+\-]+$/.test(val)) {
        throw optionError(field, `value for "${key}" contains characters yt-dlp would not accept.`);
      }
    }
    out.push(text);
  }

  return out;
}

function normalizeImpersonate(value, field, availableTargets) {
  const text = assertString(value, field, { max: 64 });
  if (!text) return '';
  if (text === 'any') return '';
  const [client, os] = text.split(':');

  // When the probe managed to enumerate the build's real targets, that list is
  // authoritative — it is the only way to know whether this particular yt-dlp
  // has curl_cffi, and it cannot drift out of date the way a hardcoded list can.
  if (Array.isArray(availableTargets) && availableTargets.length) {
    if (!availableTargets.includes(client)) {
      throw optionError(field, `"${client}" is not available in this yt-dlp build.`);
    }
  } else if (!IMPERSONATE_TARGETS.includes(client)) {
    throw optionError(field, `"${client}" is not a known impersonation target.`);
  }

  if (os && !IMPERSONATE_OS.includes(os)) {
    throw optionError(field, `"${os}" is not a known impersonation platform.`);
  }
  return text;
}

/**
 * Turns the request payload into a fully-populated options object.
 *
 * Every field is present on the result, so callers never have to guess whether
 * an absent key meant "off" or "not supplied". `warnings` carries the features
 * that were dropped because the host cannot support them — the caller decides
 * whether to surface them to the user.
 */
function normalizeOptions(raw = {}, { capabilities = {}, limits = {} } = {}) {
  const warnings = [];
  const ffmpeg = capabilities.ffmpeg === true;

  const presetName = assertEnum(raw.preset, 'preset', Object.keys(PRESETS)) || DEFAULT_PRESET;
  const preset = PRESETS[presetName];

  const options = {
    preset: presetName,
    audioOnly: preset.audioOnly,
    formatId: '',
    needsAudio: asBool(raw.needsAudio, false),
    maxHeight: null,
    container: '',

    // Playlists
    playlistItems: normalizePlaylistItems(raw.playlistItems, 'playlistItems'),

    // Subtitles
    subtitles: asBool(raw.subtitles, false),
    autoSubtitles: asBool(raw.autoSubtitles, false),
    subtitleLangs: '',
    subtitleFormat: '',
    embedSubtitles: asBool(raw.embedSubtitles, false),

    // Enrichment
    writeThumbnail: asBool(raw.writeThumbnail, false),
    embedThumbnail: asBool(raw.embedThumbnail, false),
    embedMetadata: asBool(raw.embedMetadata, false),
    embedChapters: asBool(raw.embedChapters, false),
    embedInfoJson: asBool(raw.embedInfoJson, false),
    writeNfo: asBool(raw.writeNfo, false),

    // Trimming and cutting
    downloadSections: normalizeSections(raw.downloadSections, 'downloadSections'),
    forceKeyframesAtCuts: asBool(raw.forceKeyframesAtCuts, false),
    splitChapters: asBool(raw.splitChapters, false),

    // SponsorBlock
    sponsorblockMark: assertList(raw.sponsorblockMark, 'sponsorblockMark', { itemPattern: /^[a-z_]+$/ }),
    sponsorblockRemove: assertList(raw.sponsorblockRemove, 'sponsorblockRemove', { itemPattern: /^[a-z_]+$/ }),

    // Fairness and throttling
    concurrentFragments: null,
    limitRate: normalizeRate(raw.limitRate, 'limitRate'),
    sleepInterval: null,
    maxSleepInterval: null,

    // Live
    liveFromStart: asBool(raw.liveFromStart, false),
    waitForVideo: '',
    hlsUseMpegts: asBool(raw.hlsUseMpegts, false),

    // Advanced
    impersonate: normalizeImpersonate(raw.impersonate, 'impersonate', capabilities.impersonateTargets),
    extractorArgs: normalizeExtractorArgs(raw.extractorArgs, 'extractorArgs'),
    sanitizeFilenames: asBool(raw.sanitizeFilenames, false),
    trimFilenames: null,

    progress: asBool(raw.progress, false),
  };

  // Supplied values are only validated once the defaults are in place, so the
  // validators below read as a plain list of "if set, check it".
  if (raw.subtitleLangs !== undefined && raw.subtitleLangs !== '') {
    options.subtitleLangs = assertString(raw.subtitleLangs, 'subtitleLangs', {
      max: MAX_LANG_LIST_LENGTH,
    });
    const langs = normalizeLangs(options.subtitleLangs);
    if (!langs.length) throw optionError('subtitleLangs', 'no usable language codes were given.');
    options.subtitleLangs = langs.join(',');
  }
  if (raw.subtitleFormat !== undefined && raw.subtitleFormat !== '') {
    options.subtitleFormat = assertEnum(raw.subtitleFormat, 'subtitleFormat', SUBTITLE_FORMATS);
  }
  if (raw.container !== undefined && raw.container !== '') {
    options.container = assertEnum(raw.container, 'container', OUTPUT_CONTAINERS);
  }
  if (raw.maxHeight !== undefined && raw.maxHeight !== '') {
    options.maxHeight = assertBoundedInt(raw.maxHeight, 'maxHeight', { min: 144, max: 4320 });
  }
  if (raw.concurrentFragments !== undefined && raw.concurrentFragments !== '') {
    options.concurrentFragments = assertBoundedInt(raw.concurrentFragments, 'concurrentFragments', {
      min: 1,
      max: Number(limits.maxConcurrentFragments) || 16,
    });
  }
  if (raw.sleepInterval !== undefined && raw.sleepInterval !== '') {
    options.sleepInterval = assertBoundedInt(raw.sleepInterval, 'sleepInterval', { min: 0, max: 600 });
  }
  if (raw.maxSleepInterval !== undefined && raw.maxSleepInterval !== '') {
    options.maxSleepInterval = assertBoundedInt(raw.maxSleepInterval, 'maxSleepInterval', { min: 0, max: 600 });
  }
  if (raw.trimFilenames !== undefined && raw.trimFilenames !== '') {
    options.trimFilenames = assertBoundedInt(raw.trimFilenames, 'trimFilenames', {
      min: 16,
      max: Number(limits.maxTrimFilenames) || MAX_TRIM_FILENAME_LENGTH,
    });
  }
  if (raw.waitForVideo !== undefined && raw.waitForVideo !== '') {
    options.waitForVideo = assertString(raw.waitForVideo, 'waitForVideo', {
      max: 16,
      pattern: /^\d+(-\d*)?$/,
    });
  }
  for (const category of options.sponsorblockMark) {
    if (!SPONSORBLOCK_CATEGORIES.includes(category)) {
      throw optionError('sponsorblockMark', `"${category}" is not a SponsorBlock category.`);
    }
  }
  for (const category of options.sponsorblockRemove) {
    if (!SPONSORBLOCK_CATEGORIES.includes(category)) {
      throw optionError('sponsorblockRemove', `"${category}" is not a SponsorBlock category.`);
    }
  }

  // The format id comes back from the client, so it is the one value that could
  // reach a yt-dlp expression language. Restricting it to the characters
  // format ids actually use keeps `+`, `[` and `]` out of the selector.
  if (raw.formatId !== undefined && raw.formatId !== '') {
    options.formatId = assertString(raw.formatId, 'formatId', {
      max: 64,
      pattern: /^[A-Za-z0-9._+-]+$/,
      allowEmpty: false,
    });
    // An audio-only preset cannot carry a video stream. Leaving the pinned id
    // in place would ask yt-dlp for "video + best audio" inside a preset that
    // extracts audio, which it rejects outright.
    if (preset.audioOnly) {
      warnings.push({
        code: 'FORMAT_OVERRIDDEN',
        message: '已选预设为纯音频，忽略指定的视频清晰度。',
      });
      options.formatId = '';
      options.needsAudio = false;
    }
  }

  if (options.maxSleepInterval !== null && options.sleepInterval !== null
      && options.maxSleepInterval < options.sleepInterval) {
    throw optionError('maxSleepInterval', 'must be greater than or equal to sleepInterval.');
  }

  // --- Capability gating ---------------------------------------------------
  // Asking for a subtitle file that nobody converts or embeds is still useful
  // without ffmpeg, so only the postprocessing half is gated.
  if (options.subtitles && !options.subtitleLangs) {
    options.subtitleLangs = 'zh.*,en';
  }
  if (options.subtitles && !options.subtitleFormat) {
    options.subtitleFormat = 'srt';
  }

  for (const [key, label] of FFMPEG_ONLY_OPTIONS) {
    if (!options[key]) continue;
    if (ffmpeg) continue;
    options[key] = false;
    warnings.push({
      code: 'FFMPEG_UNAVAILABLE',
      message: `服务器未安装 ffmpeg，已跳过「${label}」。`,
    });
  }

  // Subtitle conversion is what turns a WebVTT track into a .srt a player will
  // pick up, and embedding needs the converted file. Without ffmpeg both are
  // off, but --write-subs still produces whatever the platform serves.
  if (options.subtitles && !ffmpeg) {
    options.embedSubtitles = false;
  }

  if (options.sponsorblockRemove.length && !ffmpeg) {
    warnings.push({
      code: 'FFMPEG_UNAVAILABLE',
      message: '服务器未安装 ffmpeg，已跳过 SponsorBlock 片段移除。',
    });
    options.sponsorblockRemove = [];
  }

  if (options.splitChapters && !ffmpeg) {
    options.splitChapters = false;
  }

  // Chapters can only be embedded into a container that has somewhere to put
  // them; mp4 and mkv do, ts and flv do not.
  if (options.embedChapters && !['mp4', 'mkv', 'webm', 'mov'].includes(resolveContainer(options))) {
    warnings.push({
      code: 'CHAPTERS_UNSUPPORTED',
      message: '目标容器不支持章节信息，已跳过章节嵌入。',
    });
    options.embedChapters = false;
  }

  if (options.impersonate) {
    if (capabilities.impersonate !== true) {
      warnings.push({
        code: 'IMPERSONATE_UNAVAILABLE',
        message: '当前 yt-dlp 构建不支持 TLS 指纹伪装（缺少 curl_cffi），已忽略该参数。',
      });
      options.impersonate = '';
    }
  }

  if (options.waitForVideo || options.liveFromStart || options.hlsUseMpegts) {
    // These only take effect on a live stream; harmless otherwise.
    options.live = true;
  }

  return { options, warnings };
}

// Subtitle language codes: "zh.*" and "en" and "pt-BR". The wildcard form is
// yt-dlp's, so it survives; everything else is charset-checked.
function normalizeLangs(text) {
  const parts = String(text || '')
    .split(',')
    .map((item) => item.trim())
    .filter(Boolean);
  const out = [];
  for (const part of parts) {
    if (!LANG_RE.test(part)) {
      throw optionError('subtitleLangs', `"${part.slice(0, 24)}" is not a valid language selector.`);
    }
    if (!out.includes(part)) out.push(part);
    if (out.length > 32) throw optionError('subtitleLangs', 'no more than 32 languages are allowed.');
  }
  return out;
}

// What the finished file will actually be. The storage layer derives the MIME
// type from the extension, so this has to be right.
function resolveContainer(options) {
  if (options.container) return options.container;
  const preset = PRESETS[options.preset] || PRESETS[DEFAULT_PRESET];
  return preset.container;
}

// --- argv construction ------------------------------------------------------

/**
 * The preset's own flags. `--merge-output-format` is emitted by
 * buildDownloadArgs rather than carried here, so that a host without ffmpeg
 * does not ask for a merge it cannot perform.
 */
function buildPresetArgs(options) {
  const preset = PRESETS[options.preset] || PRESETS[DEFAULT_PRESET];
  return preset.args.slice();
}

/**
 * Format selection. A pinned format id always wins; otherwise the height cap is
 * expressed as a format filter so yt-dlp picks the best stream under it rather
 * than downloading something larger and then refusing it.
 */
function buildFormatArgs(options, { hasFfmpeg }) {
  if (options.audioOnly) return [];

  if (options.formatId) {
    return ['-f', options.needsAudio ? `${options.formatId}+ba/b` : options.formatId];
  }

  if (options.maxHeight) {
    const cap = options.maxHeight;
    return hasFfmpeg
      ? ['-f', `bv*[height<=${cap}]+ba/b[height<=${cap}]/b`]
      : ['-f', `b[height<=${cap}]/b`];
  }

  if (!hasFfmpeg) {
    // Without ffmpeg only a format that already carries both streams can be
    // used at all, so the selector has to say so rather than rely on the merge
    // step that will never run.
    return ['-f', 'b'];
  }

  return [];
}

function buildSubtitleArgs(options, { hasFfmpeg }) {
  const args = [];
  if (!options.subtitles) return args;

  args.push('--write-subs');
  if (options.autoSubtitles) args.push('--write-auto-subs');
  if (options.subtitleLangs) args.push('--sub-langs', options.subtitleLangs);
  if (options.subtitleFormat) {
    args.push('--sub-format', options.subtitleFormat);
    // --convert-subs shells out to ffmpeg, and only text formats have a
    // converter; "best" and json3 would fail the whole run.
    if (hasFfmpeg && ['srt', 'vtt', 'ass', 'lrc'].includes(options.subtitleFormat)) {
      args.push('--convert-subs', options.subtitleFormat);
    }
  }
  if (options.embedSubtitles) args.push('--embed-subs');
  return args;
}

function buildEnrichmentArgs(options) {
  const args = [];
  if (options.writeThumbnail || options.embedThumbnail) args.push('--write-thumbnail');
  if (options.embedThumbnail) args.push('--embed-thumbnail');
  if (options.embedMetadata) args.push('--embed-metadata');
  if (options.embedChapters) args.push('--embed-chapters');
  if (options.embedInfoJson) args.push('--write-info-json');
  return args;
}

function buildCutArgs(options) {
  const args = [];
  if (options.downloadSections) {
    args.push('--download-sections', options.downloadSections);
    if (options.forceKeyframesAtCuts) args.push('--force-keyframes-at-cuts');
  }
  if (options.splitChapters) args.push('--split-chapters');
  return args;
}

function buildSponsorblockArgs(options) {
  const args = [];
  // Removing a category implies marking it, so --mark is only needed for the
  // categories that are not also being removed.
  if (options.sponsorblockMark.length) {
    args.push('--sponsorblock-mark', options.sponsorblockMark.join(','));
  }
  if (options.sponsorblockRemove.length) {
    args.push('--sponsorblock-remove', options.sponsorblockRemove.join(','));
  }
  return args;
}

function buildThrottleArgs(options) {
  const args = [];
  if (options.concurrentFragments !== null) {
    args.push('--concurrent-fragments', String(options.concurrentFragments));
  }
  if (options.limitRate) args.push('--limit-rate', options.limitRate);
  if (options.sleepInterval !== null) {
    args.push('--sleep-interval', String(options.sleepInterval));
  }
  if (options.maxSleepInterval !== null) {
    args.push('--max-sleep-interval', String(options.maxSleepInterval));
  }
  return args;
}

function buildLiveArgs(options) {
  const args = [];
  if (options.liveFromStart) args.push('--live-from-start');
  if (options.waitForVideo) args.push('--wait-for-video', options.waitForVideo);
  if (options.hlsUseMpegts) args.push('--hls-use-mpegts');
  return args;
}

function buildAdvancedArgs(options) {
  const args = [];
  if (options.impersonate) args.push('--impersonate', options.impersonate);
  for (const value of options.extractorArgs) args.push('--extractor-args', value);
  if (options.sanitizeFilenames) args.push('--windows-filenames');
  if (options.trimFilenames !== null) {
    args.push('--trim-filenames', String(options.trimFilenames));
  }
  return args;
}

function buildPlaylistArgs(options) {
  const args = [];
  if (options.playlistItems) {
    // Selecting items out of a playlist is meaningless with expansion off, and
    // is how a caller says "I want item 7 of this collection".
    args.push('--yes-playlist', '--playlist-items', options.playlistItems);
  }
  return args;
}

// yt-dlp writes progress to stdout; the template turns it into one machine
// parseable line per update. A unique prefix is what makes it possible to tell
// progress apart from any other stdout the run might produce.
const PROGRESS_PREFIX = 'KVPROG';
const PROGRESS_TEMPLATE = [
  `download:${PROGRESS_PREFIX}|download|`,
  '%(progress.status)s|',
  '%(progress.downloaded_bytes)s|',
  '%(progress.total_bytes)s|',
  '%(progress.total_bytes_estimate)s|',
  '%(progress.speed)s|',
  '%(progress.eta)s',
].join('');
const POSTPROCESS_TEMPLATE = [
  `postprocess:${PROGRESS_PREFIX}|postprocess|`,
  '%(progress.status)s|',
  '%(progress.postprocessor)s||||',
].join('');

function buildProgressArgs(options) {
  if (!options.progress) return [];
  return [
    '--newline',
    '--progress',
    '--progress-template', PROGRESS_TEMPLATE,
    '--progress-template', POSTPROCESS_TEMPLATE,
  ];
}

/**
 * Interprets one stdout line. Returns null for anything that is not progress,
 * which is how the caller filters ordinary output back out.
 */
function parseProgressLine(line) {
  const text = String(line || '').trim();
  if (!text.startsWith(PROGRESS_PREFIX)) return null;

  const parts = text.split('|');
  const kind = parts[1];
  if (kind === 'download') {
    const status = parts[2] || '';
    const downloaded = toNumber(parts[3]);
    const total = toNumber(parts[4]) || toNumber(parts[5]);
    const speed = toNumber(parts[6]);
    const eta = toNumber(parts[7]);
    return {
      stage: 'download',
      status,
      downloadedBytes: downloaded,
      totalBytes: total,
      // The percentage is derived here rather than read from yt-dlp's own
      // _percent_str, which is padded and formatted for a terminal.
      percent: total > 0 ? Math.min(100, Math.round((downloaded / total) * 1000) / 10) : 0,
      speedBytesPerSecond: speed,
      etaSeconds: eta,
    };
  }
  if (kind === 'postprocess') {
    return {
      stage: 'postprocess',
      status: parts[2] || '',
      processor: parts[3] || '',
      percent: parts[2] === 'finished' ? 100 : 0,
    };
  }
  return null;
}

function toNumber(value) {
  const text = String(value == null ? '' : value).trim();
  if (!text || text === 'NA' || text === 'None') return 0;
  const parsed = Number(text);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 0;
}

/**
 * Every download runs in its own directory, so the artefacts can simply be
 * listed when it finishes. This is more reliable than asking yt-dlp to print
 * the path: a postprocessor that fails half way still leaves the original
 * container on disk, and the size of the file is what tells us which one it is.
 */
function classifyOutputFiles(entries) {
  const buckets = { media: [], subtitles: [], thumbnails: [], metadata: [], other: [] };

  for (const entry of entries || []) {
    const name = String(entry && entry.name || '');
    if (!name) continue;
    const dot = name.lastIndexOf('.');
    const ext = dot === -1 ? '' : name.slice(dot + 1).toLowerCase();

    if (MEDIA_EXTENSIONS.has(ext)) buckets.media.push(entry);
    else if (SUBTITLE_EXTENSIONS.has(ext)) buckets.subtitles.push(entry);
    else if (IMAGE_EXTENSIONS.has(ext)) buckets.thumbnails.push(entry);
    else if (METADATA_EXTENSIONS.has(ext)) buckets.metadata.push(entry);
    else buckets.other.push(entry);
  }

  // A run that produced a video and its audio track separately (a failed merge)
  // would leave two candidates; the largest one is the intended output.
  const primary = buckets.media.slice().sort((a, b) => (b.size || 0) - (a.size || 0))[0] || null;

  return { ...buckets, primary };
}

/**
 * Builds the complete argv for a download run.
 *
 * Order matters to yt-dlp in a few places, so the groups go: preset first (later
 * flags override it), then selection, then everything that only affects output.
 * The URL is appended last by the caller behind a `--` terminator.
 */
function buildDownloadArgs(options, { hasFfmpeg, outputTemplate }) {
  const args = [];
  const preset = PRESETS[options.preset] || PRESETS[DEFAULT_PRESET];

  args.push(...buildPresetArgs(options));
  args.push(...buildPlaylistArgs(options));
  args.push(...buildFormatArgs(options, { hasFfmpeg }));

  // A preset that passes -t already names its merge format, and a merge format
  // is meaningless for an audio extraction.
  if (hasFfmpeg && !options.audioOnly && !preset.remuxes) {
    args.push('--merge-output-format', resolveContainer(options));
  }

  args.push(...buildSubtitleArgs(options, { hasFfmpeg }));
  args.push(...buildEnrichmentArgs(options));
  args.push(...buildCutArgs(options));
  args.push(...buildSponsorblockArgs(options));
  args.push(...buildThrottleArgs(options));
  args.push(...buildLiveArgs(options));
  args.push(...buildAdvancedArgs(options));

  // Keeping the id in the template is what makes the sidecar files association
  // obvious afterwards, and the byte-limited title keeps the path well inside
  // filesystem limits even for a 300-character video title.
  args.push('-o', outputTemplate);

  return args;
}

module.exports = {
  PRESETS,
  DEFAULT_PRESET,
  OUTPUT_CONTAINERS,
  SUBTITLE_FORMATS,
  SPONSORBLOCK_CATEGORIES,
  IMPERSONATE_TARGETS,
  PROGRESS_PREFIX,
  PROGRESS_TEMPLATE,
  POSTPROCESS_TEMPLATE,
  MEDIA_EXTENSIONS,
  SUBTITLE_EXTENSIONS,
  IMAGE_EXTENSIONS,
  METADATA_EXTENSIONS,
  MIME_BY_EXTENSION,
  mimeTypeForFile,
  YtdlpOptionError,
  normalizeOptions,
  normalizeLangs,
  resolveContainer,
  buildDownloadArgs,
  buildFormatArgs,
  buildSubtitleArgs,
  buildEnrichmentArgs,
  buildPresetArgs,
  buildProgressArgs,
  parseProgressLine,
  classifyOutputFiles,
};
