import { createS3Client } from "../utils/s3client.js";
import { uploadToDiscord } from "../utils/discord.js";
import { hasHuggingFaceConfig, uploadToHuggingFace } from "../utils/huggingface.js";
import { hasGitHubConfig, normalizeGitHubStoragePath, uploadToGitHub } from "../utils/github.js";
import {
  buildTelegramDirectLink,
  buildTelegramBotApiUrl,
  createSignedTelegramFileId,
  getTelegramUploadMethodAndField,
  pickTelegramFileId,
  sendTelegramUploadNotice,
  shouldUseSignedTelegramLinks,
  shouldWriteTelegramMetadata,
} from "../utils/telegram.js";
import { MAX_REDIRECTS, validateRedirectLocation, validateRemoteUrl } from "../utils/ssrf-guard.js";
import { resolveUrlImportMaxSize, validateStorageSize } from "../utils/upload-limits.js";
import { checkAuthentication } from "../utils/auth.js";
import { checkGuestUpload } from "../utils/guest.js";

const FETCH_TIMEOUT = 30000;

export async function onRequestPost(context) {
  const { request, env } = context;

  // 鉴权与访客限额——对齐 Docker 端 server/app.js 的同名端点：先认证，
  // 未认证走访客限额兜底。此前 Pages 端整个裸奔（与已删除的
  // functions/api/r2/upload.js 同类）：任何人可让服务器代为拉取 URL 并
  // 写入存储，额度黑洞。size 传 0 与 chunked-upload/init.js 的用法一致
  // ——远端体积在 fetch 前未知，上限由 fetchRemote 的流式预检负责。
  const auth = await checkAuthentication(context);
  if (!auth.authenticated) {
    const guestCheck = await checkGuestUpload(request, env, 0);
    if (!guestCheck.allowed) {
      return jsonResponse({ error: guestCheck.reason }, guestCheck.status || 403);
    }
  }

  try {
    const body = await request.json();
    const url = String(body?.url || "").trim();
    const storageMode = String(body?.storageMode || "telegram").toLowerCase();
    const folderPath = normalizeFolderPath(body?.folderPath || body?.folder || "");

    if (!url) {
      return jsonResponse({ error: "请输入 URL" }, 400);
    }

    let parsedUrl;
    try {
      parsedUrl = new URL(url);
      if (!["http:", "https:"].includes(parsedUrl.protocol)) {
        return jsonResponse({ error: "仅支持 HTTP/HTTPS URL" }, 400);
      }
    } catch {
      return jsonResponse({ error: "URL 格式无效" }, 400);
    }

    const fetched = await fetchRemote(url, env);
    if (!fetched.ok) {
      return jsonResponse(
        fetched.errorCode ? { error: fetched.error, errorCode: fetched.errorCode } : { error: fetched.error },
        fetched.status || 502
      );
    }

    // The same import cap fetchRemote just enforced, restated here so the
    // error message names the real ceiling rather than a stale constant.
    const maxImportBytes = resolveUrlImportMaxSize(env);

    // A share link answers a plain GET with the platform's own page. Saving
    // those bytes stores a web page that looks like a file — the Node runtime
    // rejects it with REMOTE_CONTENT_HTML too, and the front end turns that
    // code into a resolve attempt. An explicit .html/.htm target is the one
    // deliberate exception.
    const fetchedContentType = String(fetched.contentType || "").split(";")[0].trim().toLowerCase();
    if (
      !isExplicitHtmlTarget(parsedUrl) &&
      (fetchedContentType === "text/html" || fetchedContentType === "application/xhtml+xml")
    ) {
      return jsonResponse(
        { error: "目标地址返回的是网页，不是文件。分享链接请用视频解析转存。", errorCode: "REMOTE_CONTENT_HTML" },
        415
      );
    }

    const arrayBuffer = fetched.arrayBuffer;
    const fileSize = arrayBuffer.byteLength;
    if (!fileSize) {
      return jsonResponse({ error: "Remote file is empty" }, 400);
    }
    if (fileSize > maxImportBytes) {
      return jsonResponse(
        { error: `文件过大（${formatSize(fileSize)}），最大允许 ${formatSize(maxImportBytes)}。` },
        413
      );
    }

    const storageValidation = validateStorageSize(storageMode, fileSize);
    if (!storageValidation.ok) {
      return jsonResponse({ error: storageValidation.message }, storageValidation.status);
    }

    const contentType = fetched.contentType || "application/octet-stream";
    const fileName = buildFileName(parsedUrl, contentType);
    const fileExtension = getFileExtension(fileName);

    if (storageMode === "r2") {
      if (!env.R2_BUCKET) {
        return jsonResponse({ error: "R2 未配置" }, 400);
      }
      return await uploadToR2(arrayBuffer, fileName, fileExtension, contentType, fileSize, env, folderPath);
    }

    if (storageMode === "s3") {
      if (!env.S3_ENDPOINT || !env.S3_ACCESS_KEY_ID) {
        return jsonResponse({ error: "S3 未配置" }, 400);
      }
      return await uploadToS3(arrayBuffer, fileName, fileExtension, contentType, fileSize, env, folderPath);
    }

    if (storageMode === "discord") {
      if (!env.DISCORD_WEBHOOK_URL && !env.DISCORD_BOT_TOKEN) {
        return jsonResponse({ error: "Discord 未配置" }, 400);
      }
      return await uploadToDiscordStorage(arrayBuffer, fileName, fileExtension, contentType, fileSize, env, folderPath);
    }

    if (storageMode === "huggingface") {
      if (!hasHuggingFaceConfig(env)) {
        return jsonResponse({ error: "HuggingFace 未配置" }, 400);
      }
      return await uploadToHFStorage(arrayBuffer, fileName, fileExtension, contentType, fileSize, env, folderPath);
    }

    if (storageMode === "github") {
      if (!hasGitHubConfig(env)) {
        return jsonResponse({ error: "GitHub 未配置" }, 400);
      }
      return await uploadToGitHubStorage(arrayBuffer, fileName, fileExtension, contentType, fileSize, env, folderPath);
    }

    return await uploadToTelegram(arrayBuffer, fileName, fileExtension, contentType, fileSize, env, new URL(request.url).origin, folderPath);
  } catch (error) {
    console.error("URL upload error:", error);
    return jsonResponse({ error: "服务器内部错误" }, 500);
  }
}

/**

 * SSRF-safe remote fetch: the initial URL and every redirect hop go through
 * ssrf-guard validation before any request leaves, and the body is read under
 * the import size cap instead of being buffered unconditionally. Mirrors the
 * Node runtime's server/lib/utils/remote-fetch.js semantics.
 */
async function fetchRemote(url, env) {
  const maxBytes = resolveUrlImportMaxSize(env);
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), FETCH_TIMEOUT);

  const tooLarge = () => ({
    ok: false,
    status: 413,
    error: `远程文件超过导入大小上限（${formatSize(maxBytes)}）`,
    errorCode: "FILE_TOO_LARGE",
  });
  const ssrfBlocked = () => ({
    ok: false,
    status: 403,
    error: "目标地址被 SSRF 防护拒绝",
    errorCode: "SSRF_BLOCKED",
  });

  try {
    let currentUrl = String(url);

    for (let hop = 0; hop <= MAX_REDIRECTS; hop += 1) {
      const check = validateRemoteUrl(currentUrl);
      if (!check.ok) {
        if (check.code === "INVALID_URL") {
          return { ok: false, status: 400, error: "URL 格式无效或协议不受支持" };
        }
        return ssrfBlocked();
      }

      let response;
      try {
        response = await fetch(currentUrl, {
          redirect: "manual",
          signal: controller.signal,
          headers: {
            "User-Agent": "Mozilla/5.0 YoruVault URL Uploader",
            Accept: "image/*,video/*,audio/*,application/*,*/*",
          },
        });
      } catch (error) {
        if (error.name === "AbortError") {
          return {
            ok: false,
            status: 408,
            error: "远程 URL 请求超时",
          };
        }

        return {
          ok: false,
          status: 502,
          error: `无法获取远程 URL：${error.message}`,
        };
      }

      if (response.status >= 300 && response.status < 400) {
        const location = response.headers.get("location") || "";
        if (!location) {
          return {
            ok: false,
            status: 502,
            error: "远程 URL 返回了缺少 Location 的重定向",
          };
        }
        const redirectCheck = validateRedirectLocation(location, currentUrl);
        if (!redirectCheck.ok) {
          if (redirectCheck.code === "INVALID_REDIRECT") {
            return {
              ok: false,
              status: 502,
              error: "远程 URL 返回了无效的重定向地址",
            };
          }
          if (redirectCheck.code === "INVALID_URL") {
            return { ok: false, status: 400, error: "URL 格式无效或协议不受支持" };
          }
          return ssrfBlocked();
        }
        try {
          await response.body?.cancel();
        } catch {
          // The socket may already be gone; nothing to release.
        }
        currentUrl = redirectCheck.url.href;
        continue;
      }

      if (!response.ok) {
        return {
          ok: false,
          status: 502,
          error: `远程 URL 响应异常：${response.status} ${response.statusText}`,
        };
      }

      const contentType = response.headers.get("content-type") || "application/octet-stream";

      // Declared Content-Length is a pre-check only; the streaming cap below is
      // authoritative, so a body that lies about (or omits) its length is still
      // abandoned the moment it crosses the cap.
      const declared = Number(response.headers.get("content-length"));
      if (Number.isFinite(declared) && declared > maxBytes) {
        try {
          await response.body?.cancel();
        } catch {
          // Already closed.
        }
        return tooLarge();
      }

      const reader = response.body?.getReader?.();
      if (!reader) {
        const arrayBuffer = await response.arrayBuffer();
        if (arrayBuffer.byteLength > maxBytes) return tooLarge();
        return { ok: true, contentType, arrayBuffer };
      }

      const chunks = [];
      let received = 0;
      try {
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          received += value.byteLength;
          if (received > maxBytes) return tooLarge();
          chunks.push(value);
        }
      } finally {
        try {
          await reader.cancel();
        } catch {
          // Already closed by the reader or the peer.
        }
      }

      const arrayBuffer = new Uint8Array(received);
      let offset = 0;
      for (const chunk of chunks) {
        arrayBuffer.set(chunk, offset);
        offset += chunk.byteLength;
      }

      return {
        ok: true,
        contentType,
        arrayBuffer: arrayBuffer.buffer,
      };
    }

    return ssrfBlocked();
  } finally {
    clearTimeout(timeout);
  }
}

function jsonResponse(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}


function normalizeFolderPath(value) {
  const raw = String(value || "").replace(/\\/g, "/").trim();
  const output = [];
  for (const part of raw.split("/")) {
    const piece = part.trim();
    if (!piece || piece === ".") continue;
    if (piece === "..") {
      output.pop();
      continue;
    }
    output.push(piece);
  }
  return output.join("/");
}

/** 显式指向 .html/.htm 的链接算「要抓网页」，只有这种才放行 HTML 响应。 */
function isExplicitHtmlTarget(parsedUrl) {
  try {
    return /\.html?$/i.test(String(parsedUrl && parsedUrl.pathname || ""));
  } catch {
    return false;
  }
}

function joinStoragePath(folderPath, fileName) {
  const base = normalizeFolderPath(folderPath);
  if (!base) return fileName;
  return `${base}/${fileName}`;
}

function getFileExtension(fileName) {
  const ext = String(fileName || "")
    .split(".")
    .pop()
    ?.toLowerCase()
    ?.replace(/[^a-z0-9]/g, "");
  return ext || "bin";
}

function formatSize(bytes) {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function getExtensionFromMimeType(mimeType) {
  const type = (mimeType || "").split(";")[0].trim().toLowerCase();
  const map = {
    "image/jpeg": "jpg",
    "image/jpg": "jpg",
    "image/png": "png",
    "image/gif": "gif",
    "image/webp": "webp",
    "image/bmp": "bmp",
    "image/svg+xml": "svg",
    "image/x-icon": "ico",
    "video/mp4": "mp4",
    "video/webm": "webm",
    "video/quicktime": "mov",
    "video/x-msvideo": "avi",
    "video/x-matroska": "mkv",
    "audio/mpeg": "mp3",
    "audio/wav": "wav",
    "audio/ogg": "ogg",
    "audio/flac": "flac",
    "audio/x-m4a": "m4a",
    "audio/mp4": "m4a",
    "application/pdf": "pdf",
    "application/zip": "zip",
    "application/x-rar-compressed": "rar",
    "application/x-7z-compressed": "7z",
    "text/plain": "txt",
    "application/json": "json",
  };
  return map[type] || "bin";
}

function buildFileName(parsedUrl, contentType) {
  let fileName = decodeURIComponent((parsedUrl.pathname.split("/").pop() || "").split("?")[0]);
  if (!fileName) {
    fileName = `url_${Date.now()}.${getExtensionFromMimeType(contentType)}`;
  }

  if (!fileName.includes(".")) {
    fileName = `${fileName}.${getExtensionFromMimeType(contentType)}`;
  }

  return fileName;
}

function randomId(prefix) {
  return `${prefix}_${Date.now()}_${Math.random().toString(36).substring(2, 8)}`;
}

function appendCommonMetadata(metadata, folderPath) {
  if (!folderPath) return metadata;
  return {
    ...metadata,
    folderPath,
  };
}

async function uploadToTelegram(arrayBuffer, fileName, fileExtension, contentType, fileSize, env, fallbackOrigin = "", folderPath = "") {
  const blob = new Blob([arrayBuffer], { type: contentType });
  const file = new File([blob], fileName, { type: contentType });

  const formData = new FormData();
  formData.append("chat_id", env.TG_Chat_ID);

  const { method: apiEndpoint, field } = getTelegramUploadMethodAndField(contentType);
  formData.append(field, file);

  const apiUrl = buildTelegramBotApiUrl(env, apiEndpoint);

  let response;
  try {
    response = await fetch(apiUrl, {
      method: "POST",
      body: formData,
    });
  } catch (error) {
    return jsonResponse({ error: `Telegram request failed: ${error.message}` }, 502);
  }

  const responseData = await response.json();

  if (!response.ok) {
    if (apiEndpoint === "sendAudio") {
      const docFormData = new FormData();
      docFormData.append("chat_id", env.TG_Chat_ID);
      docFormData.append("document", file);

      const docResponse = await fetch(buildTelegramBotApiUrl(env, "sendDocument"), {
        method: "POST",
        body: docFormData,
      });

      const docData = await docResponse.json();
      if (docResponse.ok) {
        return processTelegramSuccess(docData, fileName, fileExtension, contentType, fileSize, env, fallbackOrigin, folderPath);
      }
    }
    return jsonResponse({ error: responseData.description || "Telegram upload failed" }, 500);
  }

  return processTelegramSuccess(responseData, fileName, fileExtension, contentType, fileSize, env, fallbackOrigin, folderPath);
}

async function processTelegramSuccess(responseData, fileName, fileExtension, mimeType, fileSize, env, fallbackOrigin = "", folderPath = "") {
  const fileId = pickTelegramFileId(responseData);
  const messageId = responseData?.result?.message_id;

  if (!fileId) {
    return jsonResponse({ error: "Telegram 已接收文件，但未返回可用的文件 ID" }, 500);
  }

  const directId = await buildTelegramDirectId(fileId, fileExtension, fileName, mimeType, fileSize, messageId, env);

  if (env.img_url && shouldWriteTelegramMetadata(env)) {
    await env.img_url.put(`${fileId}.${fileExtension}`, "", {
      metadata: appendCommonMetadata(
        {
          TimeStamp: Date.now(),
          ListType: "None",
          Label: "None",
          liked: false,
          fileName,
          fileSize,
          storageType: "telegram",
          telegramFileId: fileId,
          telegramMessageId: messageId || undefined,
          signedLink: shouldUseSignedTelegramLinks(env),
        },
        folderPath
      ),
    });
  }

  const directLink = buildTelegramDirectLink(env, directId, fallbackOrigin);
  try {
    const noticeResult = await sendTelegramUploadNotice(
      {
        chatId: env.TG_Chat_ID,
        replyToMessageId: messageId || undefined,
        directLink,
        fileId,
        messageId,
        fileName,
        fileSize,
      },
      env
    );
    if (!noticeResult?.ok && !noticeResult?.skipped) {
      console.warn(
        "Telegram upload notice failed:",
        noticeResult?.data?.description || noticeResult?.error || "unknown error"
      );
    }
  } catch (error) {
    console.warn("Telegram upload notice error:", error.message);
  }

  return jsonResponse([{ src: `/file/${directId}` }]);
}

async function uploadToR2(arrayBuffer, fileName, fileExtension, contentType, fileSize, env, folderPath = "") {
  try {
    const fileId = randomId("r2");
    const objectKey = `${fileId}.${fileExtension}`;

    await env.R2_BUCKET.put(objectKey, arrayBuffer, {
      httpMetadata: { contentType },
      customMetadata: { fileName, uploadTime: Date.now().toString() },
    });

    if (env.img_url) {
      await env.img_url.put(`r2:${objectKey}`, "", {
        metadata: appendCommonMetadata(
          {
            TimeStamp: Date.now(),
            ListType: "None",
            Label: "None",
            liked: false,
            fileName,
            fileSize,
            storageType: "r2",
            r2Key: objectKey,
          },
          folderPath
        ),
      });
    }

    return jsonResponse([{ src: `/file/r2:${objectKey}` }]);
  } catch (error) {
    console.error("R2 upload error:", error);
    return jsonResponse({ error: `R2 upload failed: ${error.message}` }, 500);
  }
}

async function uploadToS3(arrayBuffer, fileName, fileExtension, contentType, fileSize, env, folderPath = "") {
  try {
    const s3 = createS3Client(env);
    const fileId = randomId("s3");
    const objectKey = `${fileId}.${fileExtension}`;

    await s3.putObject(objectKey, arrayBuffer, {
      contentType,
      metadata: {
        "x-amz-meta-filename": fileName,
        "x-amz-meta-uploadtime": Date.now().toString(),
      },
    });

    if (env.img_url) {
      await env.img_url.put(`s3:${objectKey}`, "", {
        metadata: appendCommonMetadata(
          {
            TimeStamp: Date.now(),
            ListType: "None",
            Label: "None",
            liked: false,
            fileName,
            fileSize,
            storageType: "s3",
            s3Key: objectKey,
          },
          folderPath
        ),
      });
    }

    return jsonResponse([{ src: `/file/s3:${objectKey}` }]);
  } catch (error) {
    console.error("S3 upload error:", error);
    return jsonResponse({ error: `S3 upload failed: ${error.message}` }, 500);
  }
}

async function uploadToDiscordStorage(arrayBuffer, fileName, fileExtension, contentType, fileSize, env, folderPath = "") {
  try {
    const result = await uploadToDiscord(arrayBuffer, fileName, contentType, env);

    if (!result.success) {
      return jsonResponse({ error: `Discord upload failed: ${result.error}` }, 500);
    }

    const fileId = randomId("discord");
    const kvKey = `discord:${fileId}.${fileExtension}`;

    if (env.img_url) {
      await env.img_url.put(kvKey, "", {
        metadata: appendCommonMetadata(
          {
            TimeStamp: Date.now(),
            ListType: "None",
            Label: "None",
            liked: false,
            fileName,
            fileSize,
            storageType: "discord",
            discordChannelId: result.channelId,
            discordMessageId: result.messageId,
            discordAttachmentId: result.attachmentId,
            discordUploadMode: result.mode,
            discordSourceUrl: result.sourceUrl,
          },
          folderPath
        ),
      });
    }

    return jsonResponse([{ src: `/file/${kvKey}` }]);
  } catch (error) {
    console.error("Discord upload error:", error);
    return jsonResponse({ error: `Discord upload failed: ${error.message}` }, 500);
  }
}

async function uploadToHFStorage(arrayBuffer, fileName, fileExtension, _contentType, fileSize, env, folderPath = "") {
  try {
    const fileId = randomId("hf");
    const hfPath = joinStoragePath(folderPath, `${fileId}.${fileExtension}`);

    const result = await uploadToHuggingFace(arrayBuffer, hfPath, fileName, env);
    if (!result.success) {
      return jsonResponse({ error: `HuggingFace upload failed: ${result.error}` }, 500);
    }

    const kvKey = `hf:${fileId}.${fileExtension}`;

    if (env.img_url) {
      await env.img_url.put(kvKey, "", {
        metadata: appendCommonMetadata(
          {
            TimeStamp: Date.now(),
            ListType: "None",
            Label: "None",
            liked: false,
            fileName,
            fileSize,
            storageType: "huggingface",
            hfPath,
          },
          folderPath
        ),
      });
    }

    return jsonResponse([{ src: `/file/${kvKey}` }]);
  } catch (error) {
    console.error("HuggingFace upload error:", error);
    return jsonResponse({ error: `HuggingFace upload failed: ${error.message}` }, 500);
  }
}

async function uploadToGitHubStorage(arrayBuffer, fileName, fileExtension, contentType, fileSize, env, folderPath = "") {
  try {
    const fileId = randomId("github");
    const publicId = `${fileId}.${fileExtension}`;
    const githubStorageKey = joinStoragePath(folderPath, publicId);

    const result = await uploadToGitHub(
      arrayBuffer,
      normalizeGitHubStoragePath(githubStorageKey),
      fileName,
      contentType || "application/octet-stream",
      env
    );

    const kvKey = `github:${publicId}`;
    if (env.img_url) {
      await env.img_url.put(kvKey, "", {
        metadata: appendCommonMetadata(
          {
            TimeStamp: Date.now(),
            ListType: "None",
            Label: "None",
            liked: false,
            fileName,
            fileSize,
            storageType: "github",
            githubStorageKey: normalizeGitHubStoragePath(result.storagePath || githubStorageKey),
            ...(result.metadata || {}),
          },
          folderPath
        ),
      });
    }

    return jsonResponse([{ src: `/file/${kvKey}` }]);
  } catch (error) {
    console.error("GitHub upload error:", error);
    return jsonResponse({ error: `GitHub upload failed: ${error.message}` }, 500);
  }
}

async function buildTelegramDirectId(fileId, fileExtension, fileName, mimeType, fileSize, messageId, env) {
  if (!shouldUseSignedTelegramLinks(env)) {
    return `${fileId}.${fileExtension}`;
  }
  return createSignedTelegramFileId(
    {
      fileId,
      fileExtension,
      fileName,
      mimeType,
      fileSize,
      messageId,
    },
    env
  );
}
