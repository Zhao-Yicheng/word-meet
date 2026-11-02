import test from 'node:test';
import assert from 'node:assert/strict';
import { createRoomApi, sha256hex } from '../server/protocol.mjs';
import { createHash } from 'node:crypto';

function memoryStore() {
  const map = new Map();
  return {
    get: async (key) => map.get(key),
    put: async (key, value) => { map.set(key, value); },
    delete: async (key) => { map.delete(key); },
    raw: map,
  };
}

function apiHarness({ now = () => Date.now() } = {}) {
  const store = memoryStore();
  return { api: createRoomApi(store, { now }), store };
}

async function call(api, request, byteLength) {
  return api.handle(request, byteLength);
}

function success(reply) {
  assert.equal(reply.status, 200, JSON.stringify(reply.body));
  return reply.body;
}

async function create(api, name = '甲') {
  return success(await call(api, { action: 'create', name }));
}

async function pair(api) {
  const host = await create(api);
  const guest = success(await call(api, { action: 'join', code: host.code, name: '乙' }));
  return { host, guest };
}

const send = (api, player, message, id = crypto.randomUUID()) =>
  call(api, { action: 'messages', code: player.code, token: player.token, id, message });

function readDoc(store, code) {
  const raw = store.raw.get('room-' + code);
  return raw ? JSON.parse(raw) : null;
}

test('sha256hex matches node:crypto for ascii, unicode and empty input', () => {
  for (const input of ['', 'a', 'abc', '月亮', 'é\u0301', 'x'.repeat(100), '混合 tea 🍵']) {
    assert.equal(sha256hex(input), createHash('sha256').update(input, 'utf8').digest('hex'));
  }
});

test('create returns a private seat token and an eight-character room code', async () => {
  const { api, store } = apiHarness();
  const host = await create(api);
  assert.match(host.code, /^[A-HJ-NP-Z2-9]{8}$/);
  assert.match(host.token, /^[a-f0-9]{64}$/);
  assert.equal(host.seat, 0);
  assert.deepEqual(host.names, ['甲', null]);
  assert.equal(host.sessionId, null);
  const doc = readDoc(store, host.code);
  assert.equal(doc.hostTokenHash, sha256hex(host.token));
  assert.notEqual(doc.hostTokenHash, host.token);
});

test('simultaneous guest joins cannot allocate more than one guest seat', async () => {
  const { api } = apiHarness();
  const host = await create(api);
  const replies = await Promise.all(['乙', '丙'].map((name) => call(api, { action: 'join', code: host.code, name })));
  assert.deepEqual(replies.map((r) => r.status).sort(), [200, 409]);
  assert.equal(replies.find((r) => r.status === 409).body.details, 'ROOM_FULL');
});

test('both players sending at once still persist both messages', async () => {
  const { api } = apiHarness();
  const { host, guest } = await pair(api);
  const base = { v: 1, sessionId: guest.sessionId, match: 1, round: 1, type: 'commit' };
  const replies = await Promise.all([
    send(api, host, { ...base, hash: 'a'.repeat(64) }, 'host-one'),
    send(api, guest, { ...base, hash: 'b'.repeat(64) }, 'guest-one'),
  ]);
  assert.deepEqual(replies.map((r) => r.status), [200, 200]);
  const polled = await call(api, { action: 'poll', code: host.code, token: guest.token, after: 0 });
  assert.equal(polled.body.messages.length, 2);
  assert.deepEqual(polled.body.messages.map((m) => m.payload.hash).sort(), ['a'.repeat(64), 'b'.repeat(64)]);
  assert.deepEqual(polled.body.messages.map((m) => m.id), [1, 2]);
});

test('a write clobbered between put and verify is retried and still lands', async () => {
  const base = memoryStore();
  let dropped = 0;
  const store = {
    get: (key) => base.get(key),
    put: async (key, value) => { if (dropped++ < 1) return; await base.put(key, value); }, // 第一次写静默丢失
    delete: (key) => base.delete(key),
    raw: base.raw,
  };
  const api = createRoomApi(store);
  const { host, guest } = await pair(api);
  const reply = await send(api, host, { v: 1, sessionId: guest.sessionId, match: 1, round: 1, type: 'commit', hash: 'a'.repeat(64) }, 'one');
  assert.equal(reply.status, 200, '写丢失后应当重试成功');
  const polled = await call(api, { action: 'poll', code: host.code, token: guest.token, after: 0 });
  assert.equal(polled.body.messages.length, 1);
  assert.equal(polled.body.messages[0].payload.hash, 'a'.repeat(64));
});

test('callers without the seat token cannot poll a room', async () => {
  const { api } = apiHarness();
  const { host } = await pair(api);
  assert.equal((await call(api, { action: 'poll', code: host.code })).status, 401);
  assert.equal((await call(api, { action: 'poll', code: host.code, token: '0'.repeat(64) })).status, 401);
});

test('message delivery is ordered, deduplicated and restricted to the current session', async () => {
  const { api } = apiHarness();
  const { host, guest } = await pair(api);
  const message = { v: 1, sessionId: guest.sessionId, match: 1, round: 1, type: 'commit', hash: 'a'.repeat(64) };
  assert.equal((await send(api, host, message, 'one')).status, 200);
  assert.equal((await send(api, host, message, 'one')).status, 200);
  assert.equal((await send(api, host, { ...message, hash: 'b'.repeat(64) }, 'one')).status, 409);
  const polled = await call(api, { action: 'poll', code: guest.code, token: guest.token, after: 0 });
  assert.equal(polled.status, 200, polled.body.message);
  assert.equal(polled.body.messages.length, 1);
  assert.deepEqual(polled.body.messages[0].payload, message);
  assert.equal(polled.body.messages[0].clientId, 'one');
  const empty = await call(api, { action: 'poll', code: guest.code, token: guest.token, after: polled.body.after });
  assert.deepEqual(empty.body.messages, []);
  assert.equal((await send(api, host, { ...message, sessionId: crypto.randomUUID() })).body.details, 'SESSION_CHANGED');
});

test('a poll returns the caller its own messages so the client can confirm persistence', async () => {
  const { api } = apiHarness();
  const { host, guest } = await pair(api);
  await send(api, host, { v: 1, sessionId: guest.sessionId, match: 1, round: 1, type: 'commit', hash: 'a'.repeat(64) }, 'host-one');
  const own = await call(api, { action: 'poll', code: host.code, token: host.token, after: 0 });
  assert.equal(own.body.messages.length, 1);
  assert.equal(own.body.messages[0].sender, 0);
  assert.equal(own.body.messages[0].clientId, 'host-one');
});

test('authenticated rejoin replaces the guest and a late old leave cannot remove the new seat', async () => {
  const { api } = apiHarness();
  const { host, guest } = await pair(api);
  const next = await call(api, { action: 'join', code: host.code, name: '乙', resumeToken: guest.token });
  assert.equal(next.status, 200, next.body.message);
  assert.notEqual(next.body.sessionId, guest.sessionId);
  assert.equal((await call(api, { action: 'leave', code: host.code, token: guest.token })).status, 401);
  const poll = await call(api, { action: 'poll', code: host.code, token: next.body.token });
  assert.equal(poll.status, 200, poll.body.message);
  assert.equal(poll.body.sessionId, next.body.sessionId);
});

test('inactive guest leases expire and host leave closes the room', async () => {
  const { api, store } = apiHarness();
  const { host, guest } = await pair(api);
  const doc = readDoc(store, host.code);
  doc.guestSeen = 0;
  store.raw.set('room-' + host.code, JSON.stringify(doc));
  const next = await call(api, { action: 'join', code: host.code, name: '丙' });
  assert.equal(next.status, 200, next.body.message);
  assert.notEqual(next.body.sessionId, guest.sessionId);
  assert.equal((await call(api, { action: 'leave', code: host.code, token: host.token })).status, 200);
  assert.equal((await call(api, { action: 'poll', code: host.code, token: next.body.token })).status, 404);
});

test('expired rooms cannot be polled', async () => {
  let clock = 1_700_000_000_000;
  const { api, store } = apiHarness({ now: () => clock });
  const host = await create(api);
  const doc = readDoc(store, host.code);
  doc.expiresAt = 0;
  store.raw.set('room-' + host.code, JSON.stringify(doc));
  assert.equal((await call(api, { action: 'poll', code: host.code, token: host.token })).status, 404);
  const later = await create(api, '丙');
  assert.match(later.code, /^[A-HJ-NP-Z2-9]{8}$/);
});

test('health reports the transport and touches the store', async () => {
  const { api } = apiHarness();
  const reply = await call(api, { action: 'health' });
  assert.equal(reply.status, 200);
  assert.deepEqual(reply.body, { ok: true, transport: 'esa', protocol: 3 });
});

test('names, Unicode words, message types and numeric boundaries are validated', async () => {
  const { api } = apiHarness();
  assert.equal((await call(api, { action: 'create', name: '\u3000\t' })).status, 400);
  assert.equal((await call(api, { action: 'create', name: '甲\n乙' })).status, 400);
  assert.equal((await call(api, { action: 'create', name: '甲'.repeat(13) })).status, 400);
  assert.equal((await call(api, { action: 'create', name: 'a'.repeat(5000) })).status, 413);
  assert.equal((await call(api, { action: 'frobnicate' })).status, 404);
  assert.equal((await call(api, { action: 'create' })).status, 400);
  const { host, guest } = await pair(api);
  const base = { v: 1, sessionId: guest.sessionId, match: 1, round: 1 };
  assert.equal((await send(api, host, { ...base, type: 'reveal', word: ' e\u0301 ', salt: 'c'.repeat(32) })).status, 200);
  const poll = await call(api, { action: 'poll', code: guest.code, token: guest.token });
  assert.equal(poll.body.messages[0].payload.word, 'é');
  for (const message of [
    { ...base, type: 'reveal', word: '字'.repeat(21), salt: 'c'.repeat(32) },
    { ...base, type: 'commit', hash: 'oops' },
    { ...base, type: 'ready', round: 1.5 },
    { ...base, type: 'ready', match: null },
    { ...base, type: 'ready', match: 9007199254740992 },
    { ...base, type: 'unknown' },
  ]) assert.equal((await send(api, host, message)).status, 400);
  assert.equal((await send(api, host, { ...base, type: 'ready' }, 'not!valid')).status, 400);
  assert.equal((await call(api, { action: 'poll', code: host.code, token: host.token, after: -1 })).status, 400);
  assert.equal((await call(api, { action: 'poll', code: host.code, token: host.token, after: 'bad' })).status, 400);
});

test('join validates the room code and join on a missing room reports closure', async () => {
  const { api } = apiHarness();
  assert.equal((await call(api, { action: 'join', code: 'NOTACODE', name: '乙' })).status, 400);
  assert.equal((await call(api, { action: 'join', code: 'ZZZZZZZZ', name: '乙' })).status, 404);
});
