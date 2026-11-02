export function cleanWord(value) {
  if (typeof value !== 'string') throw new Error('请输入一个词语');
  const word = value.trim().normalize('NFC');
  if (!word || [...word].length > 20 || /[\u0000-\u001f\u007f]/u.test(word)) {
    throw new Error('写一个 1–20 字的词语吧，不要换行');
  }
  return word;
}

export function parseRoomCode(value) {
  let code = String(value).trim();
  // 聊天软件里粘出来的链接经常没有协议头，补上再解析；纯房间码不会有 . / # ? 这些字符。
  const hasScheme = /^https?:\/\//i.test(code);
  const looksLikeLink = hasScheme || /[/#?]/.test(code) || /\.[a-z\u00a0-\uffff]{2,}$/i.test(code);
  if (looksLikeLink) {
    const url = new URL(hasScheme ? code : 'https://' + code);
    code = new URLSearchParams(url.hash.slice(1)).get('room') || '';
  }
  code = code.replace(/[\s-]/g, '').toUpperCase();
  if (!/^[A-HJ-NP-Z2-9]{8}$/.test(code)) throw new Error('请输入 8 位房间码，或粘贴完整邀请链接');
  return code;
}

async function commitment(sessionId, match, round, seat, word, salt) {
  const bytes = new TextEncoder().encode(JSON.stringify([sessionId, match, round, seat, word, salt]));
  const digest = await crypto.subtle.digest('SHA-256', bytes);
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, '0')).join('');
}

export class GameSession {
  constructor({ sessionId, seat, send, onChange = () => {} }) {
    if (typeof sessionId !== 'string' || ![0, 1].includes(seat)) throw new Error('对局信息无效');
    this.sessionId = sessionId;
    this.seat = seat;
    this.send = send;
    this.onChange = onChange;
    this.match = 1;
    this.round = 1;
    this.history = [];
    this.resetRound();
  }

  resetRound() {
    this.phase = 'writing';
    this.hashes = [null, null];
    this.words = [null, null];
    this.ready = [false, false];
    this.secret = null;
    this.submitting = false;
  }

  get view() {
    return {
      match: this.match, round: this.round, phase: this.phase,
      committed: this.hashes.map(Boolean), words: [...this.words],
      ready: [...this.ready], ownWord: this.secret?.word || '',
      submitting: this.submitting,
      history: this.history.map((entry) => ({ ...entry, words: [...entry.words] })),
    };
  }

  emit(type, payload = {}) {
    this.send({ v: 1, sessionId: this.sessionId, match: this.match, round: this.round, type, ...payload });
  }

  async submit(value) {
    if (this.phase !== 'writing' || this.hashes[this.seat] || this.submitting) {
      throw new Error('词语已经锁定，等这轮揭晓吧');
    }
    const word = cleanWord(value);
    this.submitting = true;
    this.onChange();
    try {
      const salt = Array.from(crypto.getRandomValues(new Uint8Array(16)), (b) => b.toString(16).padStart(2, '0')).join('');
      const hash = await commitment(this.sessionId, this.match, this.round, this.seat, word, salt);
      this.secret = { word, salt };
      this.hashes[this.seat] = hash;
      this.emit('commit', { hash });
      this.revealIfReady();
    } finally {
      this.submitting = false;
      this.onChange();
    }
  }

  revealIfReady() {
    if (this.hashes.every(Boolean) && this.secret && !this.words[this.seat]) {
      this.words[this.seat] = this.secret.word;
      this.emit('reveal', this.secret);
      this.finishIfReady();
    }
  }

  finishIfReady() {
    if (this.phase !== 'writing' || !this.words.every(Boolean)) return;
    const matched = this.words[0] === this.words[1];
    this.history.push({ round: this.round, words: [...this.words], matched });
    this.phase = matched ? 'matched' : 'revealed';
  }

  async receive(message) {
    if (!message || message.v !== 1 || message.sessionId !== this.sessionId ||
        message.match !== this.match || message.round !== this.round) return;
    const other = 1 - this.seat;
    if (message.type === 'commit') {
      if (typeof message.hash !== 'string' || !/^[a-f0-9]{64}$/.test(message.hash)) throw new Error('对方的提交格式无效');
      if (this.hashes[other] && this.hashes[other] !== message.hash) throw new Error('对方更改了已锁定的答案');
      this.hashes[other] = message.hash;
      this.revealIfReady();
    } else if (message.type === 'reveal') {
      if (!this.hashes.every(Boolean)) throw new Error('双方提交前不能揭晓');
      if (typeof message.salt !== 'string' || !/^[a-f0-9]{32}$/.test(message.salt)) throw new Error('词语校验失败');
      const word = cleanWord(message.word);
      const hash = await commitment(this.sessionId, this.match, this.round, other, word, message.salt);
      if (hash !== this.hashes[other]) throw new Error('词语校验失败，请重新连接');
      this.words[other] = word;
      this.finishIfReady();
    } else if (message.type === 'ready' && this.phase !== 'writing') {
      this.ready[other] = true;
      this.advanceIfReady();
    }
    this.onChange();
  }

  readyNext() {
    if (this.phase === 'writing' || this.ready[this.seat]) return;
    this.ready[this.seat] = true;
    this.emit('ready');
    this.advanceIfReady();
    this.onChange();
  }

  advanceIfReady() {
    if (!this.ready.every(Boolean)) return;
    if (this.phase === 'matched') {
      this.match++;
      this.round = 1;
      this.history = [];
    } else {
      this.round++;
    }
    this.resetRound();
  }
}
