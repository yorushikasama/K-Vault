const path = require('node:path');

function toBool(value, defaultValue = false) {
  if (value == null || value === '') return defaultValue;
  const normalized = String(value).trim().toLowerCase();
  if (['1', 'true', 'yes', 'on', 'enabled'].includes(normalized)) return true;
  if (['0', 'false', 'no', 'off', 'disabled'].includes(normalized)) return false;
  return defaultValue;
}

function toInt(value, fallback) {
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function resolveDataPath(...parts) {
  return path.resolve(process.cwd(), ...parts);
}

function stripWrappingQuotes(value) {
  const text = String(value == null ? '' : value).trim();
  if (!text) return '';
  if (
    (text.startsWith('"') && text.endsWith('"'))
    || (text.startsWith("'") && text.endsWith("'"))
  ) {
    return text.slice(1, -1).trim();
  }
  return text;
}

function normalizeEnvString(value, fallback = '') {
  const normalized = stripWrappingQuotes(value);
  return normalized || fallback;
}

function pickEnvAlias(env, aliases = [], fallback = '') {
  for (const alias of aliases) {
    const value = env[alias];
    const normalized = normalizeEnvString(value);
    if (normalized) {
      return { value: normalized, source: alias };
    }
  }
  return { value: normalizeEnvString(fallback), source: '' };
}

// Remote imports (parsed media, /api/upload-from-url) buffer the whole body in
// memory before the size check runs, so the natural ceiling is the deployment's
// own capacity knob: UPLOAD_MAX_SIZE. UPLOAD_SMALL_FILE_THRESHOLD only picks the
// direct-vs-chunked transport and says nothing about what the server can hold,
// so it is deliberately not used here. The effective cap can still end up lower,
// because the target storage backend is applied on top of it (Telegram cloud
// 50MB, Discord 25MB, ...). Set URL_IMPORT_MAX_SIZE to pin it explicitly.
function resolveUrlImportMaxSize(env) {
  const explicit = toInt(env.URL_IMPORT_MAX_SIZE, 0);
  if (explicit > 0) return explicit;
  return toInt(env.UPLOAD_MAX_SIZE, 100 * 1024 * 1024);
}

// The cloud Bot API only accepts 50MB uploads; a self-hosted server running
// with --local accepts up to 2000MB. TELEGRAM_MAX_UPLOAD_SIZE overrides both.
function resolveTelegramMaxUploadSize(env, apiBase) {
  const explicit = toInt(env.TELEGRAM_MAX_UPLOAD_SIZE, 0);
  if (explicit > 0) return explicit;

  let isLocal = false;
  try {
    const { hostname } = new URL(String(apiBase || ''));
    isLocal = hostname === 'localhost' || hostname.startsWith('127.') || hostname === '[::1]' || hostname === '::1';
  } catch {
    isLocal = false;
  }

  return isLocal ? 2000 * 1024 * 1024 : 50 * 1024 * 1024;
}

// Storage backends that must see the entire file in memory (HuggingFace and
// GitHub both want it base64-encoded inside a JSON body) cannot follow a raised
// UPLOAD_MAX_SIZE without becoming an OOM risk. 100MB is today's de facto limit,
// so it stays the default until an operator opts out explicitly.
function resolveBufferedBackendMaxSize(env) {
  const explicit = toInt(env.BUFFERED_BACKEND_MAX_SIZE, 0);
  if (explicit > 0) return explicit;
  return Math.min(toInt(env.UPLOAD_MAX_SIZE, 100 * 1024 * 1024), 100 * 1024 * 1024);
}

function loadConfig(env = process.env) {
  const dataDir = env.DATA_DIR
    ? path.resolve(normalizeEnvString(env.DATA_DIR))
    : resolveDataPath('data');
  const telegramToken = pickEnvAlias(env, ['TG_BOT_TOKEN', 'TG_Bot_Token']);
  const telegramChatId = pickEnvAlias(env, ['TG_CHAT_ID', 'TG_Chat_ID']);
  const telegramApiBase = pickEnvAlias(env, ['CUSTOM_BOT_API_URL'], 'https://api.telegram.org');
  const huggingFaceToken = pickEnvAlias(env, ['HF_TOKEN', 'HUGGINGFACE_TOKEN', 'HF_API_TOKEN']);
  const huggingFaceRepo = pickEnvAlias(env, ['HF_REPO', 'HUGGINGFACE_REPO', 'HF_DATASET_REPO']);
  const githubToken = pickEnvAlias(env, ['GITHUB_TOKEN', 'GH_TOKEN', 'GITHUB_PAT']);
  const githubRepo = pickEnvAlias(env, ['GITHUB_REPO', 'GH_REPO', 'GITHUB_REPOSITORY']);

  return {
    port: toInt(env.PORT, 8787),
    nodeEnv: normalizeEnvString(env.NODE_ENV, 'development'),
    publicBaseUrl: normalizeEnvString(env.PUBLIC_BASE_URL),

    basicUser: normalizeEnvString(env.BASIC_USER),
    basicPass: normalizeEnvString(env.BASIC_PASS),
    sessionCookieName: normalizeEnvString(env.SESSION_COOKIE_NAME, 'k_vault_session'),
    sessionDurationMs: toInt(env.SESSION_DURATION_MS, 24 * 60 * 60 * 1000),

    guestUploadEnabled: toBool(env.GUEST_UPLOAD, false),
    guestMaxFileSize: toInt(env.GUEST_MAX_FILE_SIZE, 5 * 1024 * 1024),
    guestDailyLimit: toInt(env.GUEST_DAILY_LIMIT, 10),

    uploadMaxSize: toInt(env.UPLOAD_MAX_SIZE, 100 * 1024 * 1024),
    uploadSmallFileThreshold: toInt(env.UPLOAD_SMALL_FILE_THRESHOLD, 20 * 1024 * 1024),
    chunkSize: toInt(env.CHUNK_SIZE, 5 * 1024 * 1024),
    urlImportMaxSize: resolveUrlImportMaxSize(env),
    // Upload bodies are buffered whole, so one upload at a time is what keeps the
    // peak at one upload's cost. Two concurrent 100MB uploads sit at roughly 830MB
    // against a 896MB MemoryMax, which is an OOM kill waiting to happen.
    uploadMaxConcurrency: toInt(env.UPLOAD_MAX_CONCURRENCY, 2),
    // Ceiling for storage backends that can only accept a whole in-memory file.
    // Defaults to 100MB so nothing regresses today, and so that raising
    // UPLOAD_MAX_SIZE later cannot silently turn those backends into an OOM risk.
    bufferedBackendMaxSize: resolveBufferedBackendMaxSize(env),
    // Unknown-length remote bodies get staged here before the streaming upload.
    // Defaults to the media-resolve temp dir (already volume-backed and swept) so
    // the file never lands in the service's private /tmp.
    uploadTempDir: String(env.UPLOAD_TEMP_DIR || env.MEDIA_RESOLVE_TEMP_DIR || '').trim(),

    configEncryptionKey: normalizeEnvString(env.CONFIG_ENCRYPTION_KEY) || normalizeEnvString(env.FILE_URL_SECRET) || normalizeEnvString(env.SESSION_SECRET) || '',
    sessionSecret: normalizeEnvString(env.SESSION_SECRET) || normalizeEnvString(env.FILE_URL_SECRET) || normalizeEnvString(env.CONFIG_ENCRYPTION_KEY) || '',

    dataDir,
    dbPath: env.DB_PATH ? path.resolve(normalizeEnvString(env.DB_PATH)) : path.join(dataDir, 'k-vault.db'),
    chunkDir: env.CHUNK_DIR ? path.resolve(normalizeEnvString(env.CHUNK_DIR)) : path.join(dataDir, 'chunks'),
    settingsStore: normalizeEnvString(env.SETTINGS_STORE, 'sqlite').toLowerCase(),
    settingsRedisUrl: normalizeEnvString(env.SETTINGS_REDIS_URL) || normalizeEnvString(env.REDIS_URL) || '',
    settingsRedisPrefix: normalizeEnvString(env.SETTINGS_REDIS_PREFIX, 'k-vault'),
    settingsRedisConnectTimeoutMs: toInt(env.SETTINGS_REDIS_CONNECT_TIMEOUT_MS, 5000),

    telegramApiBase: telegramApiBase.value,
    telegramMaxUploadSize: resolveTelegramMaxUploadSize(env, telegramApiBase.value),

    // Optional media resolution via yt-dlp. Exclusive to the Docker/self-hosted
    // (Hono/Node) runtime: Cloudflare Pages Functions has no child_process, so
    // the Pages deployment simply never exposes these endpoints.
    mediaResolve: {
      enabled: toBool(env.MEDIA_RESOLVE_ENABLED, true),
      binaryPath: normalizeEnvString(env.MEDIA_RESOLVE_YTDLP_PATH),
      ffmpegPath: normalizeEnvString(env.MEDIA_RESOLVE_FFMPEG_PATH),
      // Bilibili rejects any "Mozilla/..." UA that lacks a browser-grade
      // signature, so the default must not look like a browser.
      userAgent: normalizeEnvString(env.MEDIA_RESOLVE_USER_AGENT, 'yt-dlp'),
      timeoutMs: toInt(env.MEDIA_RESOLVE_TIMEOUT_MS, 60000),
      downloadTimeoutMs: toInt(env.MEDIA_RESOLVE_DOWNLOAD_TIMEOUT_MS, 600000),
      maxConcurrency: toInt(env.MEDIA_RESOLVE_MAX_CONCURRENCY, 2),
      maxDurationSeconds: toInt(env.MEDIA_RESOLVE_MAX_DURATION_SECONDS, 0),
      maxFileSizeBytes: toInt(env.MEDIA_RESOLVE_MAX_FILE_SIZE, 0),
      maxUrlLength: toInt(env.MEDIA_RESOLVE_MAX_URL_LENGTH, 2048),
      // Land temp downloads under DATA_DIR by default: the systemd unit ships
      // PrivateTmp=true, which turns the service's /tmp into a private mount
      // that the host can neither see nor clean, and DATA_DIR is already
      // writable (and usually a volume) on both Docker and bare-metal setups.
      tempDir: normalizeEnvString(env.MEDIA_RESOLVE_TEMP_DIR) || path.join(dataDir, 'tmp'),
      cookiesFile: normalizeEnvString(env.MEDIA_RESOLVE_COOKIES_FILE),
      proxy: normalizeEnvString(env.MEDIA_RESOLVE_PROXY),
      allowUnknownHosts: toBool(env.MEDIA_RESOLVE_ALLOW_UNKNOWN_HOSTS, false),
      extraHosts: normalizeEnvString(env.MEDIA_RESOLVE_EXTRA_HOSTS),

      // --- Capability-related (added with the option surface) ---------------

      // YouTube has required an external JS runtime for full support since
      // yt-dlp 2025.11.12, and only deno is enabled upstream by default. The
      // image is node-based, so node is what we point at unless told otherwise.
      // "none" disables the flag entirely (e.g. a host with no JS runtime).
      jsRuntime: normalizeEnvString(env.MEDIA_RESOLVE_JS_RUNTIME, 'node'),
      // Path to the runtime when it is not on PATH.
      jsRuntimePath: normalizeEnvString(env.MEDIA_RESOLVE_JS_RUNTIME_PATH),
      // Allow yt-dlp to fetch the EJS challenge-solver components. Official
      // builds bundle them, so this only matters for source installs.
      remoteComponents: normalizeEnvString(env.MEDIA_RESOLVE_REMOTE_COMPONENTS),

      // Retry/backoff. The 403s that YouTube and TikTok emit are transient far
      // more often than they are permanent, and the default of 10 retries with
      // no extractor retries is too thin for a server.
      extractorRetries: toInt(env.MEDIA_RESOLVE_EXTRACTOR_RETRIES, 3),
      fragmentRetries: toInt(env.MEDIA_RESOLVE_FRAGMENT_RETRIES, 10),
      // yt-dlp's own syntax, e.g. "http:exp=1:20" or "fragment:5".
      retrySleep: normalizeEnvString(env.MEDIA_RESOLVE_RETRY_SLEEP, 'http:exp=1:20'),
      // Seconds. Caps how long a single retry may back off.
      socketTimeout: toInt(env.MEDIA_RESOLVE_SOCKET_TIMEOUT, 20),
      // Concurrent DASH/HLS fragments per download. This is the supported way
      // to speed up a segmented download; aria2c for HLS/DASH was removed in
      // 2026.06.09 over CVE-2026-50574.
      concurrentFragments: toInt(env.MEDIA_RESOLVE_CONCURRENT_FRAGMENTS, 4),
      maxConcurrentFragments: toInt(env.MEDIA_RESOLVE_MAX_CONCURRENT_FRAGMENTS, 16),
      // Optional global download rate cap, yt-dlp syntax ("4.2M").
      limitRate: normalizeEnvString(env.MEDIA_RESOLVE_LIMIT_RATE),
      // Ceiling on one downloaded file, enforced by yt-dlp before writing.
      maxFilesize: normalizeEnvString(env.MEDIA_RESOLVE_MAX_FILESIZE),

      // Operator-supplied extractor arguments, always applied. This is trusted
      // input, so it is the only place keys like player_client or api_hostname
      // can be set — the request-level field refuses them.
      extractorArgs: normalizeEnvString(env.MEDIA_RESOLVE_EXTRACTOR_ARGS),
      // Default impersonation target, e.g. "chrome" or "chrome:windows-10".
      // Needs curl_cffi in the yt-dlp build; the status endpoint reports
      // whether the configured target is actually available.
      impersonate: normalizeEnvString(env.MEDIA_RESOLVE_IMPERSONATE),

      // Media enrichment defaults. Off by default because they change the
      // bytes that land in storage; operators who want a Jellyfin-shaped
      // library turn them on once.
      writeSubtitles: toBool(env.MEDIA_RESOLVE_WRITE_SUBTITLES, false),
      subtitleLangs: normalizeEnvString(env.MEDIA_RESOLVE_SUBTITLE_LANGS, 'zh.*,en'),
      writeThumbnail: toBool(env.MEDIA_RESOLVE_WRITE_THUMBNAIL, false),
      writeInfoJson: toBool(env.MEDIA_RESOLVE_WRITE_INFO_JSON, false),
      writeNfo: toBool(env.MEDIA_RESOLVE_WRITE_NFO, false),
      embedMetadata: toBool(env.MEDIA_RESOLVE_EMBED_METADATA, false),
      embedThumbnail: toBool(env.MEDIA_RESOLVE_EMBED_THUMBNAIL, false),

      // --- Limits on the new surface ---------------------------------------
      // Sidecar files (subtitles, thumbnails, NFO) are uploaded alongside the
      // media when the target backend can take them.
      sidecarEnabled: toBool(env.MEDIA_RESOLVE_SIDECAR_ENABLED, true),
      // Cap on the number of files a single resolve may emit, which is also
      // the guard against a "playlist" URL quietly turning into 500 uploads.
      maxSidecarFiles: toInt(env.MEDIA_RESOLVE_MAX_SIDECAR_FILES, 12),
      maxSidecarBytes: toInt(env.MEDIA_RESOLVE_MAX_SIDECAR_BYTES, 20 * 1024 * 1024),
      // Playlist expansion is off unless an operator opts in: on a public
      // deployment it is the difference between one video and a thousand.
      allowPlaylists: toBool(env.MEDIA_RESOLVE_ALLOW_PLAYLISTS, true),
      maxPlaylistItems: toInt(env.MEDIA_RESOLVE_MAX_PLAYLIST_ITEMS, 25),
      // Live-stream downloads have no natural end, so they get their own cap.
      allowLive: toBool(env.MEDIA_RESOLVE_ALLOW_LIVE, true),
      // Progress reporting: how many finished jobs stay queryable, and how
      // often the download loop is allowed to publish an update.
      progressEnabled: toBool(env.MEDIA_RESOLVE_PROGRESS, true),
      progressHistorySize: toInt(env.MEDIA_RESOLVE_PROGRESS_HISTORY, 64),
    },

    // Optional bootstrap default storage from env.
    bootstrapDefaultStorage: {
      type: (env.DEFAULT_STORAGE_TYPE || 'telegram').toLowerCase(),
      telegram: {
        botToken: telegramToken.value || '',
        chatId: telegramChatId.value || '',
        apiBase: telegramApiBase.value || 'https://api.telegram.org',
        envSource: {
          botToken: telegramToken.source || 'none',
          chatId: telegramChatId.source || 'none',
          apiBase: telegramApiBase.source || 'default',
        },
      },
      r2: {
        endpoint: normalizeEnvString(env.R2_ENDPOINT) || normalizeEnvString(env.S3_ENDPOINT) || '',
        region: normalizeEnvString(env.R2_REGION) || normalizeEnvString(env.S3_REGION) || 'auto',
        bucket: normalizeEnvString(env.R2_BUCKET) || normalizeEnvString(env.S3_BUCKET) || '',
        accessKeyId: normalizeEnvString(env.R2_ACCESS_KEY_ID) || normalizeEnvString(env.S3_ACCESS_KEY_ID) || '',
        secretAccessKey: normalizeEnvString(env.R2_SECRET_ACCESS_KEY) || normalizeEnvString(env.S3_SECRET_ACCESS_KEY) || '',
      },
      s3: {
        endpoint: normalizeEnvString(env.S3_ENDPOINT),
        region: normalizeEnvString(env.S3_REGION, 'us-east-1'),
        bucket: normalizeEnvString(env.S3_BUCKET),
        accessKeyId: normalizeEnvString(env.S3_ACCESS_KEY_ID),
        secretAccessKey: normalizeEnvString(env.S3_SECRET_ACCESS_KEY),
      },
      discord: {
        webhookUrl: normalizeEnvString(env.DISCORD_WEBHOOK_URL),
        botToken: normalizeEnvString(env.DISCORD_BOT_TOKEN),
        channelId: normalizeEnvString(env.DISCORD_CHANNEL_ID),
      },
      huggingface: {
        token: huggingFaceToken.value || '',
        repo: huggingFaceRepo.value || '',
        envSource: {
          token: huggingFaceToken.source || 'none',
          repo: huggingFaceRepo.source || 'none',
        },
      },
      webdav: {
        baseUrl: normalizeEnvString(env.WEBDAV_BASE_URL),
        username: normalizeEnvString(env.WEBDAV_USERNAME),
        password: normalizeEnvString(env.WEBDAV_PASSWORD),
        bearerToken: normalizeEnvString(env.WEBDAV_BEARER_TOKEN) || normalizeEnvString(env.WEBDAV_TOKEN) || '',
        rootPath: normalizeEnvString(env.WEBDAV_ROOT_PATH),
      },
      github: {
        repo: githubRepo.value || '',
        token: githubToken.value || '',
        mode: normalizeEnvString(env.GITHUB_MODE, 'releases').toLowerCase(),
        prefix: normalizeEnvString(env.GITHUB_PREFIX) || normalizeEnvString(env.GITHUB_PATH) || '',
        releaseTag: normalizeEnvString(env.GITHUB_RELEASE_TAG),
        branch: normalizeEnvString(env.GITHUB_BRANCH),
        apiBase: normalizeEnvString(env.GITHUB_API_BASE, 'https://api.github.com'),
        envSource: {
          repo: githubRepo.source || 'none',
          token: githubToken.source || 'none',
        },
      },
    },
  };
}

module.exports = {
  loadConfig,
  toBool,
  toInt,
};
