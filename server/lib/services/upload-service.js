const { buildPublicFileId, normalizeStorageType } = require('../storage/common');
const { normalizeFolderPath } = require('../repos/file-repo');
const { fetchRemote, readBodyWithLimit } = require('../utils/remote-fetch');
const crypto = require('node:crypto');
const fsp = require('node:fs/promises');
const fsSync = require('node:fs');
const os = require('node:os');
const path = require('node:path');

// Resolved media URLs occasionally need the platform's own Referer or
// User-Agent to clear the CDN's hotlink check. Only well-formed string values
// survive, so a hostile payload cannot smuggle malformed headers into fetch.
const FORBIDDEN_REQUEST_HEADERS = new Set(['host', 'content-length', 'connection', 'transfer-encoding']);

function normalizeRequestHeaders(input) {
  if (!input || typeof input !== 'object') return {};
  const normalized = {};
  for (const [key, value] of Object.entries(input)) {
    const name = String(key || '').trim();
    if (!name || name.length > 64) continue;
    if (!/^[A-Za-z0-9-]+$/.test(name)) continue;
    if (FORBIDDEN_REQUEST_HEADERS.has(name.toLowerCase())) continue;
    const text = typeof value === 'string' ? value : String(value ?? '');
    if (!text || text.length > 2048) continue;
    normalized[name] = text;
  }
  return normalized;
}

// Only used for storage backends that cannot stream at all; every streaming path
// avoids materialising the file.
async function collectStream(stream) {
  const chunks = [];
  for await (const chunk of stream) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  return Buffer.concat(chunks);
}

/**
 * Stages a body whose length is unknown onto disk, enforcing the cap while
 * writing.
 *
 * Without a Content-Length the cap can only be enforced by counting, and counting
 * means holding every byte — which is how a "legitimate" 200MB import used to
 * cost a couple of hundred megabytes of heap. Writing to a file instead keeps the
 * resident cost at one chunk, and the staged file feeds straight into the
 * streaming upload afterwards.
 */
async function stageBodyToTempFile(response, maxBytes, buildError, dir) {
  const body = response.body;
  if (!body) throw buildError();

  await fsp.mkdir(dir, { recursive: true });
  const filePath = path.join(
    dir,
    `upload-from-url-${Date.now()}-${crypto.randomBytes(4).toString('hex')}.part`
  );

  const handle = await fsp.open(filePath, 'w');
  let received = 0;
  try {
    const reader = body.getReader();
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        received += value.byteLength;
        if (received > maxBytes) throw buildError();
        await handle.write(Buffer.from(value));
      }
    } finally {
      try {
        await reader.cancel();
      } catch {
        // Already closed.
      }
    }
  } catch (error) {
    await handle.close().catch(() => {});
    await fsp.rm(filePath, { force: true }).catch(() => {});
    throw error;
  }
  await handle.close();

  if (received === 0) {
    await fsp.rm(filePath, { force: true }).catch(() => {});
    const error = new Error('目标 URL 返回了空文件。');
    error.code = 'REMOTE_FILE_EMPTY';
    error.status = 422;
    throw error;
  }

  return { filePath, size: received };
}

class UploadService {
  constructor({ storageRepo, fileRepo, storageFactory, config = null }) {
    this.storageRepo = storageRepo;
    this.fileRepo = fileRepo;
    this.storageFactory = storageFactory;
    // Ceiling for backends that can only accept a whole in-memory file. 0 = no
    // extra cap beyond the global upload limit.
    this.bufferedBackendMaxSize = Number(config?.bufferedBackendMaxSize) || 0;
    // Where unknown-length remote bodies get staged before the streaming upload.
    this.uploadTempDir = String(config?.uploadTempDir || '').trim();
  }

  resolveStorage({ storageId, storageMode }) {
    const storageConfig = this.storageRepo.resolveStorageSelection({ storageId, storageMode });
    if (!storageConfig) {
      throw new Error('没有可用的存储配置。');
    }
    return storageConfig;
  }

  // Storage key layout is backend-specific (HuggingFace nests under uploads/), and
  // both upload paths have to agree on it — a second copy of this is exactly how
  // the two would silently diverge.
  prepareTarget(storageConfig, fileName, mimeType, folderPath) {
    const storageType = normalizeStorageType(storageConfig.type);
    const normalizedFolderPath = normalizeFolderPath(folderPath);
    const publicId = buildPublicFileId(storageType, fileName, mimeType);

    let adapterStorageKey = normalizedFolderPath ? `${normalizedFolderPath}/${publicId}` : publicId;
    if (storageType === 'huggingface') {
      adapterStorageKey = normalizedFolderPath
        ? `uploads/${normalizedFolderPath}/${publicId}`
        : `uploads/${publicId}`;
    }

    return { storageType, normalizedFolderPath, publicId, adapterStorageKey };
  }

  persistResult({ storageConfig, target, uploadResult, fileName, fileSize, mimeType }) {
    const { storageType, normalizedFolderPath, publicId, adapterStorageKey } = target;
    const storageKey = uploadResult.storageKey || adapterStorageKey;

    const fileRecord = this.fileRepo.create({
      id: publicId,
      storageConfigId: storageConfig.id,
      storageType,
      storageKey,
      fileName,
      fileSize,
      mimeType,
      folderPath: normalizedFolderPath,
      extra: uploadResult.metadata || {},
    });

    return {
      file: fileRecord,
      src: `/file/${encodeURIComponent(publicId)}`,
      storage: {
        id: storageConfig.id,
        name: storageConfig.name,
        type: storageType,
      },
    };
  }

  async uploadFile({
    fileName,
    mimeType,
    fileSize,
    buffer,
    storageId,
    storageMode,
    folderPath,
  }) {
    const storageConfig = this.resolveStorage({ storageId, storageMode });
    const adapter = this.storageFactory.createAdapter(storageConfig);
    const target = this.prepareTarget(storageConfig, fileName, mimeType, folderPath);

    const uploadResult = await adapter.upload({
      storageKey: target.adapterStorageKey,
      fileName,
      mimeType,
      fileSize,
      buffer,
    });

    return this.persistResult({ storageConfig, target, uploadResult, fileName, fileSize, mimeType });
  }

  /**
   * Upload from a re-openable stream instead of a Buffer.
   *
   * `openStream` is a factory rather than a stream: the Telegram adapter may send
   * the same file twice (the sendAudio -> sendDocument fallback), and a consumed
   * stream cannot be replayed.
   *
   * Adapters that cannot stream fall back to buffering, but only up to
   * `bufferedBackendMaxSize`. HuggingFace and GitHub are in that group for a hard
   * reason — both require the content base64-encoded inside a JSON body, which
   * needs a whole in-memory copy (1.33x, at that). Refusing loudly past the limit
   * is what stops a raised UPLOAD_MAX_SIZE from becoming an OOM budget.
   */
  async uploadStream({
    openStream,
    fileSize,
    fileName,
    mimeType,
    storageId,
    storageMode,
    folderPath,
  }) {
    const storageConfig = this.resolveStorage({ storageId, storageMode });
    const adapter = this.storageFactory.createAdapter(storageConfig);
    const target = this.prepareTarget(storageConfig, fileName, mimeType, folderPath);

    const shared = {
      storageKey: target.adapterStorageKey,
      fileName,
      mimeType,
      fileSize,
    };

    let uploadResult;
    if (adapter.supportsStreamingUpload === true) {
      uploadResult = await adapter.upload({ ...shared, openStream });
    } else {
      const limit = Number(this.bufferedBackendMaxSize) || 0;
      if (limit > 0 && fileSize > limit) {
        const error = new Error(
          `当前存储后端需要把文件整块读入内存，暂不支持超过 ${Math.floor(limit / 1024 / 1024)}MB 的文件。`
        );
        error.code = 'BUFFERED_BACKEND_TOO_LARGE';
        error.status = 413;
        throw error;
      }
      uploadResult = await adapter.upload({ ...shared, buffer: await collectStream(openStream()) });
    }

    return this.persistResult({ storageConfig, target, uploadResult, fileName, fileSize, mimeType });
  }

  async uploadFromUrl({
    url,
    storageId,
    storageMode,
    folderPath,
    maxBytes = 20 * 1024 * 1024,
    headers = null,
    timeoutMs = 30000,
  }) {
    // A malformed or unsupported URL is a client error, so it must not fall
    // through to the generic 502 the upload error classifier produces. Without
    // an explicit code/status the caller is told "network error, retry" for
    // something that can never succeed.
    let parsedUrl;
    try {
      parsedUrl = new URL(String(url || '').trim());
    } catch {
      const error = new Error('请输入有效的 URL。');
      error.code = 'INVALID_URL';
      error.status = 400;
      throw error;
    }
    if (!['http:', 'https:'].includes(parsedUrl.protocol)) {
      const error = new Error('仅支持 HTTP/HTTPS URL。');
      error.code = 'INVALID_URL';
      error.status = 400;
      throw error;
    }

    const limitText = `${Math.floor(maxBytes / 1024 / 1024)}MB`;
    // Carries an explicit status so the error classifier reports a size problem
    // (413 / QUOTA_EXCEEDED) instead of falling through to a retriable 502.
    const tooLarge = () => {
      const error = new Error(`远程文件超过大小限制（${limitText}）。`);
      error.code = 'FILE_TOO_LARGE';
      error.status = 413;
      return error;
    };

    // SSRF-checked and redirect-aware: every hop is re-validated, so a public URL
    // cannot bounce us onto the internal network. The helper also owns the
    // transport timeout (the previous AbortController is gone with it).
    const { response, finalUrl } = await fetchRemote({
      url: parsedUrl.href,
      timeoutMs,
      headers: {
        'User-Agent': 'YoruVault/2.0 (+https://github.com/katelya77/K-Vault)',
        Accept: '*/*',
        ...normalizeRequestHeaders(headers),
      },
    });

    if (!response.ok) {
      const error = new Error(`目标 URL 响应异常：${response.status}。`);
      error.code = 'IMPORT_REMOTE_ERROR';
      error.status = 502;
      throw error;
    }

    const contentType = response.headers.get('content-type') || 'application/octet-stream';

    // Derive the name from the URL we actually ended up at, not the one we were
    // asked for — after a redirect those differ.
    let fileName = '';
    try {
      fileName = decodeURIComponent(new URL(finalUrl).pathname.split('/').pop() || '').trim();
    } catch {
      fileName = '';
    }
    if (!fileName) {
      fileName = `url_${Date.now()}`;
    }

    if (!fileName.includes('.')) {
      const ext = String(contentType).split('/')[1]?.split(';')[0] || 'bin';
      fileName = `${fileName}.${ext}`;
    }

    // With no declared length the cap can only be enforced by counting, and
    // counting means holding every byte — the one case the streaming upload can't
    // cover directly. Stage it on disk instead: same cap, flat heap, and the file
    // then feeds into uploadStream like any other on-disk source.
    const declared = Number(response.headers.get('content-length'));
    if (!Number.isFinite(declared)) {
      const tempDir = String(this.uploadTempDir || '').trim() || os.tmpdir();
      const staged = await stageBodyToTempFile(response, maxBytes, tooLarge, tempDir);
      try {
        return await this.uploadStream({
          openStream: () => fsSync.createReadStream(staged.filePath),
          fileSize: staged.size,
          fileName,
          mimeType: contentType,
          storageId,
          storageMode,
          folderPath,
        });
      } finally {
        await fsp.rm(staged.filePath, { force: true }).catch(() => {});
      }
    }

    // Enforces the cap while reading: an oversize body is refused on its declared
    // length before allocation, and abandoned mid-read if the length lied.
    const bytes = await readBodyWithLimit(response, maxBytes, tooLarge);

    if (bytes.byteLength === 0) {
      const error = new Error('目标 URL 返回了空文件。');
      error.code = 'REMOTE_FILE_EMPTY';
      error.status = 422;
      throw error;
    }

    return this.uploadFile({
      fileName,
      mimeType: contentType,
      fileSize: bytes.byteLength,
      buffer: bytes,
      storageId,
      storageMode,
      folderPath,
    });
  }

  async getFileResponse(fileId, rangeHeader) {
    const file = this.fileRepo.getById(fileId);
    if (!file) return null;

    const storageConfig = this.storageRepo.getById(file.storage_config_id, true);
    if (!storageConfig) {
      throw new Error('文件引用的存储配置不存在。');
    }

    const adapter = this.storageFactory.createAdapter(storageConfig);
    const response = await adapter.download({
      storageKey: file.storage_key,
      metadata: file.metadata,
      range: rangeHeader,
    });

    if (!response) return null;

    return {
      file,
      response,
    };
  }

  async deleteFile(fileId) {
    const file = this.fileRepo.getById(fileId);
    if (!file) return { deleted: false, reason: 'not-found' };

    const storageConfig = this.storageRepo.getById(file.storage_config_id, true);
    if (storageConfig) {
      const adapter = this.storageFactory.createAdapter(storageConfig);
      try {
        await adapter.delete({ storageKey: file.storage_key, metadata: file.metadata });
      } catch (error) {
        // best-effort cleanup on remote storage
      }
    }

    this.fileRepo.delete(fileId);
    return { deleted: true };
  }
}

module.exports = {
  UploadService,
};
