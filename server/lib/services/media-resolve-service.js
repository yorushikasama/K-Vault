/**
 * Media resolution via yt-dlp — Docker/self-hosted runtime only.
 *
 * The Cloudflare Pages runtime has no child_process, so this service exists
 * solely on the Hono/Node side. It shells out to the yt-dlp binary in
 * "metadata only" mode and returns the direct media URLs the platform's own
 * CDN serves, which the upload pipeline can then import without ffmpeg.
 *
 * Design notes:
 * - The host allow-list is the security boundary. Without it a public
 *   deployment would be a general-purpose request forwarder; with it, only
 *   recognised video platforms can be resolved.
 * - Only formats that already carry both audio and video are offered as
 *   direct downloads. Merging separate DASH streams needs ffmpeg, which
 *   K-Vault deliberately does not require.
 * - Everything the child process emits is bounded: stdout, stderr and wall
 *   clock all have caps, so a hostile URL cannot exhaust the process.
 */

const { spawn } = require('node:child_process');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { assertSafeRemoteUrl } = require('../utils/ssrf-guard');
const { createSemaphore } = require('../utils/semaphore');

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

const MAX_STDIO_BYTES = 8 * 1024 * 1024;
const PROBE_TIMEOUT_MS = 5000;
const PROBE_OK_TTL_MS = 5 * 60 * 1000;
const PROBE_FAIL_TTL_MS = 15 * 1000;
const QUEUE_LIMIT_FACTOR = 4;
// Temp-file housekeeping. A download that is killed mid-flight (OOM, restart)
// never reaches its own cleanup, so orphans get swept opportunistically.
const SWEEP_INTERVAL_MS = 30 * 60 * 1000;
const SWEEP_MIN_AGE_MS = 2 * 60 * 60 * 1000;
const TEMP_FILE_PREFIX = 'kv-resolve-';

// Timeouts, capacity pressure and a missing binary can all be fixed by
// retrying later; everything else is a property of the request itself.
const RETRIABLE_CODES = new Set([
  'MEDIA_RESOLVE_TIMEOUT',
  'MEDIA_RESOLVE_BUSY',
  'MEDIA_RESOLVE_UNAVAILABLE',
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

function firstEntry(info) {
  if (!info || typeof info !== 'object') return null;
  if (Array.isArray(info.entries) && info.entries.length) {
    return info.entries.find((entry) => entry && typeof entry === 'object') || null;
  }
  return info;
}

// yt-dlp's stderr is the only place the actual reason lives; map the common
// ones onto codes the caller can act on instead of a generic failure.
function classifyFailure(stderr, exitCode) {
  const text = String(stderr || '').toLowerCase();

  if (text.includes('unsupported url')) {
    return new MediaResolveError('MEDIA_RESOLVE_UNSUPPORTED_SITE', '该链接暂不受支持的站点。', {
      status: 422,
      detail: 'yt-dlp reported an unsupported URL.',
    });
  }
  if (text.includes('sign in') || text.includes('login required') || text.includes('cookies')) {
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
  if (text.includes('timed out') || text.includes('timeout') || text.includes('read operation timed out')) {
    return new MediaResolveError('MEDIA_RESOLVE_TIMEOUT', '解析超时，请稍后重试。', {
      status: 504,
      detail: 'The platform did not respond in time.',
    });
  }

  return new MediaResolveError('MEDIA_RESOLVE_FAILED', '解析失败。', {
    status: 502,
    detail: `yt-dlp exited with code ${exitCode}.`,
  });
}

class MediaResolveService {
  constructor({ config }) {
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
    this.proxy = String(settings.proxy || '').trim();
    this.allowUnknownHosts = settings.allowUnknownHosts === true;
    this.allowedHosts = buildAllowedHosts(settings.extraHosts);
    this.userAgent = String(settings.userAgent || '').trim() || 'yt-dlp';
    this.ffmpegPath = String(settings.ffmpegPath || '').trim() || 'ffmpeg';
    // Downloads land here before being handed to the storage layer; the caller
    // removes each file in a finally block.
    this.tempDir = String(settings.tempDir || '').trim() || path.join(os.tmpdir(), 'k-vault-resolve');

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
    this.lastSweepAt = 0;
  }

  resolveBinaryPath() {
    return this.configuredBinaryPath || 'yt-dlp';
  }

  isHostAllowed(hostname) {
    if (this.allowUnknownHosts) return true;
    return hostMatches(hostname, this.allowedHosts);
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

  // ffmpeg is what turns separate video/audio tracks into one file. Without it
  // the service still works, it just cannot handle DASH-only platforms.
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

  async getStatus() {
    const probe = await this.probe();
    const ffmpeg = this.enabled ? await this.probeFfmpeg() : { available: false, version: '' };
    return {
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
      cookiesConfigured: Boolean(this.cookiesFile),
      proxyConfigured: Boolean(this.proxy),
      allowUnknownHosts: this.allowUnknownHosts,
      allowedHosts: this.allowUnknownHosts ? [] : Array.from(this.allowedHosts).sort(),
    };
  }

  acquire() {
    return this.gate.acquire();
  }

  release() {
    this.gate.release();
  }

  buildCommonArgs(url) {
    const args = [
      // Respect the ?p= / ?v= selector in the URL instead of expanding a
      // channel or collection into every item.
      '--no-playlist',
      '--no-warnings',
      '--no-progress',
      '--no-config',
      '--no-exec',
      '--socket-timeout',
      '20',
      '--retries',
      '2',
    ];

    // Bilibili answers 412 to any "Mozilla/..." UA that lacks a browser-grade
    // signature but accepts an API-style one, so the default stays non-browser.
    if (this.userAgent) {
      args.push('--user-agent', this.userAgent);
    }
    if (this.cookiesFile && fs.existsSync(this.cookiesFile)) {
      args.push('--cookies', this.cookiesFile);
    }
    if (this.proxy) {
      args.push('--proxy', this.proxy);
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
    if (/(^|\.)douyin\.com$/.test(host) || /(^|\.)iesdouyin\.com$/.test(host)) {
      args.push('--add-header', 'Referer: https://www.douyin.com/');
    }
    return args;
  }

  buildArgs(url) {
    // "--" terminates option parsing so a hostile URL can never be read as a flag.
    return [...this.buildCommonArgs(url), '--dump-single-json', '--skip-download', '--', url];
  }

  buildDownloadArgs(url, destination, hasFfmpeg, formatSelector) {
    const args = this.buildCommonArgs(url);
    // An explicit selector comes from the quality picker; otherwise ask for the
    // best video plus the best audio and let yt-dlp mux them (needs ffmpeg).
    // Without ffmpeg only a single-file format can be used at all.
    let selector = formatSelector;
    if (!selector) {
      selector = hasFfmpeg ? 'bv*+ba/b' : 'b';
    }
    args.push('-f', selector);
    if (hasFfmpeg) {
      args.push('--merge-output-format', 'mp4');
    }
    args.push('-o', destination, '--', url);
    return args;
  }

  runProcess(args, timeoutMs) {
    return this.runProcessWith(this.resolveBinaryPath(), args, timeoutMs);
  }

  runProcessWith(binary, args, timeoutMs) {
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
      const stderrChunks = [];
      let stdoutBytes = 0;
      let stderrBytes = 0;
      let settled = false;

      const timer = setTimeout(() => {
        fail(new MediaResolveError('MEDIA_RESOLVE_TIMEOUT', '解析超时，请稍后重试。', {
          status: 504,
          detail: `yt-dlp did not finish within ${Math.round(timeoutMs / 1000)}s.`,
        }));
      }, timeoutMs);

      function cleanup() {
        clearTimeout(timer);
      }

      function fail(error) {
        if (settled) return;
        settled = true;
        cleanup();
        try { child.kill('SIGKILL'); } catch { /* already gone */ }
        reject(error);
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
      });

      child.stderr.on('data', (chunk) => {
        stderrBytes += chunk.length;
        if (stderrBytes <= MAX_STDIO_BYTES) stderrChunks.push(chunk);
      });

      child.on('close', (exitCode) => {
        if (settled) return;
        settled = true;
        cleanup();

        const stdout = Buffer.concat(stdoutChunks).toString('utf8');
        const stderr = Buffer.concat(stderrChunks).toString('utf8');

        if (exitCode !== 0) {
          reject(classifyFailure(stderr, exitCode));
          return;
        }
        if (!stdout.trim()) {
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

  normalizeEntry(entry) {
    const formats = (Array.isArray(entry.formats) ? entry.formats : [])
      .filter((format) => format && typeof format.url === 'string' && format.url);

    // A single-file format that already carries both streams can be imported
    // without ffmpeg. Most modern platforms only expose separate DASH streams,
    // so its absence is the normal case: those go through download() instead.
    const merged = formats.filter((format) => isStreamPresent(format.acodec) && isStreamPresent(format.vcodec));
    const direct = pickBestFormat(merged);
    const best = direct || pickBestFormat(formats);

    if (!best) {
      throw new MediaResolveError('MEDIA_RESOLVE_NO_FORMAT', '没有解析到可用的视频流。', {
        status: 422,
        detail: 'yt-dlp reported no downloadable formats for this URL.',
      });
    }

    const filesize = direct
      ? (toByteCount(direct.filesize) || toByteCount(direct.filesize_approx))
      : estimateTotalBytes(formats);

    if (this.maxFileSizeBytes > 0 && filesize > this.maxFileSizeBytes) {
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
      webpageUrl: String(entry.webpage_url || ''),
      extractor: String(entry.extractor_key || entry.extractor || ''),
      formatId: String(best.format_id || ''),
      ext: String((direct || best).ext || ''),
      filesize,
      width: Number(best.width) || 0,
      height: Number(best.height) || 0,
      vcodec: String(best.vcodec || ''),
      acodec: String(best.acodec || ''),
      // Empty when the platform only serves separate streams; the caller then
      // has to download() and let yt-dlp mux the tracks.
      directUrl: direct ? String(direct.url) : '',
      directHeaders: direct && direct.http_headers && typeof direct.http_headers === 'object'
        ? direct.http_headers
        : null,
      requiresMerge: !direct,
      // Selectable resolutions, largest first. Hand one back as formatId to
      // download() to pin the quality instead of taking the largest stream.
      variants: buildVariants(formats),
    };
  }

  async resolve({ url }) {
    if (!this.enabled) {
      throw new MediaResolveError('MEDIA_RESOLVE_DISABLED', '视频解析功能未启用。', {
        status: 503,
        detail: 'MEDIA_RESOLVE_ENABLED is off.',
      });
    }

    const parsed = this.assertUrlAllowed(url);

    const probe = await this.probe();
    if (!probe.available) {
      throw new MediaResolveError('MEDIA_RESOLVE_UNAVAILABLE', '服务器未安装 yt-dlp，视频解析不可用。', {
        status: 503,
        detail: `yt-dlp is not runnable (${probe.reason || 'unknown'}) at ${probe.binaryPath}.`,
      });
    }

    await this.acquire();
    let stdout;
    try {
      stdout = await this.runProcess(this.buildArgs(parsed.href), this.timeoutMs);
    } finally {
      this.release();
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

    const entry = firstEntry(info);
    if (!entry) {
      throw new MediaResolveError('MEDIA_RESOLVE_EMPTY_RESULT', '没有解析到可用的视频。', {
        status: 422,
        detail: 'The response contained no video entries.',
      });
    }

    const item = this.normalizeEntry(entry);

    // A direct URL gets fetched by the server later on, so it goes through the
    // same SSRF rules as any other remote import. Download-mode URLs never
    // leave the box — yt-dlp consumes them itself.
    if (item.directUrl) {
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
      items: [item],
    };
  }

  // Downloads the media with yt-dlp, letting it mux separate tracks through
  // ffmpeg when they cannot be fetched as one file. The caller owns the
  // returned path and must remove it once it has been stored.
  async download({ url, maxBytes = 0, timeoutMs = 0, requireMerge = false, formatId = '', needsAudio = false }) {
    if (!this.enabled) {
      throw new MediaResolveError('MEDIA_RESOLVE_DISABLED', '视频解析功能未启用。', {
        status: 503,
        detail: 'MEDIA_RESOLVE_ENABLED is off.',
      });
    }

    const parsed = this.assertUrlAllowed(url);

    const probe = await this.probe();
    if (!probe.available) {
      throw new MediaResolveError('MEDIA_RESOLVE_UNAVAILABLE', '服务器未安装 yt-dlp，视频解析不可用。', {
        status: 503,
        detail: `yt-dlp is not runnable (${probe.reason || 'unknown'}) at ${probe.binaryPath}.`,
      });
    }

    const ffmpeg = await this.probeFfmpeg();
    if (requireMerge && !ffmpeg.available) {
      throw new MediaResolveError('MEDIA_RESOLVE_MERGE_UNAVAILABLE', '该视频需要合并音视频，但服务器缺少 ffmpeg。', {
        status: 503,
        detail: 'Install ffmpeg, or set MEDIA_RESOLVE_FFMPEG_PATH to its location.',
      });
    }

    // The format id comes back from the client, so it is validated before it
    // can ever reach the command line.
    let formatSelector = '';
    if (formatId) {
      if (!/^[A-Za-z0-9._+-]{1,64}$/.test(String(formatId))) {
        throw new MediaResolveError('MEDIA_RESOLVE_BAD_FORMAT', '指定的清晰度无效。', {
          status: 400,
          detail: 'formatId contains characters yt-dlp would not accept.',
        });
      }
      formatSelector = needsAudio ? `${formatId}+ba` : String(formatId);
    }

    // Opportunistically reclaim files orphaned by earlier interrupted runs.
    void this.sweepTempDir();

    await fs.promises.mkdir(this.tempDir, { recursive: true });

    const destination = path.join(
      this.tempDir,
      `kv-resolve-${Date.now()}-${crypto.randomBytes(4).toString('hex')}.mp4`
    );

    await this.acquire();
    try {
      await this.runProcessWith(
        this.resolveBinaryPath(),
        this.buildDownloadArgs(parsed.href, destination, ffmpeg.available, formatSelector),
        Math.max(this.timeoutMs, Number(timeoutMs) || this.downloadTimeoutMs)
      );

      let stats;
      try {
        stats = await fs.promises.stat(destination);
      } catch {
        throw new MediaResolveError('MEDIA_RESOLVE_DOWNLOAD_EMPTY', '下载未生成文件。', {
          status: 502,
          detail: 'yt-dlp finished without producing an output file.',
        });
      }

      if (stats.size === 0) {
        await this.cleanupFile(destination);
        throw new MediaResolveError('MEDIA_RESOLVE_DOWNLOAD_EMPTY', '下载结果为空文件。', {
          status: 502,
          detail: 'The downloaded file has zero bytes.',
        });
      }

      if (maxBytes > 0 && stats.size > maxBytes) {
        await this.cleanupFile(destination);
        throw new MediaResolveError('MEDIA_RESOLVE_FILE_TOO_LARGE', '视频超过大小限制。', {
          status: 413,
          detail: `Downloaded ${stats.size} bytes, above the ${maxBytes} byte limit.`,
        });
      }

      return {
        filePath: destination,
        fileName: path.basename(destination),
        bytes: stats.size,
        merged: ffmpeg.available,
      };
    } catch (error) {
      await this.cleanupFile(destination);
      throw error;
    } finally {
      this.release();
    }
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
        if (!stats.isFile()) continue;
        if (now - stats.mtimeMs < SWEEP_MIN_AGE_MS) continue;
        await fs.promises.unlink(target);
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
  DEFAULT_ALLOWED_HOSTS,
};
