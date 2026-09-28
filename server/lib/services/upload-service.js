const { buildPublicFileId, normalizeStorageType } = require('../storage/common');
const { normalizeFolderPath } = require('../repos/file-repo');

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

// The remote body is accumulated on the heap, so the cap has to be enforced
// while reading rather than after it: pulling a 1GB file only to reject it would
// already have cost a gigabyte. Mirrors the streaming import in app.js.
// Note the per-chunk copy: handing out a view would alias the runtime's buffer,
// and a silent aliasing bug is far worse than one transient 64KB copy.
async function readBodyWithCap(response, maxBytes, buildError) {
  if (!response.body) return Buffer.alloc(0);

  const reader = response.body.getReader();
  const chunks = [];
  let received = 0;

  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      received += value.byteLength;
      if (received > maxBytes) throw buildError();
      chunks.push(Buffer.from(value));
    }
  } finally {
    try {
      await reader.cancel();
    } catch {
      // Already closed by the reader or the peer.
    }
  }

  return Buffer.concat(chunks);
}

class UploadService {
  constructor({ storageRepo, fileRepo, storageFactory }) {
    this.storageRepo = storageRepo;
    this.fileRepo = fileRepo;
    this.storageFactory = storageFactory;
  }

  resolveStorage({ storageId, storageMode }) {
    const storageConfig = this.storageRepo.resolveStorageSelection({ storageId, storageMode });
    if (!storageConfig) {
      throw new Error('没有可用的存储配置。');
    }
    return storageConfig;
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
    const storageType = normalizeStorageType(storageConfig.type);
    const normalizedFolderPath = normalizeFolderPath(folderPath);

    const publicId = buildPublicFileId(storageType, fileName, mimeType);

    let adapterStorageKey = normalizedFolderPath ? `${normalizedFolderPath}/${publicId}` : publicId;
    if (storageType === 'huggingface') {
      adapterStorageKey = normalizedFolderPath
        ? `uploads/${normalizedFolderPath}/${publicId}`
        : `uploads/${publicId}`;
    }

    const uploadResult = await adapter.upload({
      storageKey: adapterStorageKey,
      fileName,
      mimeType,
      fileSize,
      buffer,
    });

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

  async uploadFromUrl({
    url,
    storageId,
    storageMode,
    folderPath,
    maxBytes = 20 * 1024 * 1024,
    headers = null,
    timeoutMs = 30000,
  }) {
    const parsedUrl = new URL(url);
    if (!['http:', 'https:'].includes(parsedUrl.protocol)) {
      throw new Error('仅支持 HTTP/HTTPS URL。');
    }

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), Math.max(1000, Number(timeoutMs) || 30000));
    let response;

    try {
      response = await fetch(url, {
        signal: controller.signal,
        headers: {
          'User-Agent': 'K-Vault/2.0 (+https://github.com/katelya77/K-Vault)',
          Accept: '*/*',
          ...normalizeRequestHeaders(headers),
        },
      });
    } finally {
      clearTimeout(timeout);
    }

    if (!response.ok) {
      throw new Error(`目标 URL 响应异常：${response.status}。`);
    }

    const contentType = response.headers.get('content-type') || 'application/octet-stream';
    const limitText = `${Math.floor(maxBytes / 1024 / 1024)}MB`;
    // Carries an explicit status so the error classifier reports a size problem
    // (413 / QUOTA_EXCEEDED) instead of falling through to a retriable 502.
    const tooLarge = () => {
      const error = new Error(`远程文件超过大小限制（${limitText}）。`);
      error.status = 413;
      return error;
    };

    // Reject on the advertised length before reading a single byte. The body is
    // buffered here and the storage adapter copies it again, so buffering first
    // and checking afterwards costs several times the file size for nothing.
    const declared = Number(response.headers.get('content-length'));
    if (Number.isFinite(declared) && declared > maxBytes) {
      try {
        await response.body?.cancel();
      } catch {
        // The socket may already be gone.
      }
      throw tooLarge();
    }

    // A body that lies about (or omits) Content-Length still cannot push the
    // heap past the cap: the read is abandoned the moment the total crosses it.
    const bytes = await readBodyWithCap(response, maxBytes, tooLarge);

    if (bytes.byteLength === 0) {
      throw new Error('目标 URL 返回了空文件。');
    }

    let fileName = decodeURIComponent(parsedUrl.pathname.split('/').pop() || '').trim();
    if (!fileName) {
      fileName = `url_${Date.now()}`;
    }

    if (!fileName.includes('.')) {
      const ext = String(contentType).split('/')[1]?.split(';')[0] || 'bin';
      fileName = `${fileName}.${ext}`;
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
