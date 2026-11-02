import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { createRoomApi } from '../server/protocol.mjs';

const project = fileURLToPath(new URL('../', import.meta.url));
const root = process.argv.includes('--dist') ? path.join(project, 'dist') : project;
const port = Number(process.env.PORT || 4173);
const mime = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.svg': 'image/svg+xml', '.txt': 'text/plain; charset=utf-8', '.png': 'image/png' };

// 本地开发的内存存储：与线上 EdgeKV 同一份协议代码，刷新即清空。
const memoryStore = () => {
  const map = new Map();
  return {
    get: async (key) => map.get(key),
    put: async (key, value) => { map.set(key, value); },
    delete: async (key) => { map.delete(key); },
  };
};
const api = createRoomApi(memoryStore());

const server = createServer(async (request, response) => {
  const url = new URL(request.url, 'http://localhost');
  const headers = { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Headers': 'Content-Type', 'Access-Control-Allow-Methods': 'POST, OPTIONS', 'Access-Control-Max-Age': '600' };
  try {
    if (url.pathname === '/api/room') {
      if (request.method === 'OPTIONS') { response.writeHead(204, headers).end(); return; }
      if (request.method !== 'POST') { response.writeHead(405, headers).end(JSON.stringify({ code: 'PT405', message: '请使用 POST 调用房间接口' })); return; }
      const chunks = [];
      for await (const chunk of request) chunks.push(chunk);
      const raw = Buffer.concat(chunks).toString();
      let payload;
      try { payload = JSON.parse(raw); } catch { response.writeHead(400, headers).end(JSON.stringify({ code: 'PT400', message: '请求格式无效' })); return; }
      const reply = await api.handle(payload, Buffer.byteLength(raw));
      response.writeHead(reply.status, headers).end(JSON.stringify(reply.body));
      return;
    }
    let name = decodeURIComponent(url.pathname);
    if (name === '/') name = '/index.html';
    if (root === project && name === '/favicon.svg') name = '/public/favicon.svg';
    const target = path.resolve(root, '.' + name);
    const relative = path.relative(root, target);
    const allowed = root !== project || name === '/index.html' || name === '/public/favicon.svg' ||
      name.startsWith('/src/');
    if (relative.startsWith('..') || path.isAbsolute(relative) || !allowed) {
      response.writeHead(404).end('Not found');
      return;
    }
    const data = await readFile(target);
    response.writeHead(200, { 'Content-Type': mime[path.extname(target)] || 'application/octet-stream', 'Cache-Control': 'no-store' }).end(data);
  } catch (error) {
    if (!response.headersSent) response.writeHead(500).end(error.message);
  }
});
server.listen(port, '127.0.0.1', () => console.log(`Local: http://127.0.0.1:${port}/`));
server.on('error', (error) => { console.error(error.message); process.exitCode = 1; });
