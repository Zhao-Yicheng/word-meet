// 阿里云 ESA 边缘函数（EdgeRoutine）——同词相遇整个应用都跑在这里。
// 路由：POST /api/room 走房间协议（房间状态存 Tablestore/OTS）；其余路径返回内联的静态网页资源。
// 部署：由 scripts/buildesa.mjs 把本文件、server/protocol.mjs、edge/ots.mjs 与 dist/ 静态资源
// 打包成单个 dist/esa/worker.js，Git 推送后由 ESA「函数和Pages」自动构建部署。
// 密钥不进仓库：由 ESA 控制台「函数变量」（可加密存储）注入，运行时从 env 读取。

import { createRoomApi } from '../server/protocol.mjs';
import { createOtsStore } from './ots.mjs';
import indexHtml from '../dist/index.html';
import mainJs from '../dist/src/main.js';
import gameJs from '../dist/src/game.js';
import roomJs from '../dist/src/room.js';
import configJs from '../dist/src/config.js';
import styleCss from '../dist/src/style.css';
import faviconSvg from '../dist/favicon.svg';

const MAX_API_BYTES = 4096;
const CORS_HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type',
  'Access-Control-Max-Age': '86400',
};

const ASSETS = new Map([
  ['/', { body: indexHtml, type: 'text/html; charset=utf-8', cache: 'no-cache' }],
  ['/index.html', { body: indexHtml, type: 'text/html; charset=utf-8', cache: 'no-cache' }],
  ['/src/main.js', { body: mainJs, type: 'text/javascript; charset=utf-8', cache: 'public, max-age=31536000, immutable' }],
  ['/src/game.js', { body: gameJs, type: 'text/javascript; charset=utf-8', cache: 'public, max-age=31536000, immutable' }],
  ['/src/room.js', { body: roomJs, type: 'text/javascript; charset=utf-8', cache: 'public, max-age=31536000, immutable' }],
  ['/src/config.js', { body: configJs, type: 'text/javascript; charset=utf-8', cache: 'public, max-age=31536000, immutable' }],
  ['/src/style.css', { body: styleCss, type: 'text/css; charset=utf-8', cache: 'public, max-age=31536000, immutable' }],
  ['/favicon.svg', { body: faviconSvg, type: 'image/svg+xml', cache: 'public, max-age=3600' }],
]);

// 函数变量可能作为 fetch 的第二个参数传入，也可能挂在全局上，两种写法都兼容。
function resolveEnv(env) {
  if (env && typeof env === 'object' && Object.keys(env).length > 0) return env;
  const scope = typeof globalThis !== 'undefined' ? globalThis : {};
  if (scope.env && typeof scope.env === 'object') return scope.env;
  if (scope.__ENV && typeof scope.__ENV === 'object') return scope.__ENV;
  return {};
}

// 房间状态存在 Tablestore：单表 rooms，主键 code(STRING)，列 data 存整份房间 JSON。
// 强一致读、几十毫秒级延迟，替代最终一致的边缘 KV。
function buildStore(env) {
  const config = {
    endpoint: env.OTS_ENDPOINT,
    instance: env.OTS_INSTANCE,
    accessKeyId: env.OTS_ACCESS_KEY_ID,
    accessKeySecret: env.OTS_ACCESS_KEY_SECRET,
    table: env.OTS_TABLE || 'rooms',
  };
  if (!config.endpoint || !config.instance || !config.accessKeyId || !config.accessKeySecret) {
    return null;
  }
  return createOtsStore(config);
}

function utf8Length(text) {
  return typeof TextEncoder === 'function' ? new TextEncoder().encode(text).length : text.length;
}

function json(body, status = 200, extra = {}) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json; charset=utf-8', ...CORS_HEADERS, ...extra },
  });
}

function describeError(error) {
  const code = error && error.code ? error.code : '';
  const message = error && error.message ? error.message : String(error);
  return `${code} ${message}`.trim().slice(0, 200);
}

async function handleApi(request, env) {
  if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: CORS_HEADERS });
  if (request.method !== 'POST') return json({ code: 'PT405', message: '请使用 POST 调用房间接口' }, 405);
  let text = '';
  try { text = await request.text(); }
  catch { return json({ code: 'PT400', message: '请求格式无效' }, 400); }
  if (utf8Length(text) > MAX_API_BYTES) return json({ code: 'PT413', message: '请求内容过长' }, 413);
  let body = null;
  try { body = JSON.parse(text); }
  catch { return json({ code: 'PT400', message: '请求格式无效' }, 400); }

  const store = buildStore(env);

  // 诊断动作：只回报变量是否存在、存储是否连通，绝不回显密钥内容。
  if (body.action === 'diagnose') {
    const report = {
      envKeys: Object.keys(env || {}).length,
      hasEndpoint: Boolean(env.OTS_ENDPOINT),
      hasInstance: Boolean(env.OTS_INSTANCE),
      hasAccessKeyId: Boolean(env.OTS_ACCESS_KEY_ID),
      hasAccessKeySecret: Boolean(env.OTS_ACCESS_KEY_SECRET),
      storeReady: Boolean(store),
    };
    if (store) {
      const started = Date.now();
      try {
        await store.get('__diagnose__');
        report.readOk = true;
      } catch (error) {
        report.readOk = false;
        report.readError = describeError(error);
      }
      report.readMs = Date.now() - started;
    }
    return json(report);
  }

  if (!store) return json({ code: 'PT503', message: '房间存储未配置，请检查函数变量' }, 503);

  try {
    const reply = await createRoomApi(store, { verifyWrites: false }).handle(body, utf8Length(text));
    return json(reply.body, reply.status);
  } catch (error) {
    const debug = env.OTS_DEBUG === '1' ? describeError(error) : undefined;
    return json({ code: 'PT500', message: '房间服务暂时不可用，请稍后重试', debug }, 500);
  }
}

function serveAsset(url) {
  const asset = ASSETS.get(url.pathname);
  if (!asset) return new Response('Not Found', { status: 404, headers: { 'Content-Type': 'text/plain; charset=utf-8' } });
  return new Response(asset.body, {
    headers: { 'Content-Type': asset.type, 'Cache-Control': asset.cache, 'X-Content-Type-Options': 'nosniff' },
  });
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (url.pathname === '/api/room') return handleApi(request, resolveEnv(env));
    return serveAsset(url);
  },
};
