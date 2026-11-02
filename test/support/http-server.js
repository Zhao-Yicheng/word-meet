import { createServer } from 'node:http';
import { createRoomApi } from '../../server/protocol.mjs';

export async function roomServer(t) {
  const map = new Map();
  const store = {
    get: async (key) => map.get(key),
    put: async (key, value) => { map.set(key, value); },
    delete: async (key) => { map.delete(key); },
  };
  const api = createRoomApi(store);
  let unavailable = false;
  let activeRequests = 0;
  let resolveDrain;
  const server = createServer(async (incoming, outgoing) => {
    activeRequests++;
    try {
      const headers = { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Headers': 'Content-Type', 'Access-Control-Allow-Methods': 'POST, OPTIONS', 'Access-Control-Max-Age': '600' };
      if (incoming.method === 'OPTIONS') { outgoing.writeHead(204, headers).end(); return; }
      if (unavailable) {
        outgoing.writeHead(503, headers).end(JSON.stringify({ error: 'Temporary test outage' }));
        return;
      }
      if (incoming.url !== '/api/room' || incoming.method !== 'POST') {
        outgoing.writeHead(404, headers).end(JSON.stringify({ message: '接口不存在' }));
        return;
      }
      const chunks = [];
      for await (const chunk of incoming) chunks.push(chunk);
      const raw = Buffer.concat(chunks).toString();
      let payload;
      try { payload = JSON.parse(raw); }
      catch { outgoing.writeHead(400, headers).end(JSON.stringify({ code: 'PT400', message: '请求格式无效' })); return; }
      const reply = await api.handle(payload, Buffer.byteLength(raw));
      outgoing.writeHead(reply.status, headers).end(JSON.stringify(reply.body));
    } catch (error) { if (!outgoing.destroyed) outgoing.writeHead(500).end(error.message); }
    finally { if (--activeRequests === 0) resolveDrain?.(); }
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(async () => {
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
    if (activeRequests) await new Promise((resolve) => { resolveDrain = resolve; });
  });
  return {
    endpoint: 'http://127.0.0.1:' + server.address().port,
    setUnavailable: (value) => { unavailable = value; },
    store: map,
  };
}
