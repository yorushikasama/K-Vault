const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { Readable } = require('node:stream');
const { getExtension } = require('../common');

// Cloud Bot API caps uploads at 50MB and downloads at 20MB. A self-hosted Bot
// API server started with --local lifts both (downloads up to 2000MB). What is
// reachable here is still bounded by memory, because the upload path buffers
// the whole file before handing it to fetch().
const CLOUD_MAX_UPLOAD_BYTES = 50 * 1024 * 1024;
const LOCAL_MAX_UPLOAD_BYTES = 2000 * 1024 * 1024;

function isLocalApiBase(raw) {
  try {
    const { hostname } = new URL(String(raw || ''));
    return hostname === 'localhost' || hostname.startsWith('127.') || hostname === '[::1]' || hostname === '::1';
  } catch {
    return false;
  }
}

function resolveMaxUploadBytes(config) {
  const explicit = Number(config?.maxUploadSizeBytes);
  if (Number.isFinite(explicit) && explicit > 0) return explicit;
  return isLocalApiBase(config?.apiBase) ? LOCAL_MAX_UPLOAD_BYTES : CLOUD_MAX_UPLOAD_BYTES;
}

// Quotes and CR/LF would break out of the Content-Disposition header, so strip
// them rather than try to encode: this is only a display name.
function escapeDispositionValue(value) {
  return String(value || '').replace(/["\r\n\\]/g, '_').slice(0, 200);
}

/**
 * Builds a multipart body where the file part is produced by `source()` instead of
 * being handed a Buffer.
 *
 * FormData would be far simpler to write, but it needs the whole Blob in memory —
 * which is precisely the ~4x high-water mark this exists to avoid. The file bytes
 * are pulled straight off disk and forwarded, so the resident cost is one chunk.
 *
 * Content-Length is computed up front, so this is a normal fixed-length body
 * rather than chunked transfer-encoding — fewer unknowns on the wire.
 */
function buildMultipartStream({ boundary, fields, file }) {
  const parts = [];
  let headerBytes = 0;

  for (const [name, value] of Object.entries(fields)) {
    const buffer = Buffer.from(
      `--${boundary}\r\n` +
      `Content-Disposition: form-data; name="${escapeDispositionValue(name)}"\r\n\r\n` +
      `${value}\r\n`,
      'utf8'
    );
    parts.push(buffer);
    headerBytes += buffer.length;
  }

  const fileHead = Buffer.from(
    `--${boundary}\r\n` +
    `Content-Disposition: form-data; name="${escapeDispositionValue(file.name)}"; filename="${escapeDispositionValue(file.fileName)}"\r\n` +
    `Content-Type: ${file.mimeType || 'application/octet-stream'}\r\n\r\n`,
    'utf8'
  );
  const tail = Buffer.from(`\r\n--${boundary}--\r\n`, 'utf8');

  const stream = Readable.from((async function* generateBody() {
    for (const part of parts) yield part;
    yield fileHead;
    for await (const chunk of file.source()) yield chunk;
    yield tail;
  })());

  return {
    stream,
    contentLength: headerBytes + fileHead.length + file.size + tail.length,
  };
}

// A self-hosted Bot API server in --local mode answers getFile with an absolute
// filesystem path and does not serve /file/ over HTTP at all, so the bytes have
// to be read off disk. Mirrors the Range semantics of the HTTP file endpoint.
function parseRangeHeader(range, size) {
  const match = /^bytes=(\d*)-(\d*)$/.exec(String(range || '').trim());
  if (!match) return null;
  const [, rawStart, rawEnd] = match;
  if (rawStart === '' && rawEnd === '') return null;

  let start;
  let end;
  if (rawStart === '') {
    const suffix = Number(rawEnd);
    if (!Number.isFinite(suffix) || suffix <= 0) return null;
    start = Math.max(0, size - suffix);
    end = size - 1;
  } else {
    start = Number(rawStart);
    end = rawEnd === '' ? size - 1 : Number(rawEnd);
  }

  if (!Number.isFinite(start) || !Number.isFinite(end) || start > end || start >= size) return null;
  return { start, end: Math.min(end, size - 1) };
}

function buildLocalFileResponse(filePath, range) {
  let stat;
  try {
    stat = fs.statSync(filePath);
  } catch {
    throw new Error('本地 Bot API 未缓存该文件，请重试或检查 telegram-bot-api 数据目录权限。');
  }

  const total = stat.size;
  const parsed = parseRangeHeader(range, total);
  const headers = new Headers({
    'Accept-Ranges': 'bytes',
    'Content-Length': String(parsed ? parsed.end - parsed.start + 1 : total),
  });
  if (parsed) {
    headers.set('Content-Range', `bytes ${parsed.start}-${parsed.end}/${total}`);
  }

  const stream = fs.createReadStream(filePath, parsed ? { start: parsed.start, end: parsed.end } : undefined);
  return new Response(Readable.toWeb(stream), {
    status: parsed ? 206 : 200,
    headers,
  });
}

function normalizeApiBase(raw) {
  if (!raw) return 'https://api.telegram.org';
  try {
    return new URL(String(raw)).toString().replace(/\/+$/, '');
  } catch {
    return 'https://api.telegram.org';
  }
}

function buildBotApiUrl(config, method) {
  const base = normalizeApiBase(config.apiBase);
  const token = config.botToken;
  return `${base}/bot${token}/${method}`;
}

function buildFileUrl(config, filePath) {
  const base = normalizeApiBase(config.apiBase);
  return `${base}/file/bot${config.botToken}/${String(filePath || '').replace(/^\/+/, '')}`;
}

function pickUploadMethod(mimeType = '') {
  const type = String(mimeType).toLowerCase();
  if (type.startsWith('image/')) return { method: 'sendDocument', field: 'document' };
  if (type.startsWith('audio/')) return { method: 'sendAudio', field: 'audio' };
  if (type.startsWith('video/')) return { method: 'sendVideo', field: 'video' };
  return { method: 'sendDocument', field: 'document' };
}

function pickFileId(result) {
  if (!result) return null;
  if (Array.isArray(result.photo) && result.photo.length > 0) {
    return result.photo[result.photo.length - 1].file_id;
  }
  if (result.document?.file_id) return result.document.file_id;
  if (result.video?.file_id) return result.video.file_id;
  if (result.audio?.file_id) return result.audio.file_id;
  if (result.voice?.file_id) return result.voice.file_id;
  if (result.sticker?.file_id) return result.sticker.file_id;
  if (result.animation?.file_id) return result.animation.file_id;
  if (result.video_note?.file_id) return result.video_note.file_id;
  return null;
}

class TelegramStorageAdapter {
  // Lets UploadService hand us a re-openable stream instead of a Buffer, so a
  // file that already lives on disk never has to be pulled into the heap.
  supportsStreamingUpload = true;

  constructor(config) {
    this.type = 'telegram';
    this.config = {
      botToken: config.botToken,
      chatId: config.chatId,
      apiBase: config.apiBase,
      maxUploadSizeBytes: config.maxUploadSizeBytes,
    };
  }

  validate() {
    if (!this.config.botToken || !this.config.chatId) {
      throw new Error('Telegram 存储需要配置 botToken 和 chatId。');
    }
  }

  async testConnection() {
    this.validate();
    const response = await fetch(buildBotApiUrl(this.config, 'getMe'));
    const json = await response.json().catch(() => ({}));
    const detail = typeof json?.description === 'string' && json.description
      ? json.description
      : (typeof json?.message === 'string' && json.message ? json.message : '');

    return {
      connected: Boolean(response.ok && json.ok),
      status: response.status,
      detail: detail || (json?.ok ? 'ok' : 'Telegram API request failed'),
      raw: json,
      botUsername: json?.result?.username || '',
    };
  }

  async upload({ buffer, fileName, mimeType, fileSize, openStream }) {
    this.validate();

    // Stability-first on the cloud API (50MB up); a --local Bot API server
    // raises that ceiling to 2000MB.
    const maxSize = resolveMaxUploadBytes(this.config);
    if (fileSize > maxSize) {
      throw new Error(`Telegram 上传超过 ${Math.floor(maxSize / 1024 / 1024)}MB 上限。`);
    }

    const { method, field } = pickUploadMethod(mimeType);
    const extension = getExtension(fileName, mimeType, 'bin');
    const normalizedName = fileName || `upload.${extension}`;

    // Preferred path when the caller has the file on disk: forward the bytes and
    // leave the heap alone. Falls through to the FormData path only for callers
    // that genuinely hold a Buffer (the browser upload routes).
    if (typeof openStream === 'function') {
      return this.uploadStreamed({ openStream, method, field, normalizedName, mimeType, fileSize });
    }

    const formData = new FormData();
    formData.append('chat_id', this.config.chatId);
    formData.append(field, new File([buffer], normalizedName, { type: mimeType || 'application/octet-stream' }));

    let response = await fetch(buildBotApiUrl(this.config, method), {
      method: 'POST',
      body: formData,
    });

    let json = await response.json().catch(() => ({}));

    // Fallback audio to document when Telegram media type checks reject.
    if ((!response.ok || !json.ok) && method === 'sendAudio') {
      const fallbackForm = new FormData();
      fallbackForm.append('chat_id', this.config.chatId);
      fallbackForm.append('document', new File([buffer], normalizedName, { type: mimeType || 'application/octet-stream' }));
      response = await fetch(buildBotApiUrl(this.config, 'sendDocument'), {
        method: 'POST',
        body: fallbackForm,
      });
      json = await response.json().catch(() => ({}));
    }

    if (!response.ok || !json.ok) {
      throw new Error(json.description || `Telegram upload failed (${response.status})`);
    }

    const fileId = pickFileId(json.result);
    if (!fileId) {
      throw new Error('Telegram 已接收文件，但未返回可用的 file_id。');
    }

    return {
      storageKey: fileId,
      metadata: {
        telegramFileId: fileId,
        telegramMessageId: json.result?.message_id || null,
      },
    };
  }

  async uploadStreamed({ openStream, method, field, normalizedName, mimeType, fileSize }) {
    // Each attempt gets a fresh boundary and a fresh stream: the sendAudio ->
    // sendDocument fallback sends the same file twice, and a consumed stream
    // cannot be replayed.
    const sendOnce = async (botMethod, fieldName) => {
      const boundary = `----kvault${crypto.randomBytes(16).toString('hex')}`;
      const { stream, contentLength } = buildMultipartStream({
        boundary,
        fields: { chat_id: this.config.chatId },
        file: {
          name: fieldName,
          fileName: normalizedName,
          mimeType,
          source: openStream,
          size: fileSize,
        },
      });

      const response = await fetch(buildBotApiUrl(this.config, botMethod), {
        method: 'POST',
        headers: {
          'content-type': `multipart/form-data; boundary=${boundary}`,
          'content-length': String(contentLength),
        },
        body: Readable.toWeb(stream),
        // Node's fetch insists on being told that a streamed body is half-duplex.
        duplex: 'half',
      });
      const json = await response.json().catch(() => ({}));
      return { response, json };
    };

    let { response, json } = await sendOnce(method, field);

    // Fallback audio to document when Telegram media type checks reject.
    if ((!response.ok || !json.ok) && method === 'sendAudio') {
      ({ response, json } = await sendOnce('sendDocument', 'document'));
    }

    if (!response.ok || !json.ok) {
      throw new Error(json.description || `Telegram upload failed (${response.status})`);
    }

    const fileId = pickFileId(json.result);
    if (!fileId) {
      throw new Error('Telegram 已接收文件，但未返回可用的 file_id。');
    }

    return {
      storageKey: fileId,
      metadata: {
        telegramFileId: fileId,
        telegramMessageId: json.result?.message_id || null,
      },
    };
  }

  async download({ storageKey, metadata = {}, range }) {
    this.validate();

    const fileId = metadata.telegramFileId || storageKey;
    const infoResponse = await fetch(
      `${buildBotApiUrl(this.config, 'getFile')}?file_id=${encodeURIComponent(fileId)}`,
      { method: 'GET' }
    );
    const infoJson = await infoResponse.json().catch(() => ({}));

    if (!infoResponse.ok || !infoJson.ok || !infoJson.result?.file_path) {
      throw new Error(infoJson.description || 'Telegram 获取文件信息失败。');
    }

    const headers = {};
    if (range) headers.Range = range;

    const filePath = infoJson.result.file_path;

    // In --local mode file_path is an absolute path on this host and the HTTP
    // /file/ endpoint is not served, so read the cached file directly.
    if (path.isAbsolute(filePath)) {
      return buildLocalFileResponse(filePath, range);
    }

    const response = await fetch(buildFileUrl(this.config, filePath), {
      method: 'GET',
      headers,
    });

    if (!response.ok && response.status !== 206) {
      throw new Error(`Telegram 下载失败（${response.status}）`);
    }

    return response;
  }

  async delete({ metadata = {}, storageKey }) {
    this.validate();
    const messageId = metadata.telegramMessageId;
    if (!messageId) return false;

    const response = await fetch(buildBotApiUrl(this.config, 'deleteMessage'), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        chat_id: this.config.chatId,
        message_id: Number(messageId),
      }),
    });

    const json = await response.json().catch(() => ({}));
    return Boolean(response.ok && json.ok);
  }
}

module.exports = {
  TelegramStorageAdapter,
};
