/**
 * Pages 运行时的上传上限单一来源。
 *
 * 这里的数字曾经散落三处各自维护：status.js 的 getUploadLimits（下发给
 * 前端做直传校验）、upload-from-url.js 的 validateStorageSize（转存校验）
 * 和 MAX_FILE_SIZE 常量。三处一旦有一处漂移，用户就会看到「直传说上限
 * 25MB、转存却拉完整个文件才失败」——同一个后端不该因为上传方式不同
 * 而有不同的上限。status 与 upload-from-url 必须引用同一份。
 *
 * Node 运行时（server/app.js 的 getUploadLimits）从 config 派生同类信息，
 * 数值随部署形态不同（Telegram 在 Pages 上走网页 API 固定 20MB），两套
 * 运行时各自单一来源，不跨运行时共享。
 */
export const MB = 1024 * 1024;
export const DIRECT_UPLOAD_THRESHOLD = 20 * MB;
export const CHUNK_UPLOAD_LIMIT = 100 * MB;

/**
 * URL 导入的内存上限，与 Docker 端 resolveUrlImportMaxSize 语义一致：
 * 显式 URL_IMPORT_MAX_SIZE 优先，缺省回落 UPLOAD_MAX_SIZE，再缺省 100MB。
 * 回落关系意味着不显式设置时，转存与直传共享同一个全局上限。
 */
export function resolveUrlImportMaxSize(env) {
  const explicit = Number(env?.URL_IMPORT_MAX_SIZE);
  if (Number.isFinite(explicit) && explicit > 0) return explicit;
  const uploadCap = Number(env?.UPLOAD_MAX_SIZE);
  if (Number.isFinite(uploadCap) && uploadCap > 0) return uploadCap;
  return CHUNK_UPLOAD_LIMIT;
}

/**
 * 每个存储后端的上限矩阵（Pages 形态）。
 *
 * telegram 的 20MB 是 Cloudflare Workers 上 Telegram 网页上传的平台限制，
 * 与 Docker 端（云 Bot API 50MB / 自建 --local 2GB）不同源也不同值。
 * discord / huggingface 是对方平台的固定限制。
 */
export function getUploadLimits() {
  return {
    telegram: {
      maxBytes: DIRECT_UPLOAD_THRESHOLD,
      directThreshold: DIRECT_UPLOAD_THRESHOLD,
      supportsChunkUpload: false,
      message: 'Cloudflare Pages 上的 Telegram 网页上传限制为 20MB。较大的浏览器上传请使用 R2、S3 或 GitHub，或直接把文件发到 Telegram 后使用 Webhook 回链。',
    },
    r2: {
      maxBytes: CHUNK_UPLOAD_LIMIT,
      directThreshold: DIRECT_UPLOAD_THRESHOLD,
      supportsChunkUpload: true,
    },
    s3: {
      maxBytes: CHUNK_UPLOAD_LIMIT,
      directThreshold: DIRECT_UPLOAD_THRESHOLD,
      supportsChunkUpload: true,
    },
    discord: {
      maxBytes: 25 * MB,
      directThreshold: DIRECT_UPLOAD_THRESHOLD,
      supportsChunkUpload: true,
      message: 'Discord 上传上限受服务器加成影响，YoruVault 默认按 25MB 保守处理。',
    },
    huggingface: {
      maxBytes: 35 * MB,
      directThreshold: DIRECT_UPLOAD_THRESHOLD,
      supportsChunkUpload: true,
      message: 'HuggingFace 上传在 YoruVault 中按 35MB 封顶，更大的文件请使用 R2、S3 或 GitHub。',
    },
    github: {
      maxBytes: CHUNK_UPLOAD_LIMIT,
      directThreshold: DIRECT_UPLOAD_THRESHOLD,
      supportsChunkUpload: true,
    },
  };
}

/**
 * 转存前的后端上限校验：与直传共用 getUploadLimits 的同一份数字，
 * 使「同一后端、同一文件」在直传与转存两条路径上得到同一个答案。
 */
export function validateStorageSize(storageMode, fileSize) {
  const limit = getUploadLimits()[storageMode];
  if (limit && fileSize > limit.maxBytes) {
    return { ok: false, status: 413, message: limit.message };
  }
  return { ok: true };
}