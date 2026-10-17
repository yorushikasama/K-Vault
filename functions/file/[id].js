import { createS3Client } from '../utils/s3client.js';
import { getDiscordFileUrl } from '../utils/discord.js';
import { getHuggingFaceFile } from '../utils/huggingface.js';
import { getGitHubFile } from '../utils/github.js';
import {
  buildTelegramBotApiUrl,
  buildTelegramFileUrl,
  parseSignedTelegramFileId,
  shouldWriteTelegramMetadata,
} from '../utils/telegram.js';

const STORAGE_PREFIXES = ['img:', 'vid:', 'aud:', 'doc:', 'r2:', 's3:', 'discord:', 'hf:', 'github:', ''];

const MIME_TYPES = {
  mp4: 'video/mp4',
  webm: 'video/webm',
  ogg: 'video/ogg',
  mov: 'video/quicktime',
  avi: 'video/x-msvideo',
  mkv: 'video/x-matroska',
  m4v: 'video/x-m4v',
  wmv: 'video/x-ms-wmv',
  flv: 'video/x-flv',
  '3gp': 'video/3gpp',
  mp3: 'audio/mpeg',
  wav: 'audio/wav',
  flac: 'audio/flac',
  aac: 'audio/aac',
  m4a: 'audio/mp4',
  wma: 'audio/x-ms-wma',
  opus: 'audio/opus',
  oga: 'audio/ogg',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  png: 'image/png',
  gif: 'image/gif',
  webp: 'image/webp',
  bmp: 'image/bmp',
  svg: 'image/svg+xml',
  ico: 'image/x-icon',
  pdf: 'application/pdf',
  doc: 'application/msword',
  docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  xls: 'application/vnd.ms-excel',
  xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  ppt: 'application/vnd.ms-powerpoint',
  pptx: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  txt: 'text/plain',
  html: 'text/html',
  css: 'text/css',
  js: 'text/javascript',
  json: 'application/json',
  xml: 'application/xml',
  md: 'text/markdown',
  zip: 'application/zip',
  rar: 'application/x-rar-compressed',
  '7z': 'application/x-7z-compressed',
  tar: 'application/x-tar',
  gz: 'application/gzip',
};

export async function onRequest(context) {
  const { request, env, params } = context;

  if (request.method === 'OPTIONS') {
    return handleOptions();
  }

  // 每个请求重新判定：模块级变量在 Pages 的复用实例上会跨请求残留。
  try {
    requestDeclaresImmutable = new URL(request.url).searchParams.has('v');
  } catch {
    requestDeclaresImmutable = false;
  }

  try {
    let fileId = params.id;
    if (!fileId) {
      return errorResponse('Missing file id', 400);
    }

    const signedTelegramMeta = await parseSignedTelegramFileId(fileId, env);
    if (signedTelegramMeta) {
      return handleSignedTelegramFile(context, signedTelegramMeta);
    }

    const recordResult = await getRecordWithKey(env, fileId);
    const record = recordResult?.record;
    const kvKey = recordResult?.kvKey || fileId;

    if (env.img_url && !record?.metadata) {
      return errorResponse('File not found', 404);
    }

    let shareAccess = null;
    if (record?.metadata) {
      shareAccess = await verifyShareAccess(context, record.metadata, kvKey);
      if (shareAccess?.response) {
        return shareAccess.response;
      }
    }

    const storageType = inferStorageType(fileId, record?.metadata || {});
    let response;
    if (storageType === 'r2') {
      response = await handleR2File(context, record?.metadata?.r2Key || fileId, record);
    } else if (storageType === 's3') {
      response = await handleS3File(context, fileId, record);
    } else if (storageType === 'discord') {
      response = await handleDiscordFile(context, fileId, record);
    } else if (storageType === 'huggingface') {
      response = await handleHFFile(context, fileId, record);
    } else if (storageType === 'github') {
      response = await handleGitHubFile(context, fileId, record);
    } else {
      response = await handleTelegramFile(context, fileId, record);
    }

    if (shareAccess?.trackDownload && shouldCountAsDownload(request.method, response)) {
      const updatePromise = incrementShareDownloadCount(env, shareAccess.kvKey, shareAccess.metadata);
      if (typeof context.waitUntil === 'function') {
        context.waitUntil(updatePromise.catch(() => {}));
      } else {
        updatePromise.catch(() => {});
      }
    }

    return response;
  } catch (error) {
    console.error('file route error:', error);
    return errorResponse(`File proxy error: ${error?.message || 'Unknown error'}`, 502);
  }
}

function inferStorageType(name, metadata = {}) {
  const explicit = metadata.storageType || metadata.storage;
  if (explicit) return String(explicit).toLowerCase();

  const keyName = String(name || '');
  if (keyName.startsWith('r2:')) return 'r2';
  if (keyName.startsWith('s3:')) return 's3';
  if (keyName.startsWith('discord:')) return 'discord';
  if (keyName.startsWith('hf:')) return 'huggingface';
  if (keyName.startsWith('github:')) return 'github';
  return 'telegram';
}

function getMimeType(fileName = '') {
  const ext = String(fileName).split('.').pop()?.toLowerCase() || '';
  return MIME_TYPES[ext] || 'application/octet-stream';
}

// 请求是否声明了「这个 URL 的内容不变」（带 v 版本参数）。
// onRequest 入口按当前请求设置；站点壁纸这类 UI 资源会带 v，据此放行长缓存。
// 为什么用模块级而不是逐处传参：header 由 9 个 handler 各自构造，
// 逐个加参数会把这个标志散到所有分支里，漏一处就静默回到 no-store。
let requestDeclaresImmutable = false;

function addCorsHeaders(headers) {
  headers.set('Access-Control-Allow-Origin', '*');
  headers.set('Access-Control-Allow-Methods', 'GET, HEAD, OPTIONS');
  headers.set('Access-Control-Allow-Headers', 'Range, Content-Type, Accept, Origin');
  headers.set('Access-Control-Expose-Headers', 'Content-Length, Content-Range, Accept-Ranges, Content-Type, Content-Disposition');
  // 带 v 的请求连 CDN 缓存也放行（换壁纸时 v 变，自然拿到新图）。
  headers.set('CDN-Cache-Control', requestDeclaresImmutable ? 'public, max-age=31536000' : 'no-store');
  return headers;
}

// 能被浏览器当文档解析并执行脚本的 MIME 类型。上传的 .html/.svg 直链若以这些
// 类型 inline 返回，脚本会在站点自身源下执行（存储型 XSS），可读取 localStorage、
// 带 cookie 调 /api/manage/**。对所有 /file/ 响应统一加固：nosniff 阻断 MIME 嗅探；
// 危险类型再加 CSP sandbox（无 allow-* 子句 = 脚本不执行、源隔离），
// 而 img/视频这类子资源加载不受 sandbox 影响——SVG 图库展示、PDF 预览因此不受损。
const SCRIPTABLE_DOCUMENT_TYPES = new Set([
  'text/html',
  'application/xhtml+xml',
  'image/svg+xml',
  'application/xml',
  'text/xml',
  'text/javascript',
  'application/javascript',
  'application/x-javascript',
]);

function hardenFileResponse(headers) {
  headers.set('X-Content-Type-Options', 'nosniff');
  const contentType = String(headers.get('Content-Type') || '').split(';')[0].trim().toLowerCase();
  if (SCRIPTABLE_DOCUMENT_TYPES.has(contentType)) {
    headers.set('Content-Security-Policy', 'sandbox');
  }
}

function addResponseHeaders(headers, fileName, mimeType, upstream = null) {
  addCorsHeaders(headers);
  headers.set('Content-Type', mimeType || 'application/octet-stream');
  // 默认 no-store：文件可能被删除、封禁或移入白名单审核，直链必须每次回源。
  // 带 v 参数才长缓存（调用方声明 URL 内容不变），见 requestDeclaresImmutable。
  headers.set(
    'Cache-Control',
    requestDeclaresImmutable ? 'public, max-age=31536000, immutable' : 'no-store, max-age=0'
  );
  headers.set('Accept-Ranges', 'bytes');
  hardenFileResponse(headers);

  if (fileName) {
    const encoded = encodeURIComponent(fileName);
    headers.set('Content-Disposition', `inline; filename="${encoded}"; filename*=UTF-8''${encoded}`);
  }

  if (upstream) {
    const contentLength = upstream.headers.get('Content-Length');
    const contentRange = upstream.headers.get('Content-Range');
    if (contentLength) headers.set('Content-Length', contentLength);
    if (contentRange) headers.set('Content-Range', contentRange);
  }
}

function handleOptions() {
  const headers = new Headers();
  addCorsHeaders(headers);
  headers.set('Access-Control-Max-Age', '86400');
  return new Response(null, { status: 204, headers });
}

function errorResponse(message, status = 500) {
  const headers = new Headers();
  addCorsHeaders(headers);
  headers.set('Cache-Control', 'no-store, max-age=0');
  return new Response(message, { status, headers });
}

function shouldBlock(metadata = {}) {
  const listType = String(metadata.ListType || '').toLowerCase();
  const label = String(metadata.Label || '').toLowerCase();
  return listType === 'block' || label === 'adult';
}

function shouldWhitelistDeny(env, metadata = {}) {
  if (env.WhiteList_Mode !== 'true') return false;
  const listType = String(metadata.ListType || '').toLowerCase();
  return listType !== 'white';
}

function blockRedirect(requestUrl, request) {
  const referer = request.headers.get('Referer');
  if (referer) {
    return Response.redirect('https://static-res.pages.dev/teleimage/img-block-compressed.png', 302);
  }
  return Response.redirect(`${requestUrl.origin}/block-img.html`, 302);
}

async function getRecordWithKey(env, fileId) {
  if (!env.img_url) return { record: null, kvKey: fileId };

  const hasKnownPrefix = STORAGE_PREFIXES.some((prefix) => prefix && fileId.startsWith(prefix));
  const candidateKeys = hasKnownPrefix ? [fileId] : STORAGE_PREFIXES.map((prefix) => `${prefix}${fileId}`);

  for (const key of candidateKeys) {
    const record = await env.img_url.getWithMetadata(key);
    if (record?.metadata) {
      return { record, kvKey: key };
    }
  }

  return { record: null, kvKey: fileId };
}

function getSharePassword(request) {
  const url = new URL(request.url);
  return String(
    url.searchParams.get('password')
    || request.headers.get('X-File-Password')
    || request.headers.get('X-Share-Password')
    || ''
  );
}

async function sha256Hex(input) {
  const bytes = new TextEncoder().encode(String(input || ''));
  const digest = await crypto.subtle.digest('SHA-256', bytes);
  return Array.from(new Uint8Array(digest))
    .map((byte) => byte.toString(16).padStart(2, '0'))
    .join('');
}

function timingSafeEqual(a, b) {
  if (a.length !== b.length) return false;
  let mismatch = 0;
  for (let i = 0; i < a.length; i += 1) {
    mismatch |= a.charCodeAt(i) ^ b.charCodeAt(i);
  }
  return mismatch === 0;
}

async function verifyShareAccess(context, metadata = {}, kvKey = '') {
  const expiresAt = Number(metadata.shareExpiresAt || 0);
  if (Number.isFinite(expiresAt) && expiresAt > 0 && Date.now() > expiresAt) {
    return { response: errorResponse('File link has expired', 410) };
  }

  const maxDownloads = Number(metadata.shareMaxDownloads || 0);
  const currentDownloads = Number(metadata.shareDownloadCount || 0);
  if (Number.isFinite(maxDownloads) && maxDownloads > 0 && currentDownloads >= maxDownloads) {
    return { response: errorResponse('File download limit reached', 410) };
  }

  if (metadata.sharePasswordHash) {
    const providedPassword = getSharePassword(context.request);
    if (!providedPassword) {
      return { response: errorResponse('File password required', 401) };
    }
    const expected = await sha256Hex(`${String(metadata.sharePasswordSalt || '')}:${providedPassword}`);
    if (!timingSafeEqual(String(metadata.sharePasswordHash || ''), expected)) {
      return { response: errorResponse('File password invalid', 403) };
    }
  }

  return {
    response: null,
    trackDownload: Number.isFinite(maxDownloads) && maxDownloads > 0,
    kvKey,
    metadata,
  };
}

function shouldCountAsDownload(method, response) {
  if (String(method || '').toUpperCase() !== 'GET') return false;
  if (!response) return false;
  return response.status === 200 || response.status === 206;
}

async function incrementShareDownloadCount(env, kvKey, metadata = {}) {
  if (!env?.img_url || !kvKey || !metadata) return;
  const nextCount = Number(metadata.shareDownloadCount || 0) + 1;
  const nextMetadata = {
    ...metadata,
    shareDownloadCount: nextCount,
  };
  await env.img_url.put(kvKey, '', { metadata: nextMetadata });
}

async function handleTelegramFile(context, fileId, record = null) {
  const { request, env } = context;
  const url = new URL(request.url);

  const metadata = record?.metadata || {};
  if (shouldBlock(metadata)) {
    return blockRedirect(url, request);
  }
  if (shouldWhitelistDeny(env, metadata)) {
    return Response.redirect(`${url.origin}/whitelist-on.html`, 302);
  }

  const fileName = metadata.fileName || fileId;
  const mimeType = getMimeType(fileName);

  const telegramFileId = String(fileId).split('.')[0];
  const filePath = await getTelegramFilePath(env, telegramFileId);
  if (!filePath) {
    return errorResponse('Failed to get file path from Telegram', 500);
  }

  const rangeHeader = request.headers.get('Range');
  const fetchHeaders = new Headers();
  if (rangeHeader) fetchHeaders.set('Range', rangeHeader);

  const upstream = await fetch(buildTelegramFileUrl(env, filePath), {
    method: request.method === 'HEAD' ? 'HEAD' : 'GET',
    headers: fetchHeaders,
    cf: { cacheTtl: 0, cacheEverything: false },
  });

  if (!upstream.ok && upstream.status !== 206) {
    return errorResponse('Failed to fetch file from Telegram', upstream.status);
  }

  const headers = new Headers();
  addResponseHeaders(headers, fileName, mimeType, upstream);

  return new Response(upstream.body, {
    status: upstream.status,
    statusText: upstream.statusText,
    headers,
  });
}

async function handleSignedTelegramFile(context, signedMeta) {
  const { request, env } = context;

  const filePath = await getTelegramFilePath(env, signedMeta.fileId);
  if (!filePath) {
    return errorResponse('Failed to get file path from Telegram', 500);
  }

  await backfillSignedTelegramMetadata(env, signedMeta);

  const fileName = signedMeta.fileName || `${signedMeta.fileId}.${signedMeta.fileExtension || 'bin'}`;
  const mimeType = signedMeta.mimeType || getMimeType(fileName);

  const rangeHeader = request.headers.get('Range');
  const fetchHeaders = new Headers();
  if (rangeHeader) fetchHeaders.set('Range', rangeHeader);

  const upstream = await fetch(buildTelegramFileUrl(env, filePath), {
    method: request.method === 'HEAD' ? 'HEAD' : 'GET',
    headers: fetchHeaders,
    cf: { cacheTtl: 0, cacheEverything: false },
  });

  if (!upstream.ok && upstream.status !== 206) {
    return errorResponse('Failed to fetch file from Telegram', upstream.status);
  }

  const headers = new Headers();
  addResponseHeaders(headers, fileName, mimeType, upstream);

  return new Response(upstream.body, {
    status: upstream.status,
    statusText: upstream.statusText,
    headers,
  });
}

async function backfillSignedTelegramMetadata(env, signedMeta) {
  if (!env.img_url || !shouldWriteTelegramMetadata(env)) {
    return;
  }

  const fileExtension = signedMeta.fileExtension || 'bin';
  const kvKey = `${signedMeta.fileId}.${fileExtension}`;

  try {
    const existing = await env.img_url.getWithMetadata(kvKey);
    if (existing?.metadata) return;

    await env.img_url.put(kvKey, '', {
      metadata: {
        TimeStamp: signedMeta.timestamp || Date.now(),
        ListType: 'None',
        Label: 'None',
        liked: false,
        fileName: signedMeta.fileName || `${signedMeta.fileId}.${fileExtension}`,
        fileSize: signedMeta.fileSize || 0,
        storageType: 'telegram',
        telegramFileId: signedMeta.fileId,
        telegramMessageId: signedMeta.messageId || undefined,
        signedLink: true,
        source: 'signed-backfill',
      },
    });
  } catch (error) {
    console.warn('Signed metadata backfill skipped:', error.message);
  }
}

async function handleR2File(context, r2Key, record = null) {
  const { request, env } = context;
  const requestUrl = new URL(request.url);

  if (!env.R2_BUCKET) {
    return errorResponse('R2 storage not configured', 500);
  }

  if (!record?.metadata) {
    const resolved = await getR2RecordFromKV(env, r2Key);
    record = resolved;
  }

  if (!record?.metadata) {
    return errorResponse('File not found', 404);
  }

  if (shouldBlock(record.metadata)) {
    return blockRedirect(requestUrl, request);
  }
  if (shouldWhitelistDeny(env, record.metadata)) {
    return Response.redirect(`${requestUrl.origin}/whitelist-on.html`, 302);
  }

  const fileName = record.metadata.fileName || r2Key;
  const mimeType = getMimeType(fileName);

  const rangeHeader = request.headers.get('Range');
  let object;
  let responseStatus = 200;
  let contentLength = null;
  let contentRange = null;

  if (rangeHeader) {
    const head = await env.R2_BUCKET.head(r2Key);
    if (!head) return errorResponse('File not found in R2', 404);

    const range = parseSimpleRange(rangeHeader, head.size);
    if (range) {
      if (range.unsatisfiable) {
        const headers = new Headers();
        addCorsHeaders(headers);
        headers.set('Accept-Ranges', 'bytes');
        headers.set('Content-Range', `bytes */${head.size}`);
        return new Response('Range Not Satisfiable', { status: 416, headers });
      }

      const { start, end } = range;
      object = await env.R2_BUCKET.get(r2Key, {
        range: { offset: start, length: end - start + 1 },
      });
      responseStatus = 206;
      contentLength = end - start + 1;
      contentRange = `bytes ${start}-${end}/${head.size}`;
    }
  }

  if (!object) {
    object = await env.R2_BUCKET.get(r2Key);
  }

  if (!object) {
    return errorResponse('File not found in R2', 404);
  }

  const headers = new Headers();
  addResponseHeaders(headers, fileName, mimeType);
  headers.set('Content-Length', String(contentLength ?? object.size));
  if (contentRange) headers.set('Content-Range', contentRange);

  return new Response(object.body, {
    status: responseStatus,
    headers,
  });
}

async function getR2RecordFromKV(env, r2Key) {
  if (!env.img_url) return null;

  const candidateKeys = r2Key.startsWith('r2:') ? [r2Key, r2Key.slice(3)] : [`r2:${r2Key}`, r2Key];

  for (const key of candidateKeys) {
    const record = await env.img_url.getWithMetadata(key);
    if (record?.metadata) return record;
  }

  return null;
}

function parseSimpleRange(rangeHeader, size = null) {
  const match = String(rangeHeader || '').match(/^bytes=(\d*)-(\d*)$/);
  if (!match) return null;

  const hasStart = match[1] !== '';
  const hasEnd = match[2] !== '';
  if (!hasStart && !hasEnd) return null;

  let start;
  let end;

  if (!hasStart) {
    const suffixLength = parseInt(match[2], 10);
    if (!Number.isFinite(suffixLength) || suffixLength <= 0) return null;
    if (size == null) return { start: null, end: suffixLength };
    start = Math.max(size - suffixLength, 0);
    end = size - 1;
  } else {
    start = parseInt(match[1], 10);
    end = hasEnd ? parseInt(match[2], 10) : (size == null ? null : size - 1);
  }

  if (!Number.isFinite(start) || (end != null && !Number.isFinite(end))) return null;

  if (size != null) {
    if (start >= size || (end != null && start > end)) {
      return { unsatisfiable: true };
    }
    end = Math.min(end ?? size - 1, size - 1);
  }

  return { start, end };
}

async function handleS3File(context, fileId, record = null) {
  const { request, env } = context;
  const requestUrl = new URL(request.url);

  if (!record?.metadata) {
    record = await findRecordByPrefixes(env, fileId, ['s3:', 'img:', 'vid:', 'aud:', 'doc:', '']);
  }
  if (!record?.metadata) return errorResponse('File not found', 404);

  if (shouldBlock(record.metadata)) {
    return blockRedirect(requestUrl, request);
  }
  if (shouldWhitelistDeny(env, record.metadata)) {
    return Response.redirect(`${requestUrl.origin}/whitelist-on.html`, 302);
  }

  const s3Key = record.metadata.s3Key || fileId.replace(/^s3:/, '');
  const fileName = record.metadata.fileName || fileId;
  const mimeType = getMimeType(fileName);

  const s3 = createS3Client(env);
  const rangeHeader = request.headers.get('Range');
  const upstream = await s3.getObject(s3Key, rangeHeader ? { range: rangeHeader } : {});

  if (!upstream) return errorResponse('File not found in S3', 404);

  const headers = new Headers();
  addResponseHeaders(headers, fileName, mimeType, upstream);

  return new Response(upstream.body, {
    status: upstream.status,
    headers,
  });
}

async function handleDiscordFile(context, fileId, record = null) {
  const { request, env } = context;
  const requestUrl = new URL(request.url);

  if (!record?.metadata) {
    record = await findRecordByPrefixes(env, fileId, ['discord:', 'img:', 'vid:', 'aud:', 'doc:', '']);
  }
  if (!record?.metadata) return errorResponse('File not found', 404);

  if (shouldBlock(record.metadata)) {
    return blockRedirect(requestUrl, request);
  }
  if (shouldWhitelistDeny(env, record.metadata)) {
    return Response.redirect(`${requestUrl.origin}/whitelist-on.html`, 302);
  }

  const { discordChannelId, discordMessageId } = record.metadata;
  if (!discordChannelId || !discordMessageId) {
    return errorResponse('Discord metadata incomplete', 500);
  }

  const fileInfo = await getDiscordFileUrl(discordChannelId, discordMessageId, env);
  if (!fileInfo) return errorResponse('File not found on Discord', 404);

  const rangeHeader = request.headers.get('Range');
  const upstream = await fetch(fileInfo.url, {
    headers: rangeHeader ? { Range: rangeHeader } : {},
  });

  if (!upstream.ok && upstream.status !== 206) {
    return errorResponse('Error fetching file from Discord', 502);
  }

  const fileName = record.metadata.fileName || fileInfo.filename || fileId;
  const mimeType = getMimeType(fileName);

  const headers = new Headers();
  addResponseHeaders(headers, fileName, mimeType, upstream);

  return new Response(upstream.body, {
    status: upstream.status,
    headers,
  });
}

async function handleHFFile(context, fileId, record = null) {
  const { request, env } = context;
  const requestUrl = new URL(request.url);

  if (!record?.metadata) {
    record = await findRecordByPrefixes(env, fileId, ['hf:', 'img:', 'vid:', 'aud:', 'doc:', '']);
  }
  if (!record?.metadata) return errorResponse('File not found', 404);

  if (shouldBlock(record.metadata)) {
    return blockRedirect(requestUrl, request);
  }
  if (shouldWhitelistDeny(env, record.metadata)) {
    return Response.redirect(`${requestUrl.origin}/whitelist-on.html`, 302);
  }

  const hfPath = record.metadata.hfPath;
  if (!hfPath) return errorResponse('HuggingFace path missing', 500);

  const rangeHeader = request.headers.get('Range');
  const upstream = await getHuggingFaceFile(hfPath, env, rangeHeader ? { range: rangeHeader } : {});

  if (!upstream.ok && upstream.status !== 206) {
    return errorResponse('File not found on HuggingFace', upstream.status || 404);
  }

  const fileName = record.metadata.fileName || fileId;
  const mimeType = getMimeType(fileName);

  const headers = new Headers();
  addResponseHeaders(headers, fileName, mimeType, upstream);

  return new Response(upstream.body, {
    status: upstream.status,
    headers,
  });
}

async function handleGitHubFile(context, fileId, record = null) {
  const { request, env } = context;
  const requestUrl = new URL(request.url);

  if (!record?.metadata) {
    record = await findRecordByPrefixes(env, fileId, ['github:', 'img:', 'vid:', 'aud:', 'doc:', '']);
  }
  if (!record?.metadata) return errorResponse('File not found', 404);

  if (shouldBlock(record.metadata)) {
    return blockRedirect(requestUrl, request);
  }
  if (shouldWhitelistDeny(env, record.metadata)) {
    return Response.redirect(`${requestUrl.origin}/whitelist-on.html`, 302);
  }

  const githubStorageKey = record.metadata.githubStorageKey || fileId.replace(/^github:/, '');
  const rangeHeader = request.headers.get('Range');
  const upstream = await getGitHubFile(
    githubStorageKey,
    record.metadata || {},
    env,
    rangeHeader ? { range: rangeHeader } : {}
  );

  if (!upstream) return errorResponse('File not found on GitHub', 404);

  const fileName = record.metadata.fileName || fileId;
  const mimeType = getMimeType(fileName);

  const headers = new Headers();
  addResponseHeaders(headers, fileName, mimeType, upstream);

  return new Response(upstream.body, {
    status: upstream.status,
    headers,
  });
}

async function findRecordByPrefixes(env, fileId, prefixes = []) {
  if (!env.img_url) return null;

  for (const prefix of prefixes) {
    const key = `${prefix}${fileId}`;
    const record = await env.img_url.getWithMetadata(key);
    if (record?.metadata) return record;
  }
  return null;
}

async function getTelegramFilePath(env, fileId) {
  try {
    const url = `${buildTelegramBotApiUrl(env, 'getFile')}?file_id=${encodeURIComponent(fileId)}`;
    const response = await fetch(url, { method: 'GET' });
    if (!response.ok) return null;

    const data = await response.json();
    if (!data?.ok || !data?.result?.file_path) return null;
    return data.result.file_path;
  } catch (error) {
    console.error('getTelegramFilePath failed:', error);
    return null;
  }
}
