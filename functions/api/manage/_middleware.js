import { 
  checkAuthentication,
  isAuthRequired 
} from '../../utils/auth.js';
import { apiError } from '../../utils/api-v1.js';

// 会话端点不要求已认证：登录/登出/状态检查是认证流程本身的一部分。
const SESSION_ENDPOINTS = new Set(['login', 'logout', 'check']);

function isSessionEndpoint(pathname) {
  const segment = String(pathname || '').replace(/^\/api\/manage\/?/, '').split('/')[0];
  return SESSION_ENDPOINTS.has(segment);
}

async function errorHandling(context) {
    try {
      return await context.next();
    } catch (err) {
      // The full error stays in server-side logs; the client only gets a
      // generic message so stacks and internal paths are never disclosed.
      console.error('[manage] unhandled error:', err);
      return new Response('服务器内部错误', { status: 500 });
    }
  }

  function UnauthorizedException(reason) {
    return new Response(reason, {
        status: 401,
        statusText: 'Unauthorized',
        headers: {
          'Content-Type': 'text/plain;charset=UTF-8',
          'Cache-Control': 'no-store',
          'Content-Length': reason.length,
        },
      });
  }
  
  function BadRequestException(reason) {
    return new Response(reason, {
        status: 400,
        statusText: 'Bad Request',
        headers: {
          'Content-Type': 'text/plain;charset=UTF-8',
          'Cache-Control': 'no-store',
          'Content-Length': reason.length,
        },
      });
  }
  
  
  async function authentication(context) {
    // 检查 KV 是否绑定（提示性响应：无 KV 绑定的部署没有面板数据可言，
    // 保留既有的提示行为；这不是授权放行，后续端点无数据可操作）
    if (typeof context.env.img_url == "undefined" || context.env.img_url == null || context.env.img_url == "") {
        return new Response('Dashboard is disabled. Please bind a KV namespace to use this feature.', { status: 200 });
    }

    // 会话管理端点（login/logout/check）不要求已认证
    if (isSessionEndpoint(new URL(context.request.url).pathname)) {
        return context.next();
    }

    // fail closed（SEC-03）：认证未配置时管理面板拒绝服务，与 /api/admin/**
    // 的 ADMIN_AUTH_NOT_CONFIGURED 语义一致。manage 目录含 delete/editName/
    // toggleLike/block/white/move-folder 等写操作端点，公开模式下匿名可调用
    // 属配置错误，应拒绝服务而非放行。
    if (!isAuthRequired(context.env)) {
        return apiError(
            'ADMIN_AUTH_NOT_CONFIGURED',
            'Manage API requires BASIC_USER and BASIC_PASS to be configured. Manage endpoints fail closed when no admin credential is set.',
            503
        );
    }

    // 使用统一的认证检查（支持 Cookie session 和 Basic Auth）
    const authResult = await checkAuthentication(context);
    
    if (authResult.authenticated) {
        return context.next();
    }
    
    // 认证失败，返回 401
    return new Response('You need to login.', {
        status: 401,
        headers: {
          'Content-Type': 'text/plain;charset=UTF-8',
          'Cache-Control': 'no-store',
        },
      });
  }
  
  export const onRequest = [errorHandling, authentication];