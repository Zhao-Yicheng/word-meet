// 同词相遇房间协议（v3）——纯 JavaScript 实现，Node 与阿里云 ESA EdgeRoutine 通用。
//
// 数据模型：每个房间一个 JSON 文档（key = room-<CODE>），消息内嵌在文档内。
// 存储层由调用方注入，接口为 { async get(key) → string|undefined, async put(key, value), async delete(key) }。
// Edge KV 没有事务与 CAS，所有修改走「读取 → 修改 → 写回 → 校验」乐观锁：
// 写回后重新读取并比对随机 writeId，发现被并发写覆盖就基于最新文档重试。
// 客户端另外通过轮询回显确认自己发出的消息已持久化，覆盖验证仍漏掉的极端竞态。
// 上述机制只保证最终收敛，不能替代强一致数据库；双人休闲游戏场景下足够可靠。

export const PROTOCOL_VERSION = 3;

const TTL_MS = 7200000; // 房间有效期：两小时
const PEER_TIMEOUT_MS = 45000; // 对方多久没有活动视为离线
const GUEST_LEASE_MS = 90000; // 客人席位无活动保留期
const SEEN_REFRESH_MS = 15000; // 心跳写入节流：超过这个间隔才把 seen 写回存储
const MAX_MESSAGES = 200; // 单次轮询返回的消息上限
const MAX_REQUEST_BYTES = 4096;
const MAX_DOC_MESSAGES = 5000; // 单房间消息文档上限，防止逼近 KV value 容量
const CODE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
const HEX64 = /^[a-f0-9]{64}$/;
const HEX32 = /^[a-f0-9]{32}$/;
const CLIENT_ID = /^[a-zA-Z0-9-]{1,80}$/;
const CONTROL_CHARS = /[\u0000-\u001f\u007f]/u;
const ACTIONS = ['create', 'join', 'poll', 'messages', 'leave'];

function fail(code, message, details) {
  const status = Number(code.slice(2));
  return { status, body: { code, message, ...(details ? { details } : {}) } };
}

const closed = () => fail('PT404', '找不到房间，房间可能已关闭或过期，请重新建房', 'ROOM_CLOSED');
const invalidToken = () => fail('PT401', '本次连接已失效，请重新加入', 'INVALID_TOKEN');
const sessionChanged = () => fail('PT409', '对局已更新，请重新加入', 'SESSION_CHANGED');
const ok = () => ({ status: 200, body: { ok: true } });

// ---- SHA-256（纯 JS，避免依赖运行时的 crypto.subtle）----

const SHA256_K = [
  0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5,
  0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174,
  0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
  0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967,
  0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85,
  0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
  0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3,
  0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2,
];
const SHA256_H = [0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a, 0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19];

const rotr = (value, count) => (value >>> count) | (value << (32 - count));

function utf8Bytes(text) {
  if (typeof TextEncoder === 'function') return new TextEncoder().encode(text);
  const bytes = [];
  for (const character of text) {
    const point = character.codePointAt(0);
    if (point < 0x80) bytes.push(point);
    else if (point < 0x800) bytes.push(0xc0 | (point >> 6), 0x80 | (point & 0x3f));
    else if (point < 0x10000) bytes.push(0xe0 | (point >> 12), 0x80 | ((point >> 6) & 0x3f), 0x80 | (point & 0x3f));
    else bytes.push(0xf0 | (point >> 18), 0x80 | ((point >> 12) & 0x3f), 0x80 | ((point >> 6) & 0x3f), 0x80 | (point & 0x3f));
  }
  return Uint8Array.from(bytes);
}

export function sha256hex(text) {
  const input = typeof text === 'string' ? utf8Bytes(text) : new Uint8Array(text);
  const length = input.length;
  const paddedLength = (length + 9 + 63) & ~63;
  const bytes = new Uint8Array(paddedLength);
  bytes.set(input);
  bytes[length] = 0x80;
  const bitLength = length * 8;
  const view = new DataView(bytes.buffer);
  view.setUint32(paddedLength - 8, Math.floor(bitLength / 0x100000000), false);
  view.setUint32(paddedLength - 4, bitLength >>> 0, false);
  const words = new Uint32Array(64);
  const hash = SHA256_H.slice();
  for (let offset = 0; offset < paddedLength; offset += 64) {
    for (let index = 0; index < 16; index++) words[index] = view.getUint32(offset + index * 4, false);
    for (let index = 16; index < 64; index++) {
      const w15 = words[index - 15];
      const w2 = words[index - 2];
      const small = rotr(w15, 7) ^ rotr(w15, 18) ^ (w15 >>> 3);
      const big = rotr(w2, 17) ^ rotr(w2, 19) ^ (w2 >>> 10);
      words[index] = (words[index - 16] + small + words[index - 7] + big) >>> 0;
    }
    let a = hash[0], b = hash[1], c = hash[2], d = hash[3];
    let e = hash[4], f = hash[5], g = hash[6], h = hash[7];
    for (let index = 0; index < 64; index++) {
      const sum = rotr(e, 6) ^ rotr(e, 11) ^ rotr(e, 25);
      const choose = (e & f) ^ (~e & g);
      const temp1 = (h + sum + choose + SHA256_K[index] + words[index]) >>> 0;
      const major = rotr(a, 2) ^ rotr(a, 13) ^ rotr(a, 22);
      const temp2 = (((a & b) ^ (a & c) ^ (b & c)) + major) >>> 0;
      h = g; g = f; f = e; e = (d + temp1) >>> 0; d = c; c = b; b = a; a = (temp1 + temp2) >>> 0;
    }
    for (let index = 0; index < 8; index++) hash[index] = (hash[index] + [a, b, c, d, e, f, g, h][index]) >>> 0;
  }
  let out = '';
  for (const value of hash) out += value.toString(16).padStart(8, '0');
  return out;
}

// ---- 随机数（优先密码学随机，缺备用 Math.random）----

function randomBytes(length) {
  const crypto = globalThis.crypto;
  if (crypto && typeof crypto.getRandomValues === 'function') return crypto.getRandomValues(new Uint8Array(length));
  const bytes = new Uint8Array(length);
  for (let index = 0; index < length; index++) bytes[index] = Math.floor(Math.random() * 256);
  return bytes;
}

function randomHex(byteCount) {
  const bytes = randomBytes(byteCount);
  let out = '';
  for (const byte of bytes) out += byte.toString(16).padStart(2, '0');
  return out;
}

const randomToken = () => randomHex(32); // 64 位十六进制，客户端校验同样格式
const randomSessionId = () => randomHex(16);
const randomCode = () => {
  const bytes = randomBytes(8);
  let code = '';
  for (let index = 0; index < 8; index++) code += CODE_ALPHABET[bytes[index] & 31];
  return code;
};

// ---- 校验工具 ----

const isObject = (value) => typeof value === 'object' && value !== null && !Array.isArray(value);
const codePoints = (text) => [...text].length;

function validateCode(value) {
  if (typeof value !== 'string' || !/^[A-HJ-NP-Z2-9]{8}$/.test(value)) return null;
  return value;
}

function validateName(value) {
  if (typeof value !== 'string') return { error: fail('PT400', '请输入昵称') };
  const name = value.trim();
  if (!name || codePoints(name) > 12 || CONTROL_CHARS.test(name)) return { error: fail('PT400', '昵称请写 1–12 个字') };
  return { name };
}

function unsignedInt(value) {
  return typeof value === 'number' && value >= 1 && value <= 9007199254740991 && Number.isInteger(value);
}

function buildPayload(message, sessionId) {
  if (!isObject(message) || message.v !== 1 || message.sessionId !== sessionId) return { error: sessionChanged() };
  if (!unsignedInt(message.match) || !unsignedInt(message.round)) return { error: fail('PT400', '对局轮次无效') };
  const payload = { v: 1, sessionId, match: message.match, round: message.round, type: message.type };
  if (message.type === 'commit') {
    if (typeof message.hash !== 'string' || !HEX64.test(message.hash)) return { error: fail('PT400', '对局消息格式无效') };
    payload.hash = message.hash;
  } else if (message.type === 'reveal') {
    if (typeof message.word !== 'string' || typeof message.salt !== 'string' || !HEX32.test(message.salt)) {
      return { error: fail('PT400', '对局消息格式无效') };
    }
    const word = message.word.trim().normalize('NFC');
    if (!word || codePoints(word) > 20 || CONTROL_CHARS.test(word)) return { error: fail('PT400', '词语请写 1–20 个字') };
    payload.word = word;
    payload.salt = message.salt;
  } else if (message.type !== 'ready') {
    return { error: fail('PT400', '对局消息格式无效') };
  }
  return { payload };
}

function seatOf(doc, token) {
  if (typeof token !== 'string' || !HEX64.test(token)) return -1;
  const hash = sha256hex(token);
  return doc.hostTokenHash === hash ? 0 : doc.guestTokenHash === hash ? 1 : -1;
}

function snapshot(doc, seat, now, messages, after, token) {
  const otherSeen = seat === 0 ? doc.guestSeen : doc.hostSeen;
  const body = {
    code: doc.code,
    seat,
    sessionId: doc.sessionId ?? null,
    names: [doc.hostName, doc.guestName ?? null],
    peerOnline: otherSeen !== null && otherSeen !== undefined && now - otherSeen < PEER_TIMEOUT_MS,
    messages,
    after,
  };
  if (token !== undefined) body.token = token;
  return body;
}

const clientMessage = (entry) => ({ id: entry.id, sender: entry.sender, clientId: entry.clientId, payload: entry.payload });

const jsonByteLength = (body) => utf8Bytes(JSON.stringify(body)).length;

// ---- 协议入口 ----

export function createRoomApi(store, { now = () => Date.now() } = {}) {
  const roomKey = (code) => 'room-' + code;

  // mutate：乐观锁修改房间文档。apply 收到当前文档（缺失为 null），
  // 返回 { result, next?: 新文档, remove?: true }。只读结果不带 next。
  async function mutate(key, apply, attempts = 8) {
    let conflict = fail('PT503', '房间服务繁忙，请稍后重试');
    for (let attempt = 0; attempt < attempts; attempt++) {
      let doc = null;
      const raw = await store.get(key);
      if (typeof raw === 'string' && raw) {
        try { doc = JSON.parse(raw); } catch { doc = null; }
        if (!isObject(doc)) doc = null;
      }
      const change = await apply(doc);
      if (change.remove) { await store.delete(key); return change.result; }
      if (!change.next) return change.result;
      const next = { ...change.next, rev: (doc?.rev ?? 0) + 1, writeId: randomHex(8) };
      await store.put(key, JSON.stringify(next));
      const verify = await store.get(key);
      let survived = false;
      if (typeof verify === 'string' && verify) {
        try { survived = JSON.parse(verify)?.writeId === next.writeId; } catch { survived = false; }
      }
      if (survived) return change.result;
      conflict = fail('PT503', '房间服务繁忙，请稍后重试');
    }
    return conflict;
  }

  async function createRoom(nameValue) {
    const nameCheck = validateName(nameValue);
    if (nameCheck.error) return nameCheck.error;
    const name = nameCheck.name;
    const createdAt = now();
    const token = randomToken();
    const tokenHash = sha256hex(token);
    return (async () => {
      for (let attempt = 0; attempt < 5; attempt++) {
        const code = randomCode();
        const result = await mutate(roomKey(code), (doc) => {
          if (doc) return { result: null }; // 房间码撞车，换一个重试
          const created = {
            code, hostName: name, hostTokenHash: tokenHash,
            guestName: null, guestTokenHash: null, sessionId: null,
            createdAt, expiresAt: createdAt + TTL_MS, hostSeen: createdAt, guestSeen: null,
            seq: 0, messages: [],
          };
          return { result: { status: 200, body: snapshot(created, 0, createdAt, [], 0, token) }, next: created };
        });
        if (result) return result;
      }
      return fail('PT503', '房间创建失败，请重试');
    })();
  }

  function joinRoom(request) {
    const code = validateCode(request.code);
    if (!code) return Promise.resolve(fail('PT400', '房间码无效'));
    const nameCheck = validateName(request.name);
    if (nameCheck.error) return Promise.resolve(nameCheck.error);
    const name = nameCheck.name;
    const token = randomToken();
    const tokenHash = sha256hex(token);
    const resumeHash = typeof request.resumeToken === 'string' && HEX64.test(request.resumeToken) ? sha256hex(request.resumeToken) : null;
    const at = now();
    return mutate(roomKey(code), (doc) => {
      if (!doc || doc.expiresAt <= at) return { result: closed() };
      if (doc.guestTokenHash === tokenHash) return { result: { status: 200, body: snapshot(doc, 1, at, [], 0, token) } }; // 重试时幂等
      if (doc.guestTokenHash !== null && doc.guestSeen !== null && at - doc.guestSeen < GUEST_LEASE_MS && doc.guestTokenHash !== resumeHash) {
        return { result: fail('PT409', '房间已满，每个房间最多两人', 'ROOM_FULL') };
      }
      const next = {
        ...doc, guestName: name, guestTokenHash: tokenHash,
        sessionId: randomSessionId(), guestSeen: at, expiresAt: at + TTL_MS, seq: 0, messages: [],
      };
      return { result: { status: 200, body: snapshot(next, 1, at, [], 0, token) }, next };
    });
  }

  function pollRoom(request) {
    const code = validateCode(request.code);
    if (!code) return Promise.resolve(fail('PT400', '房间码无效'));
    let after = 0;
    if ('after' in request) {
      const cursor = request.after;
      if (typeof cursor !== 'number' || !Number.isInteger(cursor) || cursor < 0 || cursor > 9007199254740991) {
        return Promise.resolve(fail('PT400', '消息游标无效'));
      }
      after = cursor;
    }
    const at = now();
    return mutate(roomKey(code), (doc) => {
      if (!doc || doc.expiresAt <= at) return { result: closed() };
      const seat = seatOf(doc, request.token);
      if (seat < 0) return { result: invalidToken() };
      let next = null;
      const seen = seat === 0 ? doc.hostSeen : doc.guestSeen;
      if (at - seen > SEEN_REFRESH_MS) {
        next = {
          ...doc, expiresAt: at + TTL_MS,
          hostSeen: seat === 0 ? at : doc.hostSeen, guestSeen: seat === 1 ? at : doc.guestSeen,
        };
      }
      const returned = doc.messages.filter((entry) => entry.id > after).slice(0, MAX_MESSAGES);
      const newAfter = returned.length ? returned[returned.length - 1].id : after;
      return { result: { status: 200, body: snapshot(next ?? doc, seat, at, returned.map(clientMessage), newAfter) }, next };
    });
  }

  function sendMessages(request) {
    const code = validateCode(request.code);
    if (!code) return Promise.resolve(fail('PT400', '房间码无效'));
    if (typeof request.id !== 'string' || !CLIENT_ID.test(request.id)) return Promise.resolve(fail('PT400', '消息编号无效'));
    const at = now();
    return mutate(roomKey(code), (doc) => {
      if (!doc || doc.expiresAt <= at) return { result: closed() };
      const seat = seatOf(doc, request.token);
      if (seat < 0) return { result: invalidToken() };
      if (!doc.sessionId || !isObject(request.message)) return { result: sessionChanged() };
      const built = buildPayload(request.message, doc.sessionId);
      if (built.error) return { result: built.error };
      const payload = built.payload;
      const existing = doc.messages.find((entry) => entry.sender === seat && entry.clientId === request.id);
      if (existing) {
        return JSON.stringify(existing.payload) === JSON.stringify(payload)
          ? { result: ok() }
          : { result: fail('PT409', '不能修改已发送的消息') };
      }
      if (doc.messages.length >= MAX_DOC_MESSAGES) return { result: fail('PT403', '本局消息过多，请重新建房') };
      const next = { ...doc, seq: doc.seq + 1, messages: [...doc.messages, { id: doc.seq + 1, sender: seat, clientId: request.id, payload }] };
      return { result: ok(), next };
    });
  }

  function leaveRoom(request) {
    const code = validateCode(request.code);
    if (!code) return Promise.resolve(fail('PT400', '房间码无效'));
    const at = now();
    return mutate(roomKey(code), (doc) => {
      if (!doc || doc.expiresAt <= at) return { result: closed() };
      const seat = seatOf(doc, request.token);
      if (seat < 0) return { result: invalidToken() };
      if (seat === 0) return { result: ok(), remove: true };
      return {
        result: ok(),
        next: { ...doc, guestName: null, guestTokenHash: null, guestSeen: null, sessionId: null, seq: 0, messages: [] },
      };
    });
  }

  async function health() {
    try {
      await store.get('health');
      return { status: 200, body: { ok: true, transport: 'esa', protocol: PROTOCOL_VERSION } };
    } catch {
      return fail('PT503', '房间存储不可用，请稍后再试');
    }
  }

  async function handle(body, byteLength) {
    if (!isObject(body)) return fail('PT400', '请求格式无效');
    if ((byteLength ?? jsonByteLength(body)) > MAX_REQUEST_BYTES) return fail('PT413', '请求内容过长');
    if (body.action === 'health') return health();
    if (!ACTIONS.includes(body.action)) return fail('PT404', '接口不存在');
    switch (body.action) {
      case 'create': return createRoom(body.name);
      case 'join': return joinRoom(body);
      case 'poll': return pollRoom(body);
      case 'messages': return sendMessages(body);
      case 'leave': return leaveRoom(body);
    }
    return fail('PT404', '接口不存在');
  }

  return { handle };
}
