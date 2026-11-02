// 阿里云 ESA 边缘函数（EdgeRoutine）——同词相遇整个应用都跑在这里。
// 路由：POST /api/room 走房间协议（EdgeKV 存储）；其余路径返回内联的静态网页资源。
// 部署：由 scripts/buildesa.mjs 把本文件和 server/protocol.mjs、dist/ 静态资源
// 打包成单个 dist/esa/worker.js，粘贴到 ESA 控制台「函数和Pages」的代码编辑器即可。

import { createRoomApi } from '../server/protocol.mjs';
import indexHtml from '../dist/index.html';
import mainJs from '../dist/src/main.js';
import gameJs from '../dist/src/game.js';
import roomJs from '../dist/src/room.js';
import configJs from '../dist/src/config.js';
import styleCss from '../dist/src/style.css';
import faviconSvg from '../dist/favicon.svg';

const KV_NAMESPACE = 'word-meet'; // 需先在 ESA 控制台「边缘计算和 AI > KV存储」创建同名空间
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

function edgeStore() {
  const kv = new EdgeKV({ namespace: KV_NAMESPACE });
  return {
    get: (key) => kv.get(key, { type: 'text' }),
    put: (key, value) => kv.put(key, value),
    delete: (key) => kv.delete(key),
  };
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

async function handleApi(request) {
  if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: CORS_HEADERS });
  if (request.method !== 'POST') return json({ code: 'PT405', message: '请使用 POST 调用房间接口' }, 405);
  let text = '';
  try { text = await request.text(); }
  catch { return json({ code: 'PT400', message: '请求格式无效' }, 400); }
  if (utf8Length(text) > MAX_API_BYTES) return json({ code: 'PT413', message: '请求内容过长' }, 413);
  let body = null;
  try { body = JSON.parse(text); }
  catch { return json({ code: 'PT400', message: '请求格式无效' }, 400); }
  try {
    const reply = await createRoomApi(edgeStore()).handle(body, utf8Length(text));
    return json(reply.body, reply.status);
  } catch (error) {
    return json({ code: 'PT500', message: '房间服务暂时不可用，请稍后重试', debug: String(error && error.stack || error) }, 500);
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
  async fetch(request) {
    const url = new URL(request.url);
    if (url.pathname === '/api/room') return handleApi(request);
    return serveAsset(url);
  },
};
