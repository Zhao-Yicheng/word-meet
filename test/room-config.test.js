import test from 'node:test';
import assert from 'node:assert/strict';
import { RoomConnection } from '../src/room.js';

async function rejectedSettings(t, settings) {
  let requests = 0;
  t.mock.method(globalThis, 'fetch', async () => {
    requests++;
    return Response.json({ message: 'Unexpected network request' }, { status: 401 });
  });
  const event = await new Promise((resolve) => {
    const room = new RoomConnection((value) => { if (value.type === 'error') resolve(value); }, settings);
    t.after(() => room.dispose());
    room.host('甲');
  });
  return { event, requests };
}

test('an empty endpoint defaults to same-origin and never blocks startup', async (t) => {
  let sent;
  t.mock.method(globalThis, 'fetch', async (url, options) => { sent = { url, ...options }; return Response.json({ ok: true }); });
  const room = new RoomConnection(() => {}, {});
  room.code = 'ABCDEFGH';
  room.token = 'a'.repeat(64);
  await room.request('poll', { after: 7 });
  assert.equal(sent.url, '/api/room');
  assert.equal(sent.headers.apikey, undefined);
  assert.equal(sent.credentials, 'omit');
  assert.deepEqual(JSON.parse(sent.body), { action: 'poll', code: room.code, token: room.token, after: 7 });
});

test('non-local HTTP room endpoints are rejected before the request is sent', async (t) => {
  const result = await rejectedSettings(t, { endpoint: 'http://rooms.example.com' });
  assert.match(result.event.message, /HTTPS/);
  assert.equal(result.requests, 0);
});

test('endpoints with a path or query are rejected before the request is sent', async (t) => {
  for (const endpoint of ['https://rooms.example.com/api', 'https://rooms.example.com/?x=1']) {
    const result = await rejectedSettings(t, { endpoint });
    assert.match(result.event.message, /地址配置无效/);
    assert.equal(result.requests, 0);
  }
});

test('an unreachable-looking garbage endpoint is rejected before the request is sent', async (t) => {
  const result = await rejectedSettings(t, { endpoint: 'nota-url' });
  assert.match(result.event.message, /地址配置无效|HTTPS/);
  assert.equal(result.requests, 0);
});

test('an uninitialized function reports setup rather than leaking a raw 404', async (t) => {
  t.mock.method(globalThis, 'fetch', async () => Response.json({ message: 'Not Found' }, { status: 404 }));
  const event = await new Promise((resolve) => {
    const room = new RoomConnection((value) => { if (value.type === 'error') resolve(value); }, { endpoint: 'https://rooms.example.com' });
    room.host('甲');
  });
  assert.match(event.message, /尚未初始化/);
});
