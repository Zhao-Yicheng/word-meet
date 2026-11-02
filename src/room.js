import { ROOM_ENDPOINT } from './config.js';

export function cleanName(value) {
  if (typeof value !== 'string') throw new Error('请输入昵称');
  const name = value.trim();
  if (!name || [...name].length > 12 || /[\u0000-\u001f\u007f]/u.test(name)) throw new Error('昵称请写 1–12 个字');
  return name;
}

class ApiError extends Error {
  constructor(message, status, code) { super(message); this.status = status; this.code = code; }
}

function checkConfig(endpoint) {
  if (typeof endpoint !== 'string') throw new ApiError('房间服务尚未配置，请稍后再试', 400);
  if (!endpoint) return; // 同源：网页和 /api/room 在同一个域名上
  let url;
  try { url = new URL(endpoint); } catch { throw new ApiError('房间服务地址配置无效，请稍后再试', 400); }
  const local = ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname);
  if (url.protocol !== 'https:' && !(local && url.protocol === 'http:')) throw new ApiError('房间服务地址需要使用 HTTPS', 400);
  if (url.pathname !== '/' || url.search || url.hash || url.username || url.password) throw new ApiError('房间服务地址配置无效，请稍后再试', 400);
}

export class RoomConnection {
  constructor(onEvent, { endpoint = ROOM_ENDPOINT } = {}) {
    this.onEvent = onEvent;
    this.endpoint = (endpoint || '').replace(/\/$/, '');
    this.disposed = false;
    this.connected = false;
    this.requests = new Set();
    this.outbox = [];
    this.after = 0;
    this.failures = 0;
    this.networkUnavailable = false;
    this.peerOffline = false;
  }

  host(name) {
    this.role = 'host';
    this.name = cleanName(name);
    void this.start('create');
  }

  join(name, code, resumeToken) {
    this.role = 'guest';
    this.name = cleanName(name);
    if (!/^[A-HJ-NP-Z2-9]{8}$/.test(code)) throw new Error('房间码无效');
    this.code = code;
    this.resumeToken = resumeToken;
    void this.start('join');
  }

  async start(action) {
    try {
      const data = await this.request(action, { name: this.name, ...(this.resumeToken ? { resumeToken: this.resumeToken } : {}) });
      if (this.disposed) return;
      if (typeof data.token !== 'string' || !/^[a-f0-9]{64}$/.test(data.token)) throw new Error('房间服务器返回了无效信息');
      this.token = data.token;
      this.code = data.code;
      this.applySnapshot(data);
      this.schedule(0);
    } catch (error) {
      if (!this.disposed) this.fail(error instanceof ApiError ? error.message : '暂时无法连接房间服务器，请稍后重试');
    }
  }

  async request(action, body = {}) {
    checkConfig(this.endpoint);
    const controller = new AbortController();
    this.requests.add(controller);
    const timeout = setTimeout(() => controller.abort(), 10000);
    try {
      const response = await fetch(this.endpoint + '/api/room', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
        body: JSON.stringify({ action, code: this.code, token: this.token, ...body }),
        credentials: 'omit', cache: 'no-store', redirect: 'error', signal: controller.signal,
      });
      let data;
      try { data = await response.json(); }
      catch { throw new ApiError('房间服务器返回了无法识别的响应，请稍后重试', response.status >= 500 ? response.status : 503); }
      if (!response.ok) {
        const message = /^PT\d{3}$/.test(data.code) ? data.message
          : response.status === 404 ? '房间服务尚未初始化，请稍后再试'
          : [401, 403].includes(response.status) ? '房间服务配置需要更新，请稍后再试'
          : '房间服务暂时不可用，请稍后重试';
        throw new ApiError(message, response.status, data.details || data.code);
      }
      return data;
    } finally {
      clearTimeout(timeout);
      this.requests.delete(controller);
    }
  }

  applySnapshot(data) {
    if (this.disposed) return;
    if (!data || !/^[A-HJ-NP-Z2-9]{8}$/.test(data.code) || ![0, 1].includes(data.seat) || !Array.isArray(data.names)) throw new Error('房间信息无效');
    this.code = data.code;
    const recovered = this.networkUnavailable;
    this.networkUnavailable = false;
    this.failures = 0;
    if (data.sessionId && data.sessionId !== this.sessionId) {
      this.sessionId = data.sessionId;
      this.connected = true;
      this.after = 0;
      this.outbox = this.outbox.filter((packet) => packet.message.sessionId === this.sessionId);
      this.onEvent({ type: 'connected', code: this.code, seat: data.seat, otherName: data.names[1 - data.seat], sessionId: this.sessionId });
    } else if (!data.sessionId && this.sessionId) {
      this.sessionId = null;
      this.connected = false;
      this.after = 0;
      this.outbox = [];
      this.onEvent({ type: 'disconnected', message: '对方已离开房间。可以通过原房间码重新加入，开始新的一局。' });
    } else if (!data.sessionId && !this.waitingAnnounced) {
      this.waitingAnnounced = true;
      this.onEvent({ type: 'waiting', code: this.code });
    }
    if (this.connected) {
      if (!data.peerOnline && !this.peerOffline) {
        this.peerOffline = true;
        this.onEvent({ type: 'peer-offline', message: '对方暂时离线，正在等待恢复。请双方保持游戏页面打开。' });
      } else if (data.peerOnline && (this.peerOffline || recovered)) {
        this.peerOffline = false;
        this.onEvent({ type: 'online', connected: true });
      }
    } else if (recovered) this.onEvent({ type: 'online', connected: false });
    // 服务器会把本人发出的消息一并返回（回显确认）；只有对方的消息才交给游戏。
    const confirmed = new Set();
    for (const entry of data.messages || []) {
      if (entry.sender === data.seat) confirmed.add(entry.clientId);
      else this.onEvent({ type: 'message', message: entry.payload });
    }
    if (confirmed.size && this.outbox.length) this.outbox = this.outbox.filter((packet) => !confirmed.has(packet.id));
    this.after = Math.max(this.after, Number(data.after) || 0);
    void this.flush();
  }

  schedule(delay = 1500) {
    if (this.disposed) return;
    clearTimeout(this.pollTimer);
    this.pollTimer = setTimeout(() => void this.poll(), delay);
  }

  async poll() {
    if (this.disposed || this.polling || !this.token) return;
    this.polling = true;
    let delay = typeof document !== 'undefined' && document.visibilityState === 'hidden' ? 3000 : 1500;
    try {
      const data = await this.request('poll', { after: this.after });
      this.applySnapshot(data);
      if (data.messages?.length === 200) delay = 0;
    } catch (error) {
      if (!this.disposed) {
        if (error instanceof ApiError && [400, 401, 403, 404].includes(error.status)) return this.fail(error.message);
        this.markUnavailable();
        delay = Math.min(6000, 1500 * 2 ** Math.min(this.failures, 2));
      }
    } finally {
      this.polling = false;
      this.schedule(delay);
    }
  }

  markUnavailable() {
    this.failures++;
    if (this.networkUnavailable || this.disposed) return;
    this.networkUnavailable = true;
    this.onEvent({ type: 'retrying', message: '与房间服务器的连接暂时中断，正在自动恢复。已提交的词语会保留。' });
  }

  send(message) {
    if (this.disposed || !this.token || !this.sessionId) throw new Error('当前未连接房间，请重新加入');
    this.outbox.push({ id: crypto.randomUUID(), message });
    void this.flush();
  }

  async flush() {
    if (this.flushing || this.disposed || !this.token) return;
    this.flushing = true;
    try {
      while (this.outbox.length && !this.disposed) {
        const packet = this.outbox[0];
        if (packet.message.sessionId !== this.sessionId) { this.outbox.shift(); continue; }
        // 发送成功后要等下一次轮询回显确认这条消息已持久化，再把它从发件箱移除：
        // 边缘存储没有事务，并发写冲突时服务器会静默丢弃一次写入，靠回显触发重发。
        if (packet.inFlight || (packet.sentAt && Date.now() - packet.sentAt < 2500)) return;
        packet.inFlight = true;
        try {
          await this.request('messages', { id: packet.id, message: packet.message });
        } catch (error) {
          packet.inFlight = false;
          if (this.disposed) return;
          if (error instanceof ApiError && error.code === 'SESSION_CHANGED') {
            this.outbox = this.outbox.filter((entry) => entry.message.sessionId !== packet.message.sessionId);
            this.schedule(0);
          } else if (error instanceof ApiError && [400, 401, 403, 404, 409].includes(error.status)) this.fail(error.message);
          else this.markUnavailable();
          return;
        }
        packet.inFlight = false;
        packet.sentAt = Date.now();
        this.schedule(0);
        if (this.outbox[0] === packet) return;
      }
    } finally { this.flushing = false; }
  }

  ping() { this.schedule(0); }

  fail(message) {
    if (this.disposed) return;
    this.onEvent({ type: 'error', message });
    this.dispose();
  }

  dispose() {
    if (this.disposed) return;
    this.disposed = true;
    this.connected = false;
    clearTimeout(this.pollTimer);
    for (const controller of this.requests) controller.abort();
    this.requests.clear();
    this.outbox = [];
    if (this.token && this.code) {
      void fetch(this.endpoint + '/api/room', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'leave', code: this.code, token: this.token }), credentials: 'omit', keepalive: true,
      }).catch(() => {});
    }
  }
}
