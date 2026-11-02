import { GameSession, parseRoomCode } from './game.js';
import { RoomConnection, cleanName } from './room.js';
import { prettyHref } from './host.js';

const $ = (id) => document.getElementById(id);
const state = { mode: 'create', busy: false, inRoom: false, connected: false, code: '', role: '', game: null, network: null, names: [], seat: 0, protocolError: false };
let inbox = Promise.resolve();
let renderedRound = '';
let renderedHistory = '';
let celebrated = '';
let toastTimer;

function showError(id, message) {
  $(id).textContent = message;
  $(id).hidden = !message;
}

function toast(message) {
  clearTimeout(toastTimer);
  $('toast').textContent = message;
  $('toast').hidden = false;
  toastTimer = setTimeout(() => { $('toast').hidden = true; }, 3200);
}

function setBusy(busy) {
  state.busy = busy;
  $('entry-submit').disabled = busy;
  $('nickname').disabled = busy;
  $('room-code').disabled = busy;
  $('create-tab').disabled = busy;
  $('join-tab').disabled = busy;
  $('entry-submit-text').textContent = busy ? '正在连接…' : state.mode === 'create' ? '创建房间' : '加入房间';
}

function setMode(mode) {
  if (state.busy) return;
  state.mode = mode;
  for (const current of ['create', 'join']) {
    $(current + '-tab').setAttribute('aria-selected', String(mode === current));
    $(current + '-tab').tabIndex = mode === current ? 0 : -1;
  }
  $('entry-panel').setAttribute('aria-labelledby', mode + '-tab');
  $('room-code-field').hidden = mode !== 'join';
  $('room-code').required = mode === 'join';
  $('entry-description').textContent = mode === 'create' ? '创建房间，把邀请链接发给另一位玩家。' : '输入房间码或邀请链接，加入已有房间。';
  showError('entry-error', '');
  setBusy(false);
}

function inviteURL() {
  const url = new URL(location.href);
  url.search = '';
  url.hash = new URLSearchParams({ room: state.code }).toString();
  return prettyHref(url.href);
}

// 系统分享面板要的是严格合法的 ASCII URL，中文域名交给它可能被拒绝或被二次编码。
function shareURL() {
  const url = new URL(location.href);
  url.search = '';
  url.hash = new URLSearchParams({ room: state.code }).toString();
  return url.href;
}

function enterRoom(code) {
  state.code = code;
  state.inRoom = true;
  setBusy(false);
  $('home').hidden = true;
  $('room').hidden = false;
  $('display-code').textContent = code.slice(0, 4) + '-' + code.slice(4);
  $('invite-url').value = inviteURL();
  $('share-url').value = inviteURL();
  $('waiting-name').textContent = state.name;
  // 地址栏交给浏览器自己显示中文域名，这里只写 ASCII 形式，避免历史记录里出现编码差异。
  history.replaceState(null, '', shareURL());
}

function connectionStatus(text, status) {
  $('connection-status').textContent = text;
  $('connection-status').dataset.state = status;
}

function showConnectionBanner(message) {
  $('connection-banner').hidden = !message;
  $('connection-message').textContent = message;
  $('reconnect-button').textContent = state.role === 'host' ? '重新建房' : '重新连接';
  $('reconnect-button').hidden = false;
}

function startConnection(role, code) {
  const resumeToken = role === 'guest' && state.lastGuest?.code === code ? state.lastGuest.token : undefined;
  state.network?.dispose();
  state.role = role;
  state.connected = false;
  state.protocolError = false;
  state.game = null;
  inbox = Promise.resolve();
  renderedRound = '';
  renderedHistory = '';
  celebrated = '';
  setBusy(true);
  showError('entry-error', '');
  showError('word-error', '');
  showConnectionBanner('');
  if (state.inRoom) {
    $('waiting').hidden = false;
    $('game').hidden = true;
    connectionStatus('正在连接', 'connecting');
  }
  const network = new RoomConnection((event) => {
    if (state.network !== network) return;
    if (event.type === 'waiting') {
      enterRoom(event.code);
      $('waiting').hidden = false;
      $('game').hidden = true;
      connectionStatus('等待玩家加入', 'online');
    } else if (event.type === 'connected') {
      enterRoom(event.code);
      state.connected = true;
      state.protocolError = false;
      state.seat = event.seat;
      if (event.seat === 1) state.lastGuest = { code: event.code, token: network.token };
      state.names = event.seat === 0 ? [state.name, event.otherName] : [event.otherName, state.name];
      $('waiting').hidden = true;
      $('game').hidden = false;
      showConnectionBanner('');
      connectionStatus('两人已连接', 'online');
      const game = new GameSession({
        sessionId: event.sessionId, seat: event.seat,
        send: (message) => network.send(message),
        onChange: () => { if (state.game === game) renderGame(); },
      });
      state.game = game;
      renderGame();
      $('word-input').focus({ preventScroll: true });
    } else if (event.type === 'message') {
      const game = state.game;
      inbox = inbox.then(async () => {
        if (state.network === network && state.game === game && !state.protocolError) await game?.receive(event.message);
      }).catch((error) => {
        if (state.network !== network || state.game !== game) return;
        state.protocolError = true;
        showError('word-error', error.message);
        showConnectionBanner('本局的信息校验出现问题，请重新连接后再玩。');
        renderGame();
      });
    } else if (event.type === 'disconnected') {
      state.connected = false;
      connectionStatus('连接已断开', 'error');
      showConnectionBanner(event.message);
      renderGame();
    } else if (event.type === 'retrying' || event.type === 'peer-offline') {
      state.connected = false;
      connectionStatus(event.type === 'retrying' ? '正在恢复连接' : '等待对方上线', 'connecting');
      showConnectionBanner(event.message);
      $('reconnect-button').hidden = true;
      renderGame();
    } else if (event.type === 'online') {
      state.connected = event.connected;
      connectionStatus(event.connected ? '两人已连接' : '等待玩家加入', 'online');
      showConnectionBanner('');
      renderGame();
    } else if (event.type === 'error') {
      state.connected = false;
      setBusy(false);
      if (state.inRoom) {
        connectionStatus('连接未成功', 'error');
        showConnectionBanner(event.message);
        renderGame();
      } else showError('entry-error', event.message);
    }
  });
  state.network = network;
  try {
    if (role === 'host') network.host(state.name, code);
    else network.join(state.name, code, resumeToken);
  } catch (error) {
    network.dispose();
    setBusy(false);
    if (state.inRoom) showConnectionBanner(error.message);
    else showError('entry-error', error.message);
  }
}

function renderGame() {
  if (!state.game) return;
  const view = state.game.view;
  const own = state.seat;
  const other = 1 - own;
  const revealed = view.phase !== 'writing';
  const matched = view.phase === 'matched';
  const active = state.connected && !state.protocolError;
  $('game').classList.toggle('is-complete', matched);
  $('round-board').hidden = matched;
  $('result-message').hidden = matched;
  const key = `${state.game.sessionId}-${view.match}-${view.round}`;
  if (key !== renderedRound) {
    $('word-input').value = '';
    showError('word-error', '');
    renderedRound = key;
    $('word-hint').textContent = '1–20 字 · 双方锁定后同时揭晓 · Enter 提交';
  }
  $('round-number').textContent = String(view.round).padStart(2, '0');
  $('round-description').textContent = matched ? '双方词语相同，本局结束。' : revealed ? '根据这两个词，继续联想。' : view.round === 1 ? '第一轮可以输入任意词语。' : '结合上轮的两个词，输入一个新的关联词。';
  $('match-label').textContent = matched ? '游戏成功' : '双人联想';
  $('own-name').textContent = state.names[own];
  $('other-name').textContent = state.names[other];
  $('history-own-label').textContent = state.names[own] + '（你）';
  $('history-other-label').textContent = state.names[other];
  const previous = view.history.find((entry) => entry.round === view.round - 1);
  $('previous-words').hidden = !previous || revealed;
  if (previous) {
    $('previous-own').textContent = previous.words[own];
    $('previous-other').textContent = previous.words[other];
  }
  const ownWord = revealed ? view.words[own] : view.ownWord;
  const otherWord = revealed ? view.words[other] : '';
  for (const [prefix, word, index] of [['own', ownWord, own], ['other', otherWord, other]]) {
    $(prefix + '-word').textContent = word || (view.committed[index] ? '•••' : '?');
    $(prefix + '-word').classList.toggle('has-word', Boolean(word));
    $(prefix + '-word').classList.toggle('long-word', Boolean(word && [...word].length > 6));
    $(prefix + '-status').textContent = revealed ? (matched ? '相同' : '已揭晓') : view.committed[index] ? '✓ 已锁定' : '未提交';
    $(prefix + '-status').dataset.locked = String(view.committed[index]);
  }
  $('own-word-note').textContent = revealed ? (matched ? '双方词语相同' : '已揭晓') : view.committed[own] ? '已锁定，等待对方提交' : '输入后点击「锁定词语」';
  $('other-word-note').textContent = revealed ? (matched ? '双方词语相同' : '已揭晓') : view.committed[other] ? '对方已锁定，等待你提交' : '对方尚未提交';
  $('player-cards').classList.toggle('revealed', revealed);
  $('player-cards').classList.toggle('matched', matched);
  $('between-cards').textContent = matched ? '=' : '&';
  $('word-form').hidden = revealed || view.committed[own];
  $('word-input').disabled = !active || view.submitting;
  $('word-submit').disabled = !active || view.submitting;
  $('submitted-message').hidden = revealed || !view.committed[own];
  $('round-result').hidden = !revealed;
  $('result-message').textContent = matched ? `成功，共用 ${view.round} 轮。` : '词语不同，继续下一轮。';
  $('next-button').disabled = !active || view.ready[own];
  $('next-button').textContent = view.ready[own] ? '等待对方准备…' : matched ? '再来一局' : '继续联想 →';
  $('ready-note').textContent = view.ready[own] ? '你已准备，等待对方确认。' : view.ready[other] ? '对方已准备，点击即可继续。' : matched ? '双方确认后开始新的一局。' : '双方准备后开始下一轮。';
  const historyKey = `${state.game.sessionId}-${view.match}-${view.history.length}-${matched}`;
  $('history-section').hidden = view.history.length === 0;
  $('history-title').textContent = matched ? '本局总览' : '对局记录';
  $('history-title').setAttribute('aria-level', matched ? '2' : '3');
  if (historyKey !== renderedHistory) {
    if (matched) $('game-controls').before($('history-section'));
    else $('game-controls').after($('history-section'));
    $('history-list').replaceChildren(...view.history.map((entry) => {
      const li = document.createElement('li');
      li.className = (matched ? 'journey-step' : 'history-row') + (entry.matched ? ' matched' : '');
      const number = document.createElement('span');
      number.textContent = String(entry.round).padStart(2, '0');
      number.className = matched ? 'journey-round' : '';
      number.setAttribute('aria-label', `第 ${entry.round} 轮`);
      li.append(number);
      if (matched && entry.matched) {
        const shared = document.createElement('div');
        shared.className = 'journey-word journey-merged';
        const label = document.createElement('small');
        label.textContent = '双方相同';
        const word = document.createElement('bdi');
        word.textContent = entry.words[own];
        shared.append(label, word);
        li.append(shared);
      } else {
        for (const index of [own, other]) {
          const word = document.createElement('bdi');
          word.textContent = entry.words[index];
          if (matched) {
            const node = document.createElement('div');
            node.className = 'journey-word ' + (index === own ? 'journey-own' : 'journey-other');
            node.append(word);
            li.append(node);
          } else li.append(word);
        }
      }
      return li;
    }));
    $('history-count').textContent = matched ? `共 ${view.history.length} 轮` : `${String(view.history.length).padStart(2, '0')} ROUND${view.history.length === 1 ? '' : 'S'}`;
    renderedHistory = historyKey;
  }
  if (matched && celebrated !== key) {
    celebrated = key;
    $('history-title').tabIndex = -1;
    $('history-title').focus();
    celebrate();
  }
}

function celebrate() {
  if (matchMedia('(prefers-reduced-motion: reduce)').matches) return;
  $('confetti').replaceChildren();
  const colors = ['#e8b295', '#9db88a', '#dfcd8c', '#d97558', '#b8c7a4'];
  for (let index = 0; index < 28; index++) {
    const piece = document.createElement('i');
    piece.style.setProperty('--x', `${5 + Math.random() * 90}%`);
    piece.style.setProperty('--delay', `${Math.random() * .7}s`);
    piece.style.setProperty('--rotation', `${Math.random() * 180}deg`);
    piece.style.setProperty('--color', colors[index % colors.length]);
    $('confetti').append(piece);
  }
  setTimeout(() => $('confetti').replaceChildren(), 3800);
}

function leaveRoom() {
  state.network?.dispose();
  state.network = null;
  state.game = null;
  state.inRoom = false;
  state.connected = false;
  $('room').hidden = true;
  $('home').hidden = false;
  $('confetti').replaceChildren();
  history.replaceState(null, '', location.pathname);
  showError('entry-error', '');
  showConnectionBanner('');
  setBusy(false);
  $('nickname').focus({ preventScroll: true });
}

async function copy(text, field) {
  try {
    if (!navigator.clipboard?.writeText) throw new Error('Clipboard unavailable');
    await navigator.clipboard.writeText(text);
    toast('邀请链接已复制');
    return true;
  } catch {
    if (field) {
      field.focus();
      field.select();
      field.setSelectionRange(0, text.length);
    }
    toast('请长按或按 ⌘C / Ctrl+C 复制链接。');
    return false;
  }
}

function openShare() {
  $('share-url').value = inviteURL();
  $('share-note').textContent = state.connected ? '房间已有两人。重新加入会开始新局。' : '对方打开链接后输入昵称即可加入。每个房间最多两人。';
  $('native-share').hidden = typeof navigator.share !== 'function';
  $('share-dialog').showModal();
}

$('create-tab').addEventListener('click', () => setMode('create'));
$('join-tab').addEventListener('click', () => setMode('join'));
for (const tab of ['create-tab', 'join-tab']) {
  $(tab).addEventListener('keydown', (event) => {
    if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return;
    event.preventDefault();
    const mode = event.key === 'Home' ? 'create' : event.key === 'End' ? 'join' : state.mode === 'create' ? 'join' : 'create';
    setMode(mode);
    $(mode + '-tab').focus();
  });
}
$('entry-form').addEventListener('submit', (event) => {
  event.preventDefault();
  if (state.busy) return;
  try {
    state.name = cleanName($('nickname').value);
    const code = state.mode === 'join' ? parseRoomCode($('room-code').value) : undefined;
    try { localStorage.setItem('word-meet-nickname', state.name); } catch { /* Storage is optional. */ }
    startConnection(state.mode === 'create' ? 'host' : 'guest', code);
  } catch (error) { showError('entry-error', error.message); }
});
$('word-form').addEventListener('submit', async (event) => {
  event.preventDefault();
  if (!state.game || !state.connected || state.protocolError) return;
  showError('word-error', '');
  const game = state.game;
  try { await game.submit($('word-input').value); }
  catch (error) { if (state.game === game) showError('word-error', error.message); }
});
$('word-input').addEventListener('input', () => {
  const length = [...$('word-input').value.trim()].length;
  $('word-hint').textContent = length ? `${length} / 20 字 · 双方锁定后同时揭晓` : '1–20 字 · 双方锁定后同时揭晓 · Enter 提交';
  showError('word-error', '');
});
$('next-button').addEventListener('click', () => {
  if (!state.connected || state.protocolError) return;
  try { state.game?.readyNext(); }
  catch (error) { showError('word-error', error.message); }
});
$('reconnect-button').addEventListener('click', () => {
  if (state.busy) return;
  startConnection(state.role, state.role === 'guest' ? state.code : undefined);
});
$('leave-button').addEventListener('click', leaveRoom);
$('brand-link').addEventListener('click', (event) => {
  if (state.inRoom || state.busy) { event.preventDefault(); leaveRoom(); }
});
$('rules-button').addEventListener('click', () => $('rules-dialog').showModal());
for (const button of document.querySelectorAll('[data-close-dialog]')) button.addEventListener('click', () => button.closest('dialog').close());
for (const dialog of document.querySelectorAll('dialog')) {
  dialog.addEventListener('click', (event) => {
    if (event.target !== dialog) return;
    const rect = dialog.getBoundingClientRect();
    if (event.clientX < rect.left || event.clientX > rect.right || event.clientY < rect.top || event.clientY > rect.bottom) dialog.close();
  });
}
$('invite-button').addEventListener('click', openShare);
$('copy-invite').addEventListener('click', () => copy(inviteURL(), $('invite-url')));
$('share-copy').addEventListener('click', () => copy(inviteURL(), $('share-url')));
$('invite-url').addEventListener('click', () => $('invite-url').select());
$('share-url').addEventListener('click', () => $('share-url').select());
$('copy-code').addEventListener('click', async () => {
  try {
    await navigator.clipboard.writeText(state.code);
    toast('房间码已复制：' + state.code.slice(0, 4) + '-' + state.code.slice(4));
  } catch { openShare(); }
});
$('native-share').addEventListener('click', async () => {
  try { await navigator.share({ title: '同词相遇 · 双人联想游戏', text: '邀请你加入同词相遇房间。', url: shareURL() }); }
  catch (error) { if (error.name !== 'AbortError') toast('分享未完成，可以复制邀请链接。'); }
});
document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible') state.network?.ping(); });
window.addEventListener('pagehide', () => state.network?.dispose());
window.addEventListener('pageshow', (event) => { if (event.persisted) { leaveRoom(); toast('页面已恢复，重新加入就能开始。'); } });

try { $('nickname').value = localStorage.getItem('word-meet-nickname') || ''; } catch { /* Storage is optional. */ }
if (new URLSearchParams(location.hash.slice(1)).has('room')) {
  try {
    const code = parseRoomCode(location.href);
    $('room-code').value = code.slice(0, 4) + '-' + code.slice(4);
    setMode('join');
    $('entry-description').textContent = '已收到房间邀请，输入昵称即可加入。';
  } catch { setMode('join'); showError('entry-error', '邀请链接里的房间码不完整，请让朋友重新分享。'); }
}
