import { createS3Client } from '../utils/s3client.js';
import { checkDiscordConnection } from '../utils/discord.js';
import { checkHuggingFaceConnection, hasHuggingFaceConfig } from '../utils/huggingface.js';
import { checkGitHubConnection, hasGitHubConfig } from '../utils/github.js';
import { getGuestConfig } from '../utils/guest.js';
import { buildTelegramBotApiUrl, getTelegramApiBase } from '../utils/telegram.js';
import { getUploadLimits } from '../utils/upload-limits.js';

/**
 * 单个后端探测的上限。
 *
 * 这个端点会同时打 Telegram / GitHub / HuggingFace / Discord / S3，其中
 * 几个是跨境请求，底下用 Promise.allSettled 汇总意味着**响应延迟取所有探测
 * 的最大值**。而这些 fetch 原本一个超时都没有：任一上游挂住，响应就一直
 * 挂着，直到平台自己掐断——曾经有一次未加超时的跨境拉取把每个请求拖到
 * 182 秒（见 functions/utils/middleware.js 里 telemetry 采样率那次修复）。
 *
 * 现在这个面板是四个分区页顶栏的常驻入口，所以必须有上限。
 */
const PROBE_TIMEOUT_MS = 5000;

/**
 * 给单个探测套上限。
 *
 * 超时后把该后端写成「超时」而不是让它停在 "Not configured"——后者对
 * 一个已配置只是没连上的后端是误导，用户会去检查环境变量，而真正的原因
 * 是对端没回话。
 *
 * 只是**不再等**它，没有真的取消底层请求：多数探测走的是 utils 里现成的
 * check*Connection()，不接收 AbortSignal，强行传入要改四个工具模块，
 * 超出这次改动的范围。已经发了的请求让它自己结束，对响应没有影响。
 */
function withProbeTimeout(key, promise, status) {
  let timer = null;
  const timeout = new Promise((resolve) => {
    timer = setTimeout(() => {
      status[key] = {
        ...(status[key] || {}),
        connected: false,
        message: `检查超时（${PROBE_TIMEOUT_MS / 1000}s）`,
      };
      resolve();
    }, PROBE_TIMEOUT_MS);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

function defaultStatusItem({ layer = 'direct' } = {}) {
  return {
    connected: false,
    enabled: false,
    configured: false,
    layer,
    message: 'Not configured',
  };
}

function storageCapability(type, label, layer = 'direct') {
  return {
    type,
    label,
    layer,
    enableHint: 'Configure this storage backend first.',
  };
}

export async function onRequestGet(context) {
  const { env } = context;

  const status = {
    telegram: defaultStatusItem({ layer: 'direct' }),
    kv: { connected: false, enabled: false, configured: false, layer: 'direct', message: 'Not configured' },
    r2: defaultStatusItem({ layer: 'direct' }),
    s3: defaultStatusItem({ layer: 'direct' }),
    discord: defaultStatusItem({ layer: 'direct' }),
    huggingface: defaultStatusItem({ layer: 'direct' }),
    github: defaultStatusItem({ layer: 'direct' }),
    auth: { enabled: false, message: 'Disabled' },
    guestUpload: getGuestConfig(env),
    uploadLimits: getUploadLimits(),
    capabilities: [
      storageCapability('telegram', 'Telegram', 'direct'),
      storageCapability('r2', 'R2', 'direct'),
      storageCapability('s3', 'S3', 'direct'),
      storageCapability('discord', 'Discord', 'direct'),
      storageCapability('huggingface', 'HuggingFace', 'direct'),
      storageCapability('github', 'GitHub', 'direct'),
    ],
  };

  const checks = [];

  if (env.TG_Bot_Token && env.TG_Chat_ID) {
    status.telegram.configured = true;
    checks.push(
      withProbeTimeout('telegram', fetch(buildTelegramBotApiUrl(env, 'getMe'))
        .then((res) => res.json())
        .then((data) => {
          if (data?.ok) {
            status.telegram = {
              connected: true,
              enabled: true,
              configured: true,
              layer: 'direct',
              message: `Connected: @${data.result.username}`,
              botName: data.result.first_name,
              botUsername: data.result.username,
              apiBase: getTelegramApiBase(env),
            };
          } else {
            status.telegram = {
              connected: false,
              enabled: true,
              configured: true,
              layer: 'direct',
              message: data?.description || 'Telegram API check failed',
            };
          }
        })
        .catch((error) => {
          status.telegram = {
            connected: false,
            enabled: true,
            configured: true,
            layer: 'direct',
            message: error.message || 'Telegram API check failed',
          };
        }), status)
    );
  }

  if (env.img_url) {
    status.kv.configured = true;
    checks.push(
      withProbeTimeout('kv', env.img_url.list({ limit: 1 })
        .then((result) => {
          status.kv = {
            connected: true,
            enabled: true,
            configured: true,
            layer: 'direct',
            message: 'Connected',
            hasData: Array.isArray(result?.keys) && result.keys.length > 0,
          };
        })
        .catch((error) => {
          status.kv = {
            connected: false,
            enabled: false,
            configured: true,
            layer: 'direct',
            message: error.message || 'KV check failed',
          };
        }), status)
    );
  }

  if (env.R2_BUCKET) {
    status.r2.configured = true;
    checks.push(
      withProbeTimeout('r2', env.R2_BUCKET.list({ limit: 1 })
        .then((result) => {
          status.r2 = {
            connected: true,
            enabled: true,
            configured: true,
            layer: 'direct',
            message: 'Connected',
            hasData: Array.isArray(result?.objects) && result.objects.length > 0,
          };
        })
        .catch((error) => {
          status.r2 = {
            connected: false,
            enabled: true,
            configured: true,
            layer: 'direct',
            message: error.message || 'R2 check failed',
          };
        }), status)
    );
  }

  if (env.S3_ENDPOINT && env.S3_ACCESS_KEY_ID && env.S3_SECRET_ACCESS_KEY && env.S3_BUCKET) {
    status.s3.configured = true;
    checks.push(
      withProbeTimeout('s3', (async () => {
        try {
          const s3 = createS3Client(env);
          const connected = await s3.checkConnection();
          status.s3 = {
            connected,
            enabled: connected,
            configured: true,
            layer: 'direct',
            message: connected ? `Connected: ${env.S3_BUCKET}` : 'S3 check failed',
          };
        } catch (error) {
          status.s3 = {
            connected: false,
            enabled: true,
            configured: true,
            layer: 'direct',
            message: error.message || 'S3 check failed',
          };
        }
      })(), status)
    );
  }

  if (env.DISCORD_WEBHOOK_URL || env.DISCORD_BOT_TOKEN) {
    status.discord.configured = true;
    checks.push(
      withProbeTimeout('discord', checkDiscordConnection(env)
        .then((result) => {
          status.discord = {
            connected: Boolean(result?.connected),
            enabled: Boolean(result?.connected),
            configured: true,
            layer: 'direct',
            message: result?.connected
              ? `Connected (${result.mode || 'unknown'})`
              : 'Discord check failed',
            mode: result?.mode,
          };
        })
        .catch((error) => {
          status.discord = {
            connected: false,
            enabled: true,
            configured: true,
            layer: 'direct',
            message: error.message || 'Discord check failed',
          };
        }), status)
    );
  }

  if (hasHuggingFaceConfig(env)) {
    status.huggingface.configured = true;
    checks.push(
      withProbeTimeout('huggingface', checkHuggingFaceConnection(env)
        .then((result) => {
          status.huggingface = {
            connected: Boolean(result?.connected),
            enabled: Boolean(result?.connected),
            configured: true,
            layer: 'direct',
            message: result?.connected
              ? `Connected: ${result.repoId}${result.isPrivate ? ' (private)' : ''}`
              : (result?.error || 'HuggingFace check failed'),
          };
        })
        .catch((error) => {
          status.huggingface = {
            connected: false,
            enabled: true,
            configured: true,
            layer: 'direct',
            message: error.message || 'HuggingFace check failed',
          };
        }), status)
    );
  }

  if (hasGitHubConfig(env)) {
    status.github.configured = true;
    checks.push(
      withProbeTimeout('github', checkGitHubConnection(env)
        .then((result) => {
          status.github = {
            connected: Boolean(result?.connected),
            enabled: Boolean(result?.connected),
            configured: true,
            layer: 'direct',
            message: result?.connected ? 'Connected' : (result?.message || 'GitHub check failed'),
            mode: result?.mode,
            status: result?.status,
            detail: result?.detail,
          };
        })
        .catch((error) => {
          status.github = {
            connected: false,
            enabled: true,
            configured: true,
            layer: 'direct',
            message: error.message || 'GitHub check failed',
          };
        }), status)
    );
  }

  if (env.BASIC_USER && env.BASIC_PASS) {
    status.auth = {
      enabled: true,
      message: 'Enabled',
    };
  }

  await Promise.allSettled(checks);

  return new Response(JSON.stringify(status, null, 2), {
    headers: {
      'Content-Type': 'application/json',
      'Cache-Control': 'no-cache',
     },
   });
}

