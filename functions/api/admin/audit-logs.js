import { listAuditLogs } from '../../utils/audit.js';
import { apiError, apiSuccess, parsePositiveInt } from '../../utils/api-v1.js';

/**
 * 审计日志读取端点（requirement #12）—— Cloudflare Pages 端。
 *
 * 与 Docker 端 server/app.js 的 GET /api/admin/audit-logs 是同一份契约：
 *   - 鉴权由本目录的 _middleware.js 统一兜底（fail-closed，本文件不重复做）
 *   - limit 语义相同：默认 100，min 1，max 500，非法输入回默认值
 *   - 记录字段相同：event / tokenId / operation / timestamp / success /
 *     client / detail（success 两端都是布尔）
 *   - 响应包装相同：{ success: true, logs: [...] }，按 timestamp 倒序
 *
 * 此前两端只有写入对齐（audit:* KV / audit_logs SQLite），读取端点只在
 * Docker 端存在——Pages 部署的审计事件写进 KV 后没有任何 API 途径读回，
 * 与 openapi.yaml 自我声明的 parity contract 相悖。本文件补上缺的那半。
 */
export async function onRequest(context) {
  const { request, env } = context;

  if (request.method === 'OPTIONS') {
    return new Response(null, { status: 204 });
  }

  if (request.method !== 'GET') {
    return apiError('METHOD_NOT_ALLOWED', 'Method not allowed.', 405);
  }

  const limit = parsePositiveInt(new URL(request.url).searchParams.get('limit'), {
    defaultValue: 100,
    min: 1,
    max: 500,
  });

  const logs = await listAuditLogs(env, { limit });
  return apiSuccess({ logs });
}
