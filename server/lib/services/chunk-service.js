const fs = require('node:fs');
const path = require('node:path');
const { Readable } = require('node:stream');
const { run, get, all } = require('../../db');
const { normalizeFolderPath } = require('../repos/file-repo');

class ChunkUploadService {
  constructor({ db, config, uploadService }) {
    this.db = db;
    this.config = config;
    this.uploadService = uploadService;
    this.ensureSchema();
    fs.mkdirSync(this.config.chunkDir, { recursive: true });
    this.sweepOrphanChunks();
  }

  // A failed complete() skips cleanupTask, so the parts stay on disk forever —
  // the 1h expiry is only enforced when a client asks about that same upload
  // again, which never happens for an abandoned one. At startup, drop every task
  // dir whose DB row is gone or already expired.
  sweepOrphanChunks() {
    let entries = [];
    try {
      entries = fs.readdirSync(this.config.chunkDir, { withFileTypes: true });
    } catch {
      return;
    }

    let removed = 0;
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      const uploadId = entry.name;
      const task = get(this.db, 'SELECT expires_at FROM chunk_uploads WHERE upload_id = ?', [uploadId]);
      if (task && Number(task.expires_at) > Date.now()) continue;
      try {
        fs.rmSync(path.join(this.config.chunkDir, uploadId), { recursive: true, force: true });
        if (task) run(this.db, 'DELETE FROM chunk_uploads WHERE upload_id = ?', [uploadId]);
        removed += 1;
      } catch {
        // Leave it behind; the next startup tries again.
      }
    }
    if (removed > 0) {
      console.log(`[k-vault] chunk-upload: swept ${removed} stale upload dir(s) at startup.`);
    }
  }

  ensureSchema() {
    const columns = all(this.db, 'PRAGMA table_info(chunk_uploads)');
    const hasFolderPath = columns.some((column) => column.name === 'folder_path');
    if (!hasFolderPath) {
      run(this.db, `ALTER TABLE chunk_uploads ADD COLUMN folder_path TEXT NOT NULL DEFAULT ''`);
    }
  }

  initTask({ fileName, fileSize, fileType, totalChunks, storageMode, storageId, folderPath }) {
    const uploadId = `${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 10)}`;
    const now = Date.now();
    const expiresAt = now + 60 * 60 * 1000;
    const normalizedFolderPath = normalizeFolderPath(folderPath);

    run(
      this.db,
      `INSERT INTO chunk_uploads(
         upload_id, file_name, file_size, file_type, total_chunks,
         storage_mode, storage_config_id, folder_path, created_at, expires_at
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        uploadId,
        fileName,
        fileSize,
        fileType || 'application/octet-stream',
        totalChunks,
        storageMode || null,
        storageId || null,
        normalizedFolderPath,
        now,
        expiresAt,
      ]
    );

    fs.mkdirSync(this.taskDir(uploadId), { recursive: true });

    return {
      uploadId,
      chunkSize: this.config.chunkSize,
      expiresAt,
    };
  }

  getTask(uploadId) {
    const task = get(this.db, 'SELECT * FROM chunk_uploads WHERE upload_id = ?', [uploadId]);
    if (!task) return null;
    if (Date.now() > task.expires_at) {
      this.cleanupTask(uploadId);
      return null;
    }
    return task;
  }

  taskDir(uploadId) {
    return path.join(this.config.chunkDir, uploadId);
  }

  chunkPath(uploadId, chunkIndex) {
    return path.join(this.taskDir(uploadId), `${Number(chunkIndex)}.part`);
  }

  saveChunk({ uploadId, chunkIndex, buffer }) {
    const task = this.getTask(uploadId);
    if (!task) {
      throw new Error('Upload task not found or expired.');
    }

    fs.mkdirSync(this.taskDir(uploadId), { recursive: true });
    fs.writeFileSync(this.chunkPath(uploadId, chunkIndex), Buffer.from(buffer));

    return {
      success: true,
      chunkIndex,
    };
  }

  async complete(uploadId) {
    const task = this.getTask(uploadId);
    if (!task) {
      throw new Error('Upload task not found or expired.');
    }

    const totalChunks = Number(task.total_chunks || 0);
    if (!Number.isFinite(totalChunks) || totalChunks <= 0) {
      throw new Error('Invalid chunk task metadata.');
    }

    // The real on-disk total is authoritative: the size the client declared at
    // init is advisory, and Telegram refuses a multipart whose Content-Length
    // disagrees with the bytes actually sent. (Adding the declared size on top of
    // the part sizes was the bug that produced UND_ERR_REQ_CONTENT_LENGTH_MISMATCH.)
    let fileSize = 0;
    const parts = [];
    for (let i = 0; i < totalChunks; i += 1) {
      const chunkFile = this.chunkPath(uploadId, i);
      if (!fs.existsSync(chunkFile)) {
        throw new Error(`Chunk ${i} is missing.`);
      }
      fileSize += fs.statSync(chunkFile).size;
      parts.push(chunkFile);
    }

    // The parts are already on disk, so the assembled file is simply their bytes
    // in order. Streaming them one after another is byte-identical to
    // Buffer.concat, but never materialises the whole file on the heap — which is
    // what used to make every >20MB web upload cost ~4x its size in RAM.
    const openStream = () => Readable.from((async function* streamParts() {
      for (const part of parts) {
        const stream = fs.createReadStream(part);
        for await (const chunk of stream) yield chunk;
      }
    })());

    const result = await this.uploadService.uploadStream({
      openStream,
      fileSize,
      fileName: task.file_name,
      mimeType: task.file_type,
      storageMode: task.storage_mode,
      storageId: task.storage_config_id,
      folderPath: normalizeFolderPath(task.folder_path),
    });

    this.cleanupTask(uploadId);

    return result;
  }

  cleanupTask(uploadId) {
    run(this.db, 'DELETE FROM chunk_uploads WHERE upload_id = ?', [uploadId]);

    const dir = this.taskDir(uploadId);
    if (fs.existsSync(dir)) {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  }
}

module.exports = {
  ChunkUploadService,
};
