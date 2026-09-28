const { buildPublicFileId, normalizeStorageType } = require('../storage/common');
const { normalizeFolderPath } = require('../repos/file-repo');
const { fetchRemote, readBodyWithLimit } = require('../utils/remote-fetch');

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
        'User-Agent': 'K-Vault/2.0 (+https://github.com/katelya77/K-Vault)',
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

    // Enforces the cap while reading: an oversize body is refused on its declared
    // length before allocation, and abandoned mid-read if the length lied.
    const bytes = await readBodyWithLimit(response, maxBytes, tooLarge);

    if (bytes.byteLength === 0) {
      const error = new Error('目标 URL 返回了空文件。');
      error.code = 'REMOTE_FILE_EMPTY';
      error.status = 422;
      throw error;
    }

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
