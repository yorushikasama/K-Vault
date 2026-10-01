/**
 * Media resolution via yt-dlp — Docker/self-hosted runtime only.
 *
 * The Cloudflare Pages runtime has no child_process, so this service exists
 * solely on the Hono/Node side. It shells out to the yt-dlp binary to either
 * read metadata (so the UI can offer quality choices) or download the media so
 * the upload pipeline can store it.
 *
 * Design notes:
 * - The host allow-list is the security boundary. Without it a public
 *   deployment would be a general-purpose request forwarder; with it, only
 *   recognised video platforms can be resolved.
 * - Everything the child process emits is bounded: stdout, stderr and wall
 *   clock all have caps, so a hostile URL cannot exhaust the process.
 * - Request-supplied options never reach argv unvalidated. The validation lives
 *   in ./ytdlp-options, which is also where the preset model is defined.
 * - Capabilities (ffmpeg, JS runtime, impersonation, PO tokens) are probed once
 *   and reported, so a caller who asked for subtitles is told when the host
 *   cannot deliver them instead of silently getting a bare video.
 */

const { spawn } = require('node:child_process');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { assertSafeRemoteUrl } = require('../utils/ssrf-guard');
const { fetchRemote } = require('../utils/remote-fetch');
const { createSemaphore } = require('../utils/semaphore');
const { buildVideoNfo, nfoFileName } = require('./nfo-writer');
const {
  PRESETS,
  DEFAULT_PRESET,
  PROGRESS_PREFIX,
  YtdlpOptionError,
  normalizeOptions,
  resolveContainer,
  buildDownloadArgs,
  buildProgressArgs,
  parseProgressLine,
  classifyOutputFiles,
} = require('./ytdlp-options');

// Hosts we are willing to hand to yt-dlp. Suffix-matched, so "bilibili.com"
// also covers "www.bilibili.com" and "m.bilibili.com".
const DEFAULT_ALLOWED_HOSTS = [
  'bilibili.com',
  'b23.tv',
  'bilibili.tv',
  'acfun.cn',
  'douyin.com',
  'iesdouyin.com',
  'kuaishou.com',
  'kwai.com',
  'weibo.com',
  'weibo.cn',
  'xiaohongshu.com',
  'xhslink.com',
  'iqiyi.com',
  'v.qq.com',
  'youku.com',
  'mgtv.com',
  'sohu.com',
  'ixigua.com',
  'youtube.com',
  'youtu.be',
  'twitch.tv',
  'vimeo.com',
  'dailymotion.com',
  'twitter.com',
  'x.com',
  'tiktok.com',
  'instagram.com',
  'nicovideo.jp',
  'nico.ms',
  'ted.com',
];

const MAX_STDIO_BYTES = 16 * 1024 * 1024;
const MAX_STDERR_KEEP_BYTES = 64 * 1024;
const PROBE_TIMEOUT_MS = 5000;
const PROBE_OK_TTL_MS = 5 * 60 * 1000;
const PROBE_FAIL_TTL_MS = 15 * 1000;
const QUEUE_LIMIT_FACTOR = 4;
// Temp-file housekeeping. A download that is killed mid-flight (OOM, restart)
// never reaches its own cleanup, so orphans get swept opportunistically.
const SWEEP_INTERVAL_MS = 30 * 60 * 1000;
const SWEEP_MIN_AGE_MS = 2 * 60 * 60 * 1000;
const TEMP_FILE_PREFIX = 'kv-resolve-';

// --- Share-text and short-link normalisation --------------------------------
// A Douyin "copy link" is a whole sentence, and the short link inside it
// redirects to a share page that yt-dlp's extractor does not match. Both are
// handled before yt-dlp sees anything: the link is lifted out of the text, then
// rewritten to the canonical /video/{id} page. Measured 2026-09-30 on one video:
// /video/{id} -> 32 formats, v.douyin.com short link -> "Unsupported URL".
const URL_IN_TEXT_RE = /https?:\/\/[^\s<>"'`）)】\]]+/i;
const TRAILING_PUNCT_RE = /[.,;:！。，、）)】\]]+$/;
const DOUYIN_AWEME_RE = /(?:\/video\/|\/note\/|\/share\/(?:video|note)\/)(\d{6,})/;
const DOUYIN_MODAL_ID_RE = /[?&]modal_id=(\d{6,})/;
const DOUYIN_CANONICAL_BASE = 'https://www.douyin.com/video/';
const SHORT_LINK_TIMEOUT_MS = 15000;

// Playlist URLs. A pasted collection is the one input that can turn a single
// request into an unbounded amount of work, so it is detected before anything
// is downloaded.
const PLAYLIST_PATH_RE = /\/(?:playlist|album|collection|sets?|series|channel|c|user|@)[/?#]|\/medialist\/|\/space\/|\/list=/i;

// Timeouts, capacity pressure and a missing binary can all be fixed by
// retrying later; everything else is a property of the request itself.
const RETRIABLE_CODES = new Set([
  'MEDIA_RESOLVE_TIMEOUT',
  'MEDIA_RESOLVE_BUSY',
  'MEDIA_RESOLVE_UNAVAILABLE',
  'MEDIA_RESOLVE_RATE_LIMITED',
]);

class MediaResolveError extends Error {
  constructor(code, message, { status = 400, detail = '' } = {}) {
    super(message);
    this.name = 'MediaResolveError';
    this.code = code;
    this.status = status;
    this.detail = detail || message;
    this.retriable = RETRIABLE_CODES.has(code);
  }
}

function toByteCount(value) {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 0;
}

function isStreamPresent(codec) {
  return Boolean(codec) && codec !== 'none';
}

// Same resolution often ships as several codecs. avc1 (H.264) wins because it
// plays everywhere, including Telegram's in-app player, so it is what the
// quality picker offers by default.
function codecRank(codec) {
  const text = String(codec || '').toLowerCase();
  if (text.startsWith('avc1') || text.startsWith('h264')) return 0;
  if (text.startsWith('hvc1') || text.startsWith('hev1')) return 1;
  if (text.startsWith('av01')) return 2;
  if (text.startsWith('vp9') || text.startsWith('vp09')) return 3;
  return 4;
}

function sizeOfFormat(format) {
  return format
    ? (toByteCount(format.filesize) || toByteCount(format.filesize_approx))
    : 0;
}

// Lower is better: preferred codec first, then the larger file.
function compareVariants(a, b) {
  const rankDiff = codecRank(a.vcodec) - codecRank(b.vcodec);
  if (rankDiff !== 0) return rankDiff;
  return sizeOfFormat(b) - sizeOfFormat(a);
}

function newlineList(value) {
  return String(value || '')
    .split(/[\s,]+/)
    .map((item) => item.trim().toLowerCase())
    .filter(Boolean);
}

function buildAllowedHosts(extraHosts) {
  const hosts = new Set(DEFAULT_ALLOWED_HOSTS);
  for (const host of newlineList(extraHosts)) hosts.add(host);
  return hosts;
}

function hostMatches(hostname, allowedHosts) {
  for (const allowed of allowedHosts) {
    if (hostname === allowed || hostname.endsWith(`.${allowed}`)) return true;
  }
  return false;
}

// Loopback, RFC1918, CGNAT, link-local (including the cloud-metadata address),
// unique-local and IPv4-mapped IPv6. These are refused EVEN when unknown hosts
// are allowed — a pasted URL pointing back at the server's own network is the
// SSRF primitive the allow-list exists to stop. Explicit allow-list entries
// bypass this check: an operator who adds an internal host to EXTRA_HOSTS has
// made that call deliberately.
const PRIVATE_HOSTNAME_RE = /(^|\.)localhost$|(^|\.)local$|(^|\.)internal$/;

function isPrivateOrLocalHost(hostname) {
  const host = String(hostname || '').toLowerCase().replace(/^\[|\]$/g, '');
  if (!host) return true;
  if (host === '*' || host.endsWith('.*')) return true;
  if (PRIVATE_HOSTNAME_RE.test(host)) return true;

  // IPv6 literals: loopback, link-local (fe80::/10), unique-local (fc00::/7),
  // and the ::ffff:a.b.c.d mapped form, which is checked via its embedded v4.
  if (host.includes(':')) {
    if (host === '::' || host === '::1') return true;
    if (/^f[cd][0-9a-f]{2}:/.test(host)) return true;
    if (/^fe[89ab][0-9a-f]:/.test(host)) return true;
    const mapped = host.match(/^::ffff:(\d{1,3}(?:\.\d{1,3}){3})$/);
    if (mapped) return isPrivateIpv4(mapped[1]);
    return false;
  }

  // Dotted quad, including all the decimal/octal/hex label tricks a URL can
  // carry (e.g. http://0x7f000001 or http://2130706433 still resolve to
  // 127.0.0.1): normalize every label the same way the OS resolver would.
  const labels = host.split('.');
  if (labels.length === 1) {
    // A single label packs the whole 32-bit address.
    const label = labels[0];
    let packed;
    if (/^0x[0-9a-f]+$/i.test(label)) packed = parseInt(label.slice(2), 16);
    else if (/^0[0-7]+$/.test(label)) packed = parseInt(label, 8);
    else if (/^\d+$/.test(label)) packed = parseInt(label, 10);
    else return false;
    if (!Number.isFinite(packed) || packed < 0 || packed > 0xffffffff) return false;
    return isPrivateIpv4(
      [(packed >>> 24) & 255, (packed >>> 16) & 255, (packed >>> 8) & 255, packed & 255].join('.')
    );
  }
  if (labels.length !== 4) return false;
  const octets = [];
  for (const label of labels) {
    let value;
    if (/^0x[0-9a-f]+$/i.test(label)) value = parseInt(label.slice(2), 16);
    else if (/^0[0-7]+$/.test(label)) value = parseInt(label, 8);
    else if (/^\d+$/.test(label)) value = parseInt(label, 10);
    else return false;
    if (!Number.isFinite(value) || value < 0 || value > 255) return false;
    octets.push(value);
  }
  return isPrivateIpv4(octets.join('.'));
}

function isPrivateIpv4(ip) {
  const [a, b] = ip.split('.').map(Number);
  if (a === 10 || a === 127 || a === 0) return true;
  if (a === 172 && b >= 16 && b <= 31) return true;
  if (a === 192 && b === 168) return true;
  if (a === 169 && b === 254) return true;
  if (a === 100 && b >= 64 && b <= 127) return true;
  return false;
}

// The pasted "copy link" text is a sentence; the URL is one token inside it.
function extractFirstUrl(text) {
  const match = String(text || '').match(URL_IN_TEXT_RE);
  return match ? match[0].replace(TRAILING_PUNCT_RE, '') : '';
}

function isDouyinHost(hostname) {
  return /(^|\.)(douyin\.com|iesdouyin\.com)$/.test(String(hostname || '').toLowerCase());
}

// The canonical page, the share page and the discover page all carry the same
// numeric id; pull it whichever form the caller pasted.
function douyinAwemeId(href) {
  const text = String(href || '');
  const direct = text.match(DOUYIN_AWEME_RE);
  if (direct) return direct[1];
  const modal = text.match(DOUYIN_MODAL_ID_RE);
  return modal ? modal[1] : '';
}

// yt-dlp runs with --no-config, but it still needs enough environment to find
// its own binary, a writable temp dir and the system TLS store.
function buildChildEnv(proxy) {
  const env = {
    PATH: process.env.PATH || '',
    LANG: 'C.UTF-8',
    LC_ALL: 'C.UTF-8',
    NO_COLOR: '1',
    PYTHONIOENCODING: 'utf-8',
  };
  const passthrough = ['SYSTEMROOT', 'SYSTEMDRIVE', 'WINDIR', 'HOME', 'USERPROFILE', 'TEMP', 'TMP', 'TMPDIR'];
  for (const key of passthrough) {
    if (process.env[key]) env[key] = process.env[key];
  }
  if (proxy) {
    env.HTTP_PROXY = proxy;
    env.HTTPS_PROXY = proxy;
    env.http_proxy = proxy;
    env.https_proxy = proxy;
  }
  return env;
}

function pickBestFormat(formats) {
  if (!formats.length) return null;
  const bySize = formats.slice().sort((a, b) => {
    const sizeDiff = (toByteCount(b.filesize) || toByteCount(b.filesize_approx))
      - (toByteCount(a.filesize) || toByteCount(a.filesize_approx));
    if (sizeDiff !== 0) return sizeDiff;
    return (Number(b.height) || 0) - (Number(a.height) || 0);
  });
  return bySize[0];
}

// When only separate DASH streams are offered (Bilibili, YouTube), the bytes
// that actually land on disk are video + audio put together.
function estimateTotalBytes(formats) {
  const videoOnly = formats.filter((f) => isStreamPresent(f.vcodec) && !isStreamPresent(f.acodec));
  const audioOnly = formats.filter((f) => isStreamPresent(f.acodec) && !isStreamPresent(f.vcodec));
  return sizeOfFormat(pickBestFormat(videoOnly)) + sizeOfFormat(pickBestFormat(audioOnly));
}

// One entry per distinct resolution so the caller can offer a quality picker
// instead of always taking the largest stream. Sizes include the audio track
// that has to be fetched alongside a video-only stream.
function buildVariants(formats) {
  const audioBytes = sizeOfFormat(
    pickBestFormat(formats.filter((f) => isStreamPresent(f.acodec) && !isStreamPresent(f.vcodec)))
  );

  const byHeight = new Map();
  for (const format of formats) {
    if (!isStreamPresent(format.vcodec)) continue;
    const height = Number(format.height) || 0;
    if (height <= 0) continue;
    const current = byHeight.get(height);
    if (!current || compareVariants(format, current) < 0) byHeight.set(height, format);
  }

  return Array.from(byHeight.entries())
    .sort((a, b) => b[0] - a[0])
    .map((entry) => {
      const format = entry[1];
      const needsAudio = !isStreamPresent(format.acodec);
      return {
        height: entry[0],
        formatId: String(format.format_id || ''),
        ext: String(format.ext || ''),
        vcodec: String(format.vcodec || ''),
        fps: Number(format.fps) || 0,
        needsAudio,
        filesize: sizeOfFormat(format) + (needsAudio ? audioBytes : 0),
      };
    })
    .filter((variant) => variant.formatId);
}

// Audio-only releases: the quality picker has nothing to show, so the tracks
// are offered as what they are instead of as resolutions.
const AUDIO_CODEC_RANK = ['mp4a', 'opus', 'vorbis', 'mp3', 'flac', 'aac', 'ec-3', 'ac-3'];

function audioCodecRank(codec) {
  const text = String(codec || '').toLowerCase();
  for (let index = 0; index < AUDIO_CODEC_RANK.length; index += 1) {
    if (text.startsWith(AUDIO_CODEC_RANK[index])) return index;
  }
  return AUDIO_CODEC_RANK.length;
}

function buildAudioVariants(formats) {
  const audioOnly = formats.filter((f) => isStreamPresent(f.acodec) && !isStreamPresent(f.vcodec));
  return audioOnly
    .slice()
    .sort((a, b) => {
      const rankDiff = audioCodecRank(a.acodec) - audioCodecRank(b.acodec);
      if (rankDiff !== 0) return rankDiff;
      return (Number(b.abr) || 0) - (Number(a.abr) || 0);
    })
    .slice(0, 12)
    .map((format) => ({
      formatId: String(format.format_id || ''),
      ext: String(format.ext || ''),
      acodec: String(format.acodec || ''),
      abr: Number(format.abr) || 0,
      filesize: sizeOfFormat(format),
      audioOnly: true,
    }))
    .filter((variant) => variant.formatId);
}

function firstEntry(info) {
  if (!info || typeof info !== 'object') return null;
  if (Array.isArray(info.entries) && info.entries.length) {
    return info.entries.find((entry) => entry && typeof entry === 'object') || null;
  }
  return info;
}

// yt-dlp's stderr is the only place the actual reason lives; map the common
// ones onto codes the caller can act on instead of a generic failure.
function classifyFailure(stderr, exitCode, { cookiesConfigured = false } = {}) {
  const text = String(stderr || '').toLowerCase();

  if (text.includes('unsupported url')) {
    return new MediaResolveError('MEDIA_RESOLVE_UNSUPPORTED_SITE', '该链接暂不受支持的站点。', {
      status: 422,
      detail: 'yt-dlp reported an unsupported URL.',
    });
  }
  if (text.includes('sign in') || text.includes('login required')
      || text.includes('account authentication')) {
    return new MediaResolveError('MEDIA_RESOLVE_AUTH_REQUIRED', '该视频需要登录凭证才能解析。', {
      status: 422,
      detail: 'The platform requires cookies; configure MEDIA_RESOLVE_COOKIES_FILE.',
    });
  }
  if (text.includes('cookies')) {
    // Douyin's extractor raises "Fresh cookies ..." for every failure it hits:
    // measured on 2026-09-30, a deleted video and an empty cookie jar produce
    // byte-identical stderr on the same request. Once a cookie jar is configured
    // the message therefore cannot mean "you need cookies" — it usually means
    // the video is gone. AUTH_REQUIRED stays only for the no-jar case, where
    // configuring one really is the remedy.
    if (cookiesConfigured && text.includes('fresh cookies')) {
      return new MediaResolveError('MEDIA_RESOLVE_UNAVAILABLE_VIDEO',
        '视频不可用或已被删除（若视频在客户端可见，也可能是 Cookie 已失效）。', {
          status: 422,
          detail: 'Douyin reports this error for unavailable videos even with a valid jar; refresh MEDIA_RESOLVE_COOKIES_FILE only if the video is confirmed visible.',
        });
    }
    return new MediaResolveError('MEDIA_RESOLVE_AUTH_REQUIRED', '该视频需要登录凭证才能解析。', {
      status: 422,
      detail: 'The platform requires cookies; configure MEDIA_RESOLVE_COOKIES_FILE.',
    });
  }
  if (text.includes('private video') || text.includes('this video is unavailable') || text.includes('not available')) {
    return new MediaResolveError('MEDIA_RESOLVE_UNAVAILABLE_VIDEO', '视频不可用或已被删除。', {
      status: 422,
      detail: 'The platform reports the video as unavailable.',
    });
  }
  // Bilibili words its region block this way; an overseas server IP cannot see
  // mainland-only videos, and no retry changes that.
  if (text.includes('deleted or geo-restricted')) {
    return new MediaResolveError('MEDIA_RESOLVE_UNAVAILABLE_VIDEO',
      '视频不可用或已被删除（该视频可能有地区限制）。', {
        status: 422,
        detail: 'The platform reports the video as deleted or geo-restricted; a mainland IP (or MEDIA_RESOLVE_PROXY) may be required.',
      });
  }
  // 403 and "unable to download video data" are what the anti-bot checks emit
  // once cookies have gone stale; the remedy is operator action, not a retry.
  if (text.includes('403') || text.includes('forbidden')
      || text.includes('unable to download video data')) {
    return new MediaResolveError('MEDIA_RESOLVE_FORBIDDEN', '平台拒绝了本次请求（403），通常是 Cookie 过期或触发了风控。', {
      status: 502,
      detail: 'The platform refused the request; refresh the cookie jar or configure MEDIA_RESOLVE_IMPERSONATE.',
    });
  }
  if (text.includes('requested format is not available') || text.includes('no video formats found')) {
    return new MediaResolveError('MEDIA_RESOLVE_NO_FORMAT', '没有解析到可用的视频流。', {
      status: 422,
      detail: 'The selected format is not available for this video.',
    });
  }
  if (text.includes('signature extraction failed') || text.includes('nsig extraction failed')
      || text.includes('javascript runtime') || text.includes('js runtime')) {
    return new MediaResolveError('MEDIA_RESOLVE_JS_RUNTIME_REQUIRED', '该站点需要 JavaScript 运行时才能解析。', {
      status: 502,
      detail: 'Install a JS runtime (deno or node) and point MEDIA_RESOLVE_JS_RUNTIME at it.',
    });
  }
  if (text.includes('timed out') || text.includes('timeout') || text.includes('read operation timed out')) {
    return new MediaResolveError('MEDIA_RESOLVE_TIMEOUT', '解析超时，请稍后重试。', {
      status: 504,
      detail: 'The platform did not respond in time.',
    });
  }
  if (text.includes('http error 429') || text.includes('too many requests')) {
    return new MediaResolveError('MEDIA_RESOLVE_RATE_LIMITED', '平台限流，请稍后重试。', {
      status: 503,
      detail: 'The platform is rate limiting this server.',
    });
  }
  // Bilibili answers risk control with 412 (Precondition Failed) instead of
  // 429: measured on 2026-10-01 after repeated requests from one IP. It clears
  // on its own, so the remedy is waiting, not retrying harder.
  if (text.includes('http error 412') || text.includes('precondition failed')) {
    return new MediaResolveError('MEDIA_RESOLVE_RATE_LIMITED', '触发了平台风控，请稍后再试。', {
      status: 503,
      detail: 'The platform answered HTTP 412 (risk control); this usually clears on its own after a cooldown.',
    });
  }

  return new MediaResolveError('MEDIA_RESOLVE_FAILED', '解析失败。', {
    status: 502,
    detail: `yt-dlp exited with code ${exitCode}.`,
  });
}

class MediaResolveService {
  constructor({ config, jobRegistry = null }) {
    const settings = (config && config.mediaResolve) || {};

    this.enabled = settings.enabled !== false;
    this.configuredBinaryPath = String(settings.binaryPath || '').trim();
    this.timeoutMs = Math.max(1000, Number(settings.timeoutMs) || 60000);
    this.downloadTimeoutMs = Math.max(this.timeoutMs, Number(settings.downloadTimeoutMs) || 600000);
    this.maxConcurrency = Math.max(1, Number(settings.maxConcurrency) || 2);
    this.maxDurationSeconds = Math.max(0, Number(settings.maxDurationSeconds) || 0);
    this.maxFileSizeBytes = Math.max(0, Number(settings.maxFileSizeBytes) || 0);
    this.maxUrlLength = Math.max(64, Number(settings.maxUrlLength) || 2048);
    this.cookiesFile = String(settings.cookiesFile || '').trim();
    // Per-site jars: yt-dlp accepts one --cookies file per run, so a logged-in
    // Bilibili jar and a guest Douyin jar cannot ride in the same file without
    // each platform receiving the other's cookies. The most specific host match
    // wins; everything else falls back to cookiesFile.
    this.cookiesByHost = new Map(
      (Array.isArray(settings.cookiesByHost) ? settings.cookiesByHost : [])
        .map((pair) => [String(pair.host || '').toLowerCase(), String(pair.path || '').trim()])
        .filter(([host, jarPath]) => host && jarPath)
    );
    this.proxy = String(settings.proxy || '').trim();
    this.allowUnknownHosts = settings.allowUnknownHosts === true;
    this.allowedHosts = buildAllowedHosts(settings.extraHosts);
    this.userAgent = String(settings.userAgent || '').trim() || 'yt-dlp';
    this.ffmpegPath = String(settings.ffmpegPath || '').trim() || 'ffmpeg';
    // Downloads land here before being handed to the storage layer; the caller
    // removes each file in a finally block.
    this.tempDir = String(settings.tempDir || '').trim() || path.join(os.tmpdir(), 'k-vault-resolve');

    // --- Capability configuration ---
    this.jsRuntime = String(settings.jsRuntime || 'node').trim();
    this.jsRuntimePath = String(settings.jsRuntimePath || '').trim();
    this.remoteComponents = String(settings.remoteComponents || '').trim();
    this.extractorRetries = Math.max(0, Number(settings.extractorRetries) || 3);
    this.fragmentRetries = Math.max(0, Number(settings.fragmentRetries) || 10);
    this.retrySleep = String(settings.retrySleep || '').trim();
    this.socketTimeout = Math.max(1, Number(settings.socketTimeout) || 20);
    this.concurrentFragments = Math.max(0, Number(settings.concurrentFragments) || 4);
    this.maxConcurrentFragments = Math.max(1, Number(settings.maxConcurrentFragments) || 16);
    this.limitRate = String(settings.limitRate || '').trim();
    this.maxFilesize = String(settings.maxFilesize || '').trim();
    this.extractorArgs = String(settings.extractorArgs || '').trim();
    this.configuredImpersonate = String(settings.impersonate || '').trim();

    // Enrichment defaults. A per-request value always wins over these, but only
    // in the "on" direction — an operator who turned subtitle writing on has
    // decided what this deployment stores, so a request cannot turn it back off.
    this.defaultSubtitles = settings.writeSubtitles === true;
    this.defaultSubtitleLangs = String(settings.subtitleLangs || 'zh.*,en').trim();
    this.defaultWriteThumbnail = settings.writeThumbnail === true;
    this.defaultWriteInfoJson = settings.writeInfoJson === true;
    this.defaultWriteNfo = settings.writeNfo === true;
    this.defaultEmbedMetadata = settings.embedMetadata === true;
    this.defaultEmbedThumbnail = settings.embedThumbnail === true;

    this.sidecarEnabled = settings.sidecarEnabled !== false;
    this.maxSidecarFiles = Math.max(0, Number(settings.maxSidecarFiles) || 12);
    this.maxSidecarBytes = Math.max(0, Number(settings.maxSidecarBytes) || 20 * 1024 * 1024);
    this.allowPlaylists = settings.allowPlaylists !== false;
    this.maxPlaylistItems = Math.max(1, Number(settings.maxPlaylistItems) || 25);
    this.allowLive = settings.allowLive !== false;
    this.progressEnabled = settings.progressEnabled !== false;

    this.jobRegistry = jobRegistry;

    // Shared implementation (lib/utils/semaphore.js). This class used to carry its
    // own copy of the acquire/release dance — which is precisely how the upload
    // paths ended up with no limit at all while this one had one.
    this.gate = createSemaphore({
      limit: this.maxConcurrency,
      queueLimit: this.maxConcurrency * QUEUE_LIMIT_FACTOR,
      buildBusyError: () => new MediaResolveError('MEDIA_RESOLVE_BUSY', '解析队列已满，请稍后重试。', {
        status: 503,
        detail: 'Too many concurrent resolve requests.',
      }),
    });
    this.probeCache = null;
    this.ffmpegCache = null;
    this.impersonateCache = null;
    this.lastSweepAt = 0;
  }

  resolveBinaryPath() {
    return this.configuredBinaryPath || 'yt-dlp';
  }

  isHostAllowed(hostname) {
    if (hostMatches(hostname, this.allowedHosts)) return true;
    // Unknown hosts are allowed only when they are demonstrably public; the
    // loopback/private ranges stay refused so "allow all" cannot be turned
    // into a tunnel back at the server's own network.
    if (this.allowUnknownHosts) return !isPrivateOrLocalHost(hostname);
    return false;
  }

  assertUrlAllowed(rawUrl) {
    const text = String(rawUrl || '').trim();
    if (!text) {
      throw new MediaResolveError('MEDIA_RESOLVE_URL_REQUIRED', '请输入视频链接。', {
        status: 400,
        detail: 'Request body has no "url" value.',
      });
    }
    if (text.length > this.maxUrlLength) {
      throw new MediaResolveError('MEDIA_RESOLVE_URL_TOO_LONG', '链接过长。', {
        status: 400,
        detail: `URL exceeds ${this.maxUrlLength} characters.`,
      });
    }

    let parsed;
    try {
      parsed = new URL(text);
    } catch {
      throw new MediaResolveError('MEDIA_RESOLVE_INVALID_URL', '链接格式无效。', {
        status: 400,
        detail: 'The value is not a valid absolute URL.',
      });
    }

    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
      throw new MediaResolveError('MEDIA_RESOLVE_INVALID_URL', '仅支持 http/https 链接。', {
        status: 400,
        detail: `Unsupported protocol: ${parsed.protocol}`,
      });
    }

    const hostname = parsed.hostname.toLowerCase().replace(/^\[|\]$/g, '');
    if (!this.isHostAllowed(hostname)) {
      throw new MediaResolveError('MEDIA_RESOLVE_HOST_NOT_ALLOWED', '暂不支持该站点的链接。', {
        status: 403,
        detail: `Host ${hostname} is not in the allow-list; extend it with MEDIA_RESOLVE_EXTRA_HOSTS or allow all with MEDIA_RESOLVE_ALLOW_UNKNOWN_HOSTS.`,
      });
    }

    return parsed;
  }

  // Everything both public entry points need before yt-dlp runs: tolerate a
  // pasted share sentence, enforce the host allow-list, then rewrite the URL to
  // a form the extractor actually understands.
  async prepareTarget(rawUrl) {
    const text = String(rawUrl || '').trim();
    const candidate = extractFirstUrl(text) || text;
    const parsed = this.assertUrlAllowed(candidate);
    return this.normalizeShareUrl(parsed);
  }

  // Douyin's canonical /video/{id} page is the only form yt-dlp's extractor
  // matches; its short links and share pages are not. Other hosts pass through
  // untouched — the rewrite is meaningless there and could only break an
  // extractor that depends on the original URL.
  async normalizeShareUrl(parsed) {
    if (!isDouyinHost(parsed.hostname)) return parsed;

    let id = douyinAwemeId(parsed.href);
    if (!id) {
      const resolved = await this.followShortLink(parsed.href);
      if (resolved) id = douyinAwemeId(resolved);
    }
    if (!id) return parsed;

    try {
      return new URL(`${DOUYIN_CANONICAL_BASE}${id}`);
    } catch {
      return parsed;
    }
  }

  // A v.douyin.com link is a 302 to the share page; only the Location chain is
  // needed, so the body is dropped as soon as the final URL is known. Failure is
  // deliberately not fatal: fall back to the original URL and let yt-dlp report
  // the real reason.
  async followShortLink(url) {
    try {
      const { response, finalUrl } = await fetchRemote({
        url,
        headers: { 'User-Agent': this.userAgent },
        timeoutMs: SHORT_LINK_TIMEOUT_MS,
      });
      try {
        await response.body?.cancel();
      } catch {
        // Body already released.
      }
      return finalUrl;
    } catch {
      return '';
    }
  }

  // yt-dlp rewrites its --cookies file on exit, and the master jar is owned by
  // the harvester, not by the service user. Handing yt-dlp a throwaway copy
  // keeps the master immutable and sidesteps the ownership mismatch entirely.
  // Returns '' when nothing readable is configured, which yt-dlp then reports as
  // the familiar "fresh cookies needed".
  async materializeCookies(hostname = '') {
    const jarPath = this.selectCookiesFile(hostname);
    if (!jarPath) return '';
    try {
      await fs.promises.mkdir(this.tempDir, { recursive: true });
      const dest = path.join(
        this.tempDir,
        `${TEMP_FILE_PREFIX}cookies-${crypto.randomBytes(4).toString('hex')}.txt`
      );
      await fs.promises.copyFile(jarPath, dest);
      return dest;
    } catch {
      return '';
    }
  }

  // Exact hostname first, then the longest domain-suffix mapping
  // ("bilibili.com" covers www.bilibili.com), then the generic jar.
  selectCookiesFile(hostname) {
    const host = String(hostname || '').toLowerCase().replace(/^\[|\]$/g, '');
    if (host) {
      if (this.cookiesByHost.has(host)) return this.cookiesByHost.get(host);
      let best = '';
      let bestLength = 0;
      for (const [mapped, jarPath] of this.cookiesByHost) {
        if (host.endsWith(`.${mapped}`) && mapped.length > bestLength) {
          best = jarPath;
          bestLength = mapped.length;
        }
      }
      if (best) return best;
    }
    return this.cookiesFile;
  }

  // Probing shells out too, so cache both outcomes: successes for a few
  // minutes, failures briefly (a missing binary is fixed by the operator).
  async probe({ force = false } = {}) {
    if (!this.enabled) {
      return { available: false, version: '', binaryPath: this.resolveBinaryPath(), reason: 'disabled' };
    }

    const now = Date.now();
    if (!force && this.probeCache) {
      const ttl = this.probeCache.available ? PROBE_OK_TTL_MS : PROBE_FAIL_TTL_MS;
      if (now - this.probeCache.at < ttl) return this.probeCache.result;
    }

    const binaryPath = this.resolveBinaryPath();
    let result;

    if (this.configuredBinaryPath && !fs.existsSync(this.configuredBinaryPath)) {
      result = { available: false, version: '', binaryPath, reason: 'binary-missing' };
    } else {
      try {
        const stdout = await this.runProcess(['--version'], PROBE_TIMEOUT_MS);
        const version = String(stdout || '').trim().split('\n')[0].slice(0, 64);
        result = { available: true, version, binaryPath, reason: '' };
      } catch (error) {
        result = {
          available: false,
          version: '',
          binaryPath,
          reason: error && error.code === 'ENOENT' ? 'binary-missing' : 'probe-failed',
        };
      }
    }

    this.probeCache = { at: now, result };
    return result;
  }

  // ffmpeg is what turns separate video/audio tracks into one file and what
  // every embed/convert postprocessor shells out to. Without it the service
  // still works, it just cannot merge or enrich.
  async probeFfmpeg() {
    if (this.ffmpegCache && Date.now() - this.ffmpegCache.at < PROBE_OK_TTL_MS) {
      return this.ffmpegCache.result;
    }

    let result;
    try {
      const stdout = await this.runProcessWith(this.ffmpegPath, ['-version'], PROBE_TIMEOUT_MS);
      result = { available: true, version: String(stdout || '').split('\n')[0].slice(0, 80) };
    } catch (error) {
      result = {
        available: false,
        version: '',
        reason: error && error.code === 'ENOENT' ? 'binary-missing' : 'probe-failed',
      };
    }

    this.ffmpegCache = { at: Date.now(), result };
    return result;
  }

  // Impersonation needs curl_cffi inside the yt-dlp build, which not every
  // artefact ships (the Unix zipimport binary does not). Asking yt-dlp for its
  // real target list is the only reliable answer, and it doubles as the
  // allow-list that request-supplied targets are validated against.
  async probeImpersonate() {
    if (this.impersonateCache && Date.now() - this.impersonateCache.at < PROBE_OK_TTL_MS) {
      return this.impersonateCache.result;
    }

    let result = { available: false, targets: [] };
    try {
      const stdout = await this.runProcess(['--list-impersonate-targets'], PROBE_TIMEOUT_MS);
      // Output is a table: a header row ("Client  OS  Source"), a rule of
      // dashes, then one row per target. Only rows below the rule are data —
      // keying off the dashes rather than the header text is what keeps the
      // literal word "Client" out of the target list.
      const targets = [];
      let sawSeparator = false;
      for (const line of String(stdout || '').split('\n')) {
        const text = line.trim();
        if (!text) continue;
        if (/^-{3,}/.test(text)) {
          sawSeparator = true;
          continue;
        }
        if (!sawSeparator) continue;
        const match = text.match(/^([A-Za-z][A-Za-z0-9]*(?:-\d+(?:\.\d+)?)?)\s{2,}\S/);
        if (!match) continue;
        const target = match[1].toLowerCase();
        if (!targets.includes(target)) targets.push(target);
      }
      result = { available: targets.length > 0, targets };
    } catch {
      result = { available: false, targets: [] };
    }

    this.impersonateCache = { at: Date.now(), result };
    return result;
  }

  // The JS runtime is what solves YouTube's signature challenges. yt-dlp 2025.11
  // made a runtime mandatory for full YouTube support and only enables deno by
  // default, so a node-based image has to say so explicitly.
  async probeJsRuntime() {
    if (!this.jsRuntime || this.jsRuntime === 'none') {
      return { configured: '', available: false, path: '' };
    }
    const binary = this.jsRuntimePath || this.jsRuntime;
    try {
      await this.runProcessWith(binary, ['--version'], PROBE_TIMEOUT_MS);
      return { configured: this.jsRuntime, available: true, path: binary };
    } catch {
      // Fall back to PATH resolution; a runtime installed under a different name
      // still counts as long as the configured name starts one.
      try {
        await this.runProcessWith(this.jsRuntime, ['--version'], PROBE_TIMEOUT_MS);
        return { configured: this.jsRuntime, available: true, path: this.jsRuntime };
      } catch {
        return { configured: this.jsRuntime, available: false, path: binary };
      }
    }
  }

  // PO tokens are what YouTube's `web` client needs for higher resolutions. The
  // plugin route requires a Python environment, which a PyInstaller build does
  // not provide, so what can be checked is whether a provider is reachable and
  // whether the extraction args point at one.
  probePotProvider() {
    const configured = /youtubepot|pot_provider|getpot/i.test(this.extractorArgs);
    return {
      configured,
      note: configured
        ? 'extractor-args reference a PO token provider.'
        : 'No PO token provider configured; YouTube may be limited to lower resolutions.',
    };
  }

  async getCapabilities() {
    const probe = await this.probe();
    if (!probe.available) {
      return {
        ffmpeg: false,
        jsRuntime: { configured: this.jsRuntime, available: false, path: '' },
        impersonate: false,
        impersonateTargets: [],
        potProvider: this.probePotProvider(),
        sidecar: false,
        playlists: false,
        live: false,
        progress: false,
        presets: Object.entries(PRESETS).map(([id, preset]) => ({
          id,
          label: preset.label,
          audioOnly: preset.audioOnly,
        })),
        limits: {
          maxPlaylistItems: this.maxPlaylistItems,
          maxSidecarFiles: this.maxSidecarFiles,
          maxConcurrentFragments: this.maxConcurrentFragments,
          maxFileSizeBytes: this.maxFileSizeBytes,
          maxDurationSeconds: this.maxDurationSeconds,
        },
        hostPolicy: {
          allowUnknownHosts: this.allowUnknownHosts,
          cookieHosts: Array.from(this.cookiesByHost.keys()).sort(),
        },
      };
    }

    const [ffmpeg, impersonate, jsRuntime] = await Promise.all([
      this.probeFfmpeg(),
      this.probeImpersonate(),
      this.probeJsRuntime(),
    ]);

    return {
      ffmpeg: ffmpeg.available,
      ffmpegVersion: ffmpeg.version || '',
      jsRuntime,
      impersonate: impersonate.available,
      impersonateTargets: impersonate.targets,
      potProvider: this.probePotProvider(),
      sidecar: this.sidecarEnabled,
      playlists: this.allowPlaylists,
      live: this.allowLive,
      progress: this.progressEnabled && Boolean(this.jobRegistry),
      presets: Object.entries(PRESETS).map(([id, preset]) => ({
        id,
        label: preset.label,
        audioOnly: preset.audioOnly,
      })),
      limits: {
        maxPlaylistItems: this.maxPlaylistItems,
        maxSidecarFiles: this.maxSidecarFiles,
        maxConcurrentFragments: this.maxConcurrentFragments,
        maxFileSizeBytes: this.maxFileSizeBytes,
        maxDurationSeconds: this.maxDurationSeconds,
      },
      hostPolicy: {
        allowUnknownHosts: this.allowUnknownHosts,
        cookieHosts: Array.from(this.cookiesByHost.keys()).sort(),
      },
    };
  }

  async getStatus() {
    const probe = await this.probe();
    const ffmpeg = this.enabled ? await this.probeFfmpeg() : { available: false, version: '' };
    const status = {
      enabled: this.enabled,
      available: probe.available,
      version: probe.version,
      binaryPath: probe.binaryPath,
      reason: probe.reason,
      ffmpegAvailable: ffmpeg.available,
      ffmpegVersion: ffmpeg.version,
      mergeSupported: probe.available && ffmpeg.available,
      maxConcurrency: this.maxConcurrency,
      timeoutMs: this.timeoutMs,
      downloadTimeoutMs: this.downloadTimeoutMs,
      userAgent: this.userAgent,
      cookiesConfigured: Boolean(this.cookiesFile) || this.cookiesByHost.size > 0,
      // Hostnames only — jar paths are server-side details the API must not leak.
      cookieHosts: Array.from(this.cookiesByHost.keys()).sort(),
      proxyConfigured: Boolean(this.proxy),
      allowUnknownHosts: this.allowUnknownHosts,
      allowedHosts: this.allowUnknownHosts ? [] : Array.from(this.allowedHosts).sort(),
      // The capability block is what the UI uses to decide which controls to
      // offer; reporting it here means a client never has to guess.
      capabilities: await this.getCapabilities(),
      queue: this.gate.snapshot(),
    };
    if (this.jobRegistry) status.jobs = this.jobRegistry.stats();
    return status;
  }

  acquire() {
    return this.gate.acquire();
  }

  release() {
    this.gate.release();
  }

  /**
   * Flags shared by metadata and download runs.
   *
   * `--no-config` matters: it stops yt-dlp picking up a config file from the
   * image or the operator's home directory, which would make behaviour depend on
   * something the deployment does not control.
   */
  buildCommonArgs(url, cookiesPath = '') {
    const args = [
      '--no-playlist',
      '--no-warnings',
      '--no-progress',
      '--no-config',
      '--no-exec',
      '--no-mtime',
      '--socket-timeout', String(this.socketTimeout),
      '--retries', '2',
    ];

    // Retry hardening. The 403s and 5xx the big platforms emit mid-download are
    // usually transient, and a bare "--retries 2" gives up before the backoff
    // has a chance to help.
    if (this.extractorRetries > 0) {
      args.push('--extractor-retries', String(this.extractorRetries));
    }
    if (this.fragmentRetries > 0) {
      args.push('--fragment-retries', String(this.fragmentRetries));
    }
    if (this.retrySleep) {
      args.push('--retry-sleep', this.retrySleep);
    }

    // Bilibili answers 412 to any "Mozilla/..." UA that lacks a browser-grade
    // signature but accepts an API-style one, so the default stays non-browser.
    if (this.userAgent) {
      args.push('--user-agent', this.userAgent);
    }
    // cookiesPath is a per-call copy (see materializeCookies); the configured
    // master jar is never handed to yt-dlp directly.
    if (cookiesPath) {
      args.push('--cookies', cookiesPath);
    }
    if (this.proxy) {
      args.push('--proxy', this.proxy);
    }

    // A JS runtime is what lets yt-dlp solve YouTube's challenge; without one,
    // every client that needs it is skipped and only the degraded fallbacks
    // remain. Node ships in the image, so this is normally available.
    if (this.jsRuntime && this.jsRuntime !== 'none') {
      const spec = this.jsRuntimePath
        ? `${this.jsRuntime}:${this.jsRuntimePath}`
        : this.jsRuntime;
      args.push('--js-runtimes', spec);
    }
    if (this.remoteComponents) {
      args.push('--remote-components', this.remoteComponents);
    }

    // Operator-level extractor args always apply; request-level ones are added
    // later, per call, after validation.
    if (this.extractorArgs) {
      args.push('--extractor-args', this.extractorArgs);
    }

    if (this.concurrentFragments > 0) {
      args.push('--concurrent-fragments', String(this.concurrentFragments));
    }
    if (this.limitRate) {
      args.push('--limit-rate', this.limitRate);
    }
    // A pre-download ceiling: yt-dlp skips a format whose declared size is over
    // this, which avoids pulling gigabytes only to reject them afterwards. The
    // caller's byte cap is still enforced on the file that actually lands,
    // because this estimate is not always available or accurate.
    if (this.maxFilesize) {
      args.push('--max-filesize', this.maxFilesize);
    }

    // Douyin's web detail endpoint answers with an empty body unless the request
    // carries its own site as Referer — which surfaces as the misleading
    // "Fresh cookies are needed" error even with a perfectly good cookie jar.
    // Measured on 2026-09-29: identical request without the header returns 0 bytes
    // and fails; with it, 16 formats. Other platforms ignore the header, so it is
    // only sent where it matters.
    let host = '';
    try {
      host = new URL(String(url || '')).hostname;
    } catch {
      host = '';
    }
    if (isDouyinHost(host)) {
      args.push('--add-header', 'Referer: https://www.douyin.com/');
    }
    return args;
  }

  buildArgs(url, cookiesPath = '') {
    // "--" terminates option parsing so a hostile URL can never be read as a flag.
    return [
      ...this.buildCommonArgs(url, cookiesPath),
      '--dump-single-json',
      '--skip-download',
      '--flat-playlist',
      '--',
      url,
    ];
  }

  /**
   * Metadata for a URL. `playlistItems` and the impersonation target are the
   * only request-level options that affect extraction.
   */
  async resolve({ url, options: rawOptions = {} }) {
    if (!this.enabled) {
      throw new MediaResolveError('MEDIA_RESOLVE_DISABLED', '视频解析功能未启用。', {
        status: 503,
        detail: 'MEDIA_RESOLVE_ENABLED is off.',
      });
    }

    const parsed = await this.prepareTarget(url);
    const capabilities = await this.getCapabilities();
    const { options, warnings } = this.normalizeRequestOptions(rawOptions, capabilities);

    const probe = await this.probe();
    if (!probe.available) {
      throw new MediaResolveError('MEDIA_RESOLVE_UNAVAILABLE', '服务器未安装 yt-dlp，视频解析不可用。', {
        status: 503,
        detail: `yt-dlp is not runnable (${probe.reason || 'unknown'}) at ${probe.binaryPath}.`,
      });
    }

    this.assertPlaylistAllowed(parsed.href, options);
    if (!this.allowLive && options.live) {
      throw new MediaResolveError('MEDIA_RESOLVE_LIVE_DISABLED', '服务器未开启直播下载。', {
        status: 403,
        detail: 'MEDIA_RESOLVE_ALLOW_LIVE is off.',
      });
    }

    const cookiesPath = await this.materializeCookies(parsed.hostname);
    let stdout;
    try {
      await this.acquire();
      try {
        stdout = await this.runProcess(
          this.buildMetadataArgs(parsed.href, cookiesPath, options),
          this.timeoutMs
        );
      } finally {
        this.release();
      }
    } finally {
      await this.cleanupFile(cookiesPath);
    }

    let info;
    try {
      info = JSON.parse(stdout);
    } catch {
      throw new MediaResolveError('MEDIA_RESOLVE_BAD_PAYLOAD', '解析结果无法识别。', {
        status: 502,
        detail: 'yt-dlp did not emit valid JSON.',
      });
    }

    const entries = this.collectEntries(info);
    if (!entries.length) {
      throw new MediaResolveError('MEDIA_RESOLVE_EMPTY_RESULT', '没有解析到可用的视频。', {
        status: 422,
        detail: 'The response contained no video entries.',
      });
    }

    // A playlist result is reported as a list of selectable items; only the
    // first is fully normalised, because normalising the rest would mean
    // emitting format tables the caller has not asked to download.
    const isPlaylist = entries.length > 1 || entries[0] !== info;
    const items = [];
    for (let position = 0; position < entries.length && items.length < this.maxPlaylistItems; position += 1) {
      const entry = entries[position];
      if (!entry) continue;
      try {
        // Position within the returned list is the fallback for playlist_index:
        // a flat listing does not always carry one, and the UI needs a stable
        // number to show next to each entry.
        items.push(this.normalizeEntry(entry, {
          position: position + 1,
        }));
      } catch (error) {
        // A single unavailable item must not fail the whole playlist; record it
        // so the caller can show which entry was skipped.
        if (isPlaylist && error instanceof MediaResolveError) {
          warnings.push({
            code: error.code,
            message: `已跳过条目「${String(entry.title || entry.id || '').slice(0, 60)}」：${error.message}`,
          });
          continue;
        }
        throw error;
      }
    }

    if (!items.length) {
      throw new MediaResolveError('MEDIA_RESOLVE_EMPTY_RESULT', '没有解析到可用的视频。', {
        status: 422,
        detail: 'Every entry in the response was unusable.',
      });
    }

    const truncated = entries.length > this.maxPlaylistItems;
    if (truncated) {
      warnings.push({
        code: 'PLAYLIST_TRUNCATED',
        message: `该合集共 ${entries.length} 个条目，仅返回前 ${this.maxPlaylistItems} 个。`,
      });
    }

    // A direct URL gets fetched by the server later on, so it goes through the
    // same SSRF rules as any other remote import. Download-mode URLs never
    // leave the box — yt-dlp consumes them itself.
    for (const item of items) {
      if (!item.directUrl) continue;
      const safety = await assertSafeRemoteUrl(item.directUrl);
      if (!safety.ok) {
        throw new MediaResolveError(safety.code || 'MEDIA_RESOLVE_UNSAFE_URL', '解析出的地址不安全，已阻止。', {
          status: 403,
          detail: safety.message || 'The resolved media URL failed the SSRF check.',
        });
      }
    }

    return {
      source: {
        url: parsed.href,
        host: parsed.hostname.toLowerCase(),
      },
      playlist: {
        isPlaylist,
        totalEntries: entries.length,
        returned: items.length,
        truncated,
      },
      options: this.describeOptions(options),
      warnings,
      items,
    };
  }

  // Options carry a lot of internal state; the caller only needs to know what
  // was actually applied so it can reflect that in the UI.
  describeOptions(options) {
    return {
      preset: options.preset,
      audioOnly: options.audioOnly,
      container: resolveContainer(options),
      subtitles: options.subtitles,
      subtitleLangs: options.subtitleLangs,
      subtitleFormat: options.subtitleFormat,
      embedSubtitles: options.embedSubtitles,
      writeThumbnail: options.writeThumbnail,
      embedThumbnail: options.embedThumbnail,
      embedMetadata: options.embedMetadata,
      embedChapters: options.embedChapters,
      writeInfoJson: options.embedInfoJson,
      writeNfo: options.writeNfo,
      playlistItems: options.playlistItems,
      downloadSections: options.downloadSections,
      sponsorblockMark: options.sponsorblockMark,
      sponsorblockRemove: options.sponsorblockRemove,
      concurrentFragments: options.concurrentFragments,
      limitRate: options.limitRate,
      impersonate: options.impersonate,
      liveFromStart: options.liveFromStart,
    };
  }

  /**
   * Merges request options over the operator's defaults, then validates.
   *
   * The asymmetry is deliberate: an operator default that is ON cannot be turned
   * off by a request (the deployment has decided what it stores), but an
   * operator default that is OFF can be turned on (a one-off export).
   */
  normalizeRequestOptions(rawOptions, capabilities) {
    const merged = { ...rawOptions };

    if (this.defaultSubtitles && merged.subtitles === undefined) merged.subtitles = true;
    if (this.defaultSubtitles && merged.autoSubtitles === undefined) merged.autoSubtitles = true;
    if (this.defaultSubtitles && !merged.subtitleLangs) merged.subtitleLangs = this.defaultSubtitleLangs;
    if (this.defaultWriteThumbnail && merged.writeThumbnail === undefined) merged.writeThumbnail = true;
    if (this.defaultWriteInfoJson && merged.embedInfoJson === undefined) merged.embedInfoJson = true;
    if (this.defaultWriteNfo && merged.writeNfo === undefined) merged.writeNfo = true;
    if (this.defaultEmbedMetadata && merged.embedMetadata === undefined) merged.embedMetadata = true;
    if (this.defaultEmbedThumbnail && merged.embedThumbnail === undefined) merged.embedThumbnail = true;
    if (this.configuredImpersonate && !merged.impersonate && capabilities.impersonate) {
      merged.impersonate = this.configuredImpersonate;
    }

    return normalizeOptions(merged, {
      capabilities,
      limits: {
        maxConcurrentFragments: this.maxConcurrentFragments,
      },
    });
  }

  // yt-dlp will happily expand a channel URL into thousands of items. The
  // metadata pass uses --flat-playlist so expansion itself is cheap, but the
  // *download* is what costs, and that is the thing this guards.
  assertPlaylistAllowed(url, options) {
    if (!PLAYLIST_PATH_RE.test(String(url || '')) && !options.playlistItems) return;
    if (!this.allowPlaylists) {
      throw new MediaResolveError('MEDIA_RESOLVE_PLAYLIST_DISABLED', '服务器未开启合集/播放列表解析。', {
        status: 403,
        detail: 'MEDIA_RESOLVE_ALLOW_PLAYLISTS is off.',
      });
    }
  }

  // `--dump-single-json` on a playlist returns the collection with `entries`;
  // on a single video it returns the video itself. Both shapes are handled here
  // so the caller never has to know which it got.
  collectEntries(info) {
    if (!info || typeof info !== 'object') return [];
    if (Array.isArray(info.entries)) {
      return info.entries.filter((entry) => entry && typeof entry === 'object');
    }
    return [info];
  }

  buildMetadataArgs(url, cookiesPath, options) {
    const args = this.buildCommonArgs(url, cookiesPath);

    // Playlist selection is meaningful for metadata even though the download
    // path may refuse it later; without it the picker cannot show the item the
    // caller wants to choose.
    if (options.playlistItems) {
      args.push('--yes-playlist', '--playlist-items', options.playlistItems);
    }
    if (options.impersonate) {
      args.push('--impersonate', options.impersonate);
    }
    for (const value of options.extractorArgs) {
      args.push('--extractor-args', value);
    }

    args.push('--dump-single-json', '--skip-download', '--flat-playlist', '--', url);
    return args;
  }

  normalizeEntry(entry, { position = null } = {}) {
    const formats = (Array.isArray(entry.formats) ? entry.formats : [])
      .filter((format) => format && typeof format.url === 'string' && format.url);

    // A single-file format that already carries both streams can be imported
    // without ffmpeg. Most modern platforms only expose separate DASH streams,
    // so its absence is the normal case: those go through download() instead.
    const merged = formats.filter((format) => isStreamPresent(format.acodec) && isStreamPresent(format.vcodec));
    const direct = pickBestFormat(merged);
    const best = direct || pickBestFormat(formats);

    // `--flat-playlist` gives a playlist's entries without formats, which is the
    // cheap path the metadata pass uses. Such an entry is still useful: it has a
    // title and an id, and the caller can ask for it by index.
    const flat = !best;
    if (flat && !entry.id && !entry.url && !entry.webpage_url) {
      throw new MediaResolveError('MEDIA_RESOLVE_NO_FORMAT', '没有解析到可用的视频流。', {
        status: 422,
        detail: 'yt-dlp reported no downloadable formats for this URL.',
      });
    }

    const filesize = direct
      ? (toByteCount(direct.filesize) || toByteCount(direct.filesize_approx))
      : estimateTotalBytes(formats);

    if (!flat && this.maxFileSizeBytes > 0 && filesize > this.maxFileSizeBytes) {
      throw new MediaResolveError('MEDIA_RESOLVE_FILE_TOO_LARGE', '视频体积超过解析上限。', {
        status: 413,
        detail: `Resolved media is about ${filesize} bytes, above MEDIA_RESOLVE_MAX_FILE_SIZE.`,
      });
    }

    const duration = Number(entry.duration);
    if (this.maxDurationSeconds > 0 && Number.isFinite(duration) && duration > this.maxDurationSeconds) {
      throw new MediaResolveError('MEDIA_RESOLVE_DURATION_TOO_LONG', '视频时长超过解析上限。', {
        status: 413,
        detail: `Resolved media is ${duration}s long, above MEDIA_RESOLVE_MAX_DURATION_SECONDS.`,
      });
    }

    return {
      id: String(entry.id || ''),
      title: String(entry.title || '').slice(0, 300),
      uploader: String(entry.uploader || entry.channel || entry.creator || '').slice(0, 200),
      duration: Number.isFinite(duration) ? Math.round(duration) : 0,
      thumbnail: String(entry.thumbnail || ''),
      webpageUrl: String(entry.webpage_url || entry.url || ''),
      extractor: String(entry.extractor_key || entry.extractor || ''),
      formatId: best ? String(best.format_id || '') : '',
      ext: best ? String(best.ext || '') : '',
      filesize,
      width: best ? (Number(best.width) || 0) : 0,
      height: best ? (Number(best.height) || 0) : 0,
      vcodec: best ? String(best.vcodec || '') : '',
      acodec: best ? String(best.acodec || '') : '',
      // Empty when the platform only serves separate streams or the entry came
      // from a flat playlist listing; the caller then has to download().
      directUrl: direct ? String(direct.url) : '',
      directHeaders: direct && direct.http_headers && typeof direct.http_headers === 'object'
        ? direct.http_headers
        : null,
      requiresMerge: !direct,
      // True when this entry has no format table at all (flat playlist listing).
      flat,
      playlistIndex: Number.isFinite(Number(entry.playlist_index))
        ? Number(entry.playlist_index)
        : position,
      // Selectable resolutions, largest first. Hand one back as formatId to
      // download() to pin the quality instead of taking the largest stream.
      variants: buildVariants(formats),
      audioVariants: buildAudioVariants(formats),
      availableSubtitles: Object.keys(entry.subtitles || {}).slice(0, 32),
      availableAutoSubtitles: Object.keys(entry.automatic_captions || {}).slice(0, 32),
      chapters: Array.isArray(entry.chapters)
        ? entry.chapters.slice(0, 200).map((chapter) => ({
          title: String(chapter && chapter.title || '').slice(0, 200),
          startTime: Number(chapter && chapter.start_time) || 0,
          endTime: Number(chapter && chapter.end_time) || 0,
        }))
        : [],
      isLive: Boolean(entry.is_live),
      wasLive: Boolean(entry.was_live),
    };
  }

  /**
   * Downloads the media with yt-dlp, letting it mux separate tracks through
   * ffmpeg when they cannot be fetched as one file.
   *
   * Returns the primary artefact plus any sidecar files (subtitles, thumbnails,
   * NFO). The caller owns every returned path and must remove them.
   */
  async download({
    url,
    maxBytes = 0,
    timeoutMs = 0,
    options: rawOptions = {},
    onProgress = null,
    signal = null,
  }) {
    if (!this.enabled) {
      throw new MediaResolveError('MEDIA_RESOLVE_DISABLED', '视频解析功能未启用。', {
        status: 503,
        detail: 'MEDIA_RESOLVE_ENABLED is off.',
      });
    }

    const parsed = await this.prepareTarget(url);
    const capabilities = await this.getCapabilities();
    const { options, warnings } = this.normalizeRequestOptions(rawOptions, capabilities);

    const probe = await this.probe();
    if (!probe.available) {
      throw new MediaResolveError('MEDIA_RESOLVE_UNAVAILABLE', '服务器未安装 yt-dlp，视频解析不可用。', {
        status: 503,
        detail: `yt-dlp is not runnable (${probe.reason || 'unknown'}) at ${probe.binaryPath}.`,
      });
    }

    this.assertPlaylistAllowed(parsed.href, options);

    // Merging needs ffmpeg, and so does every postprocessor. The distinction
    // matters: without ffmpeg an audio-only run is still possible (the source
    // track is just copied), but a pinned video format that needs an audio
    // track merged is not.
    if (options.needsAudio && !capabilities.ffmpeg) {
      throw new MediaResolveError('MEDIA_RESOLVE_MERGE_UNAVAILABLE', '该视频需要合并音视频，但服务器缺少 ffmpeg。', {
        status: 503,
        detail: 'Install ffmpeg, or set MEDIA_RESOLVE_FFMPEG_PATH to its location.',
      });
    }

    if (options.live && !this.allowLive) {
      throw new MediaResolveError('MEDIA_RESOLVE_LIVE_DISABLED', '服务器未开启直播下载。', {
        status: 403,
        detail: 'MEDIA_RESOLVE_ALLOW_LIVE is off.',
      });
    }

    // Opportunistically reclaim files orphaned by earlier interrupted runs.
    void this.sweepTempDir();
    await fs.promises.mkdir(this.tempDir, { recursive: true });

    // Each download gets its own directory. That is what makes it possible to
    // enumerate exactly the files this run produced — yt-dlp's own idea of the
    // output path is not knowable in advance when postprocessors change the
    // container.
    const jobDir = path.join(
      this.tempDir,
      `${TEMP_FILE_PREFIX}${Date.now()}-${crypto.randomBytes(4).toString('hex')}`
    );
    await fs.promises.mkdir(jobDir, { recursive: true });

    const outputTemplate = path.join(jobDir, '%(id)s.%(ext)s');
    const cookiesPath = await this.materializeCookies(parsed.hostname);

    const progressArgs = (this.progressEnabled && typeof onProgress === 'function')
      ? buildProgressArgs({ ...options, progress: true })
      : [];

    const args = [
      ...this.buildCommonArgs(parsed.href, cookiesPath),
      ...progressArgs,
      ...buildDownloadArgs(options, {
        hasFfmpeg: capabilities.ffmpeg,
        outputTemplate,
      }),
      '--',
      parsed.href,
    ];

    await this.acquire();
    try {
      await this.runProcessWith(
        this.resolveBinaryPath(),
        args,
        Math.max(this.timeoutMs, Number(timeoutMs) || this.downloadTimeoutMs),
        { onStdoutLine: onProgress, signal }
      );

      const outputs = await this.collectOutputs(jobDir, maxBytes, options);

      if (!outputs.filePath) {
        throw new MediaResolveError('MEDIA_RESOLVE_DOWNLOAD_EMPTY', '下载未生成文件。', {
          status: 502,
          detail: 'yt-dlp finished without producing a media file.',
        });
      }

      return {
        ...outputs,
        warnings,
        options: this.describeOptions(options),
        capabilities,
      };
    } catch (error) {
      // Nothing survived the failure, so the whole directory goes.
      await this.removeDir(jobDir);
      throw error;
    } finally {
      this.release();
      await this.cleanupFile(cookiesPath);
    }
  }

  /**
   * Enumerates what a download produced.
   *
   * The primary file is the largest media artefact; everything else is a
   * sidecar. Sizes are checked here because a postprocessor can overshoot what
   * yt-dlp's own pre-download check allowed for.
   */
  async collectOutputs(jobDir, maxBytes, options) {
    const names = await fs.promises.readdir(jobDir).catch(() => []);
    const entries = [];

    for (const name of names) {
      // yt-dlp's in-progress marker; it is gone by the time the process exits
      // cleanly, so anything left is a failed download.
      if (name.endsWith('.part') || name.endsWith('.ytdl')) continue;
      const filePath = path.join(jobDir, name);
      try {
        const stats = await fs.promises.stat(filePath);
        if (!stats.isFile()) continue;
        entries.push({ name, path: filePath, size: stats.size });
      } catch {
        // Vanished between readdir and stat.
      }
    }

    const classified = classifyOutputFiles(entries);
    const primary = classified.primary;

    if (primary && primary.size === 0) {
      throw new MediaResolveError('MEDIA_RESOLVE_DOWNLOAD_EMPTY', '下载结果为空文件。', {
        status: 502,
        detail: 'The downloaded file has zero bytes.',
      });
    }

    // yt-dlp's --max-filesize is a pre-download estimate; this is the real
    // number for the file that actually landed.
    if (primary && maxBytes > 0 && primary.size > maxBytes) {
      throw new MediaResolveError('MEDIA_RESOLVE_FILE_TOO_LARGE', '视频超过大小限制。', {
        status: 413,
        detail: `Downloaded ${primary.size} bytes, above the ${maxBytes} byte limit.`,
      });
    }

    const sidecars = this.sidecarEnabled
      ? this.selectSidecars(classified, primary)
      : [];

    // Whether the audio and video tracks had to be muxed. An unpinned run asks
    // yt-dlp for "best video + best audio", which needs a merge on any DASH
    // platform; a pinned run only needs one when the chosen format carried no
    // audio of its own. An audio-only run never muxes at all.
    const needsMux = !options.audioOnly && (options.formatId ? options.needsAudio === true : true);

    return {
      filePath: primary ? primary.path : '',
      fileName: primary ? primary.name : '',
      bytes: primary ? primary.size : 0,
      container: primary ? path.extname(primary.name).replace('.', '').toLowerCase() : '',
      jobDir,
      sidecars,
      merged: Boolean(primary) && needsMux,
    };
  }

  // Subtitles and thumbnails are the two sidecars a media server can use; the
  // info JSON is only kept when it was asked for. All of them are size-checked
  // so a hostile or broken source cannot push an oversized file into storage.
  selectSidecars(classified, primary) {
    const out = [];
    const budget = this.maxSidecarFiles;

    const push = (entry, kind) => {
      if (!entry || out.length >= budget) return;
      if (this.maxSidecarBytes > 0 && entry.size > this.maxSidecarBytes) return;
      out.push({ path: entry.path, fileName: entry.name, bytes: entry.size, kind });
    };

    // Subtitles first: they are the sidecar a media server actually consumes.
    for (const entry of classified.subtitles) push(entry, 'subtitle');
    // A thumbnail matching the media's stem is the poster for that item; any
    // other image is a playlist-level artefact and is skipped.
    if (primary) {
      const stem = primary.name.replace(/\.[^.]+$/, '');
      for (const entry of classified.thumbnails) {
        const entryStem = entry.name.replace(/\.[^.]+$/, '');
        if (entryStem === stem) push(entry, 'thumbnail');
      }
    }
    for (const entry of classified.metadata) {
      const ext = path.extname(entry.name).replace('.', '').toLowerCase();
      if (ext === 'nfo') push(entry, 'nfo');
      else if (ext === 'json') push(entry, 'infojson');
    }

    return out;
  }

  /**
   * Writes an NFO for a downloaded item. Kept separate from the download so it
   * works for the direct-URL path too, where yt-dlp never ran for this item.
   */
  async writeNfo(jobDir, entry, mediaFileName, { episodeHint = null } = {}) {
    const xml = buildVideoNfo(entry, { episodeHint });
    const target = path.join(jobDir, nfoFileName(mediaFileName));
    await fs.promises.writeFile(target, xml, 'utf8');
    const stats = await fs.promises.stat(target);
    return { path: target, fileName: path.basename(target), bytes: stats.size, kind: 'nfo' };
  }

  async removeDir(dir) {
    if (!dir) return;
    try {
      await fs.promises.rm(dir, { recursive: true, force: true });
    } catch {
      // Best effort; the sweeper will get it.
    }
  }

  runProcess(args, timeoutMs, hooks = {}) {
    return this.runProcessWith(this.resolveBinaryPath(), args, timeoutMs, hooks);
  }

  /**
   * Runs a child process with bounded output.
   *
   * stderr is kept to a rolling tail rather than the first N bytes: yt-dlp
   * prints the actual failure reason last, so a naive "first 64KB" cap would
   * discard exactly the line the error classifier needs on a noisy run.
   */
  runProcessWith(binary, args, timeoutMs, { onStdoutLine = null, signal = null } = {}) {
    return new Promise((resolve, reject) => {
      let child;
      try {
        child = spawn(binary, args, {
          windowsHide: true,
          stdio: ['ignore', 'pipe', 'pipe'],
          env: buildChildEnv(this.proxy),
        });
      } catch (error) {
        reject(error);
        return;
      }

      const stdoutChunks = [];
      let stdoutBytes = 0;
      let stderrTail = '';
      let stdoutLineBuffer = '';
      let settled = false;

      const timer = setTimeout(() => {
        fail(new MediaResolveError('MEDIA_RESOLVE_TIMEOUT', '解析超时，请稍后重试。', {
          status: 504,
          detail: `yt-dlp did not finish within ${Math.round(timeoutMs / 1000)}s.`,
        }));
      }, timeoutMs);

      const onAbort = () => {
        fail(new MediaResolveError('MEDIA_RESOLVE_CANCELLED', '任务已取消。', {
          status: 499,
          detail: 'The job was cancelled.',
        }));
      };

      function cleanup() {
        clearTimeout(timer);
        if (signal && typeof signal.removeEventListener === 'function') {
          signal.removeEventListener('abort', onAbort);
        }
      }

      function fail(error) {
        if (settled) return;
        settled = true;
        cleanup();
        try { child.kill('SIGKILL'); } catch { /* already gone */ }
        reject(error);
      }

      if (signal) {
        if (signal.aborted) {
          // An already-aborted signal never fires its event, so this has to be
          // an explicit check rather than a listener.
          fail(new MediaResolveError('MEDIA_RESOLVE_CANCELLED', '任务已取消。', {
            status: 499,
            detail: 'The job was cancelled before the download started.',
          }));
          return;
        }
        signal.addEventListener('abort', onAbort, { once: true });
      }

      child.on('error', (error) => fail(error));

      child.stdout.on('data', (chunk) => {
        stdoutBytes += chunk.length;
        if (stdoutBytes > MAX_STDIO_BYTES) {
          fail(new MediaResolveError('MEDIA_RESOLVE_OUTPUT_TOO_LARGE', '解析结果过大。', {
            status: 502,
            detail: 'yt-dlp metadata exceeded the internal buffer limit.',
          }));
          return;
        }
        stdoutChunks.push(chunk);

        // Progress lines are consumed as they arrive; the rest is kept for the
        // JSON payload the metadata pass parses.
        if (!onStdoutLine) return;
        stdoutLineBuffer += chunk.toString('utf8');
        let newline = stdoutLineBuffer.indexOf('\n');
        while (newline !== -1) {
          const line = stdoutLineBuffer.slice(0, newline);
          stdoutLineBuffer = stdoutLineBuffer.slice(newline + 1);
          try {
            onStdoutLine(line);
          } catch {
            // A progress callback must never break the download.
          }
          newline = stdoutLineBuffer.indexOf('\n');
        }
        // Bound the buffer: a run that emits no newline at all would otherwise
        // grow this without limit.
        if (stdoutLineBuffer.length > MAX_STDERR_KEEP_BYTES) {
          stdoutLineBuffer = stdoutLineBuffer.slice(-MAX_STDERR_KEEP_BYTES);
        }
      });

      child.stderr.on('data', (chunk) => {
        stderrTail += chunk.toString('utf8');
        if (stderrTail.length > MAX_STDERR_KEEP_BYTES) {
          stderrTail = stderrTail.slice(-MAX_STDERR_KEEP_BYTES);
        }
      });

      child.on('close', (exitCode) => {
        if (settled) return;
        settled = true;
        cleanup();

        const stdout = Buffer.concat(stdoutChunks).toString('utf8');

        if (exitCode !== 0) {
          const failure = classifyFailure(stderrTail, exitCode, {
            cookiesConfigured: Boolean(this.cookiesFile) || this.cookiesByHost.size > 0,
          });
          // The classifier covers the common reasons; whatever falls through to
          // the generic code is exactly what an operator cannot diagnose from
          // "exited with code 1" alone, so keep the tail in the journal.
          if (failure.code === 'MEDIA_RESOLVE_FAILED') {
            console.warn(
              `media-resolve: unclassified yt-dlp failure (exit ${exitCode}): `
              + stderrTail.slice(-400).replace(/\s+/g, ' ').trim()
            );
          }
          reject(failure);
          return;
        }
        if (!stdout.trim() && !onStdoutLine) {
          reject(new MediaResolveError('MEDIA_RESOLVE_EMPTY_RESULT', '解析没有返回结果。', {
            status: 502,
            detail: 'yt-dlp produced no metadata.',
          }));
          return;
        }
        resolve(stdout);
      });
    });
  }

  /**
   * Runs a download detached from the request, reporting through the registry.
   *
   * This is the shape a client that cannot hold a connection open needs: start
   * returns an id immediately, progress is readable while it runs, and the
   * outcome is available afterwards.
   *
   * `store` is optional and is how the caller gets the download into a storage
   * backend: it is handed the download result and returns whatever should be
   * published as the job result. Without it the job result is the raw temp-file
   * description, which is only useful in-process. Either way the job directory
   * is removed once `store` has had its chance, so a detached download cannot
   * leave media behind in the temp dir.
   */
  startJob({ url, maxBytes = 0, timeoutMs = 0, options = {}, store = null }) {
    if (!this.jobRegistry) {
      throw new MediaResolveError('MEDIA_RESOLVE_JOBS_UNAVAILABLE', '后台任务未启用。', {
        status: 503,
        detail: 'No job registry is configured for this deployment.',
      });
    }

    return this.jobRegistry.start(
      {
        kind: 'media-resolve-download',
        url,
        timeoutMs: Math.max(this.timeoutMs, Number(timeoutMs) || this.downloadTimeoutMs),
      },
      async (job) => {
        job.setProgress({ stage: 'queued', percent: 0 });
        const download = await this.download({
          url,
          maxBytes,
          timeoutMs,
          options,
          signal: job.signal,
          onProgress: (line) => {
            const parsed = parseProgressLine(line);
            if (parsed) job.setProgress(parsed);
          },
        });

        job.setWarnings(download.warnings);

        try {
          if (typeof store === 'function') {
            job.setProgress({ stage: 'storing', percent: 100 });
            const stored = await store(download, job);
            job.setProgress({ stage: 'done', percent: 100 });
            return stored;
          }
          job.setProgress({ stage: 'done', percent: 100 });
          return {
            filePath: download.filePath,
            fileName: download.fileName,
            bytes: download.bytes,
            container: download.container,
            sidecars: download.sidecars.map((sidecar) => ({
              kind: sidecar.kind,
              fileName: sidecar.fileName,
              bytes: sidecar.bytes,
            })),
            merged: download.merged,
            options: download.options,
          };
        } finally {
          // The job owns its directory: whatever `store` needed has been read by
          // now, and leaving it behind would leak a full video per job.
          await this.removeDir(download.jobDir);
        }
      }
    );
  }

  // Reclaims temp files left behind by interrupted downloads (process killed,
  // OOM, restart). Throttled and strictly best-effort: it never throws, and it
  // skips files young enough to still belong to an in-flight download.
  // Returns the counts so the caller can surface permission problems instead of
  // letting them disappear into the catch.
  async sweepTempDir({ force = false } = {}) {
    const now = Date.now();
    if (!force && now - this.lastSweepAt < SWEEP_INTERVAL_MS) {
      return { removed: 0, failed: 0, skipped: true };
    }
    this.lastSweepAt = now;

    let entries;
    try {
      entries = await fs.promises.readdir(this.tempDir);
    } catch {
      return { removed: 0, failed: 0, skipped: false }; // Never created, or gone.
    }

    let removed = 0;
    let failed = 0;
    for (const name of entries) {
      if (!name.startsWith(TEMP_FILE_PREFIX)) continue;
      const target = path.join(this.tempDir, name);
      try {
        const stats = await fs.promises.stat(target);
        if (now - stats.mtimeMs < SWEEP_MIN_AGE_MS) continue;
        // Job directories are swept recursively; cookie copies are plain files.
        await fs.promises.rm(target, { recursive: stats.isDirectory(), force: true });
        removed += 1;
      } catch {
        failed += 1;
      }
    }
    return { removed, failed, skipped: false };
  }

  // Temp files belong to the caller; this keeps the unlink best-effort so a
  // missing file never masks the original error.
  async cleanupFile(filePath) {
    if (!filePath) return;
    try {
      await fs.promises.unlink(filePath);
    } catch {
      // Already gone, or never created.
    }
  }
}

module.exports = {
  MediaResolveService,
  MediaResolveError,
  YtdlpOptionError,
  DEFAULT_ALLOWED_HOSTS,
  PRESETS,
  DEFAULT_PRESET,
  PROGRESS_PREFIX,
  parseProgressLine,
  classifyFailure,
  isPrivateOrLocalHost,
};
