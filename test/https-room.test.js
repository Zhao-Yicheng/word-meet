import test from 'node:test';
import assert from 'node:assert/strict';
import { RoomConnection } from '../src/room.js';
import { GameSession } from '../src/game.js';
import { roomServer } from './support/http-server.js';

function player(t, endpoint) {
  const events = [];
  const listeners = new Set();
  let game;
  let inbox = Promise.resolve();
  function notify(event) { events.push(event); for (const listener of listeners) listener(event); }
  const room = new RoomConnection((event) => {
    if (event.type === 'connected') game = new GameSession({
      sessionId: event.sessionId, seat: event.seat,
      send: (message) => room.send(message), onChange: () => notify({ type: 'game-change' }),
    });
    if (event.type === 'message') inbox = inbox.then(() => game.receive(event.message)).catch((error) => notify({ type: 'error', message: error.message }));
    notify(event);
  }, { endpoint });
  t.after(() => room.dispose());
  function wait(type, predicate = () => true) {
    const existing = events.find((event) => event.type === type && predicate(event));
    if (existing) return Promise.resolve(existing);
    const error = events.find((event) => event.type === 'error');
    if (error) return Promise.reject(new Error(error.message));
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { listeners.delete(listener); reject(new Error('Timed out waiting for ' + type)); }, 8000);
      const listener = (event) => {
        if (event.type === 'error' && type !== 'error') { clearTimeout(timer); listeners.delete(listener); reject(new Error(event.message)); }
        else if (event.type === type && predicate(event)) { clearTimeout(timer); listeners.delete(listener); resolve(event); }
      };
      listeners.add(listener);
    });
  }
  return { room, events, get game() { return game; }, wait, phase: (phase) => wait('game-change', () => game?.view.phase === phase) };
}

async function pair(t, endpoint) {
  const host = player(t, endpoint);
  host.room.host('甲');
  const waiting = await host.wait('waiting');
  const guest = player(t, endpoint);
  guest.room.join('乙', waiting.code);
  await Promise.all([host.wait('connected'), guest.wait('connected')]);
  return { host, guest, code: waiting.code };
}

test('two clients complete a multi-round game over HTTP with no PeerJS or WebRTC APIs', async (t) => {
  assert.equal(globalThis.RTCPeerConnection, undefined);
  assert.equal(globalThis.Peer, undefined);
  const server = await roomServer(t);
  const { host, guest } = await pair(t, server.endpoint);
  await Promise.all([host.game.submit('月亮'), guest.game.submit('兔子')]);
  await Promise.all([host.phase('revealed'), guest.phase('revealed')]);
  host.game.readyNext();
  guest.game.readyNext();
  await Promise.all([host.wait('game-change', () => host.game.view.round === 2), guest.wait('game-change', () => guest.game.view.round === 2)]);
  await Promise.all([host.game.submit('玉兔'), guest.game.submit('玉兔')]);
  await Promise.all([host.phase('matched'), guest.phase('matched')]);
  assert.deepEqual(host.game.view.history.map((entry) => entry.words), [['月亮', '兔子'], ['玉兔', '玉兔']]);
  assert.deepEqual(host.game.view.history, guest.game.view.history);
});

test('a third client is rejected and leaving releases the guest seat', async (t) => {
  const server = await roomServer(t);
  const { host, guest, code } = await pair(t, server.endpoint);
  const third = player(t, server.endpoint);
  third.room.join('丙', code);
  const rejected = await third.wait('error');
  assert.match(rejected.message, /已满/);
  const oldSession = host.game.sessionId;
  guest.room.dispose();
  await host.wait('disconnected');
  const replacement = player(t, server.endpoint);
  replacement.room.join('丁', code);
  await Promise.all([replacement.wait('connected'), host.wait('connected', (event) => event.sessionId !== oldSession)]);
  assert.notEqual(host.game.sessionId, oldSession);
});

test('temporary HTTP failure retains a submitted word and recovers without restarting the round', async (t) => {
  const server = await roomServer(t);
  const { host, guest } = await pair(t, server.endpoint);
  const sessionId = host.game.sessionId;
  server.setUnavailable(true);
  await host.game.submit('月亮');
  await host.wait('retrying');
  server.setUnavailable(false);
  await host.wait('online');
  await guest.game.submit('兔子');
  await Promise.all([host.phase('revealed'), guest.phase('revealed')]);
  assert.equal(host.game.sessionId, sessionId);
  assert.deepEqual(host.game.view.words, ['月亮', '兔子']);
});

test('closing the host room reports room closure to the guest', async (t) => {
  const server = await roomServer(t);
  const { host, guest } = await pair(t, server.endpoint);
  host.room.dispose();
  const closed = await guest.wait('error');
  assert.match(closed.message, /关闭|过期/);
});

test('a guest can rejoin before its previous page releases the seat', async (t) => {
  const server = await roomServer(t);
  const { host, guest, code } = await pair(t, server.endpoint);
  const previousSession = host.game.sessionId;
  const replacement = player(t, server.endpoint);
  replacement.room.join('乙', code, guest.room.token);
  await Promise.all([replacement.wait('connected'), host.wait('connected', (event) => event.sessionId !== previousSession)]);
  guest.room.dispose();
  await Promise.all([host.game.submit('同词'), replacement.game.submit('同词')]);
  await Promise.all([host.phase('matched'), replacement.phase('matched')]);
});
