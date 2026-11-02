import test from 'node:test';
import assert from 'node:assert/strict';
import { GameSession, cleanWord, parseRoomCode } from '../src/game.js';

function pair() {
  const queue = [];
  const players = [0, 1].map((seat) => new GameSession({
    sessionId: 'test-session', seat,
    send: (message) => queue.push({ to: 1 - seat, message }),
  }));
  return {
    players, queue,
    async flush() {
      for (let count = 0; queue.length; count++) {
        assert.ok(count < 100, 'protocol must not loop');
        const { to, message } = queue.shift();
        await players[to].receive(message);
      }
    },
  };
}

test('words keep meaningful differences while trimming their boundaries', () => {
  assert.equal(cleanWord('  月亮  '), '月亮');
  assert.equal(cleanWord('a  b'), 'a  b');
  assert.equal(cleanWord('e\u0301'), 'é');
  for (const invalid of ['', '   ', '月\n亮', '词'.repeat(21)]) {
    assert.throws(() => cleanWord(invalid));
  }
});

test('room entry accepts a code or our invitation link and rejects other input', () => {
  assert.equal(parseRoomCode('abcd-2345'), 'ABCD2345');
  assert.equal(parseRoomCode('https://example.com/word-meet/#room=ABCD2345'), 'ABCD2345');
  // 中文域名不论带不带协议头都要能认出来（邀请链接显示的就是中文域名）。
  assert.equal(parseRoomCode('https://word-meet.奶龙传媒学院.com/#room=ABCD2345'), 'ABCD2345');
  assert.equal(parseRoomCode('word-meet.奶龙传媒学院.com/#room=ABCD2345'), 'ABCD2345');
  assert.equal(parseRoomCode('https://word-meet.xn--dpqu5wnyaiyf17sktl.com/#room=ABCD2345'), 'ABCD2345');
  for (const invalid of ['', 'ABC12345', 'javascript:alert(1)', 'ABCDEFGH-extra', 'word-meet.奶龙传媒学院.com']) {
    assert.throws(() => parseRoomCode(invalid));
  }
});

test('a first submission transmits a salted commitment without the word', async () => {
  const game = pair();
  await game.players[0].submit('月亮');
  assert.equal(game.queue.length, 1);
  assert.equal(game.queue[0].message.type, 'commit');
  assert.equal(JSON.stringify(game.queue).includes('月亮'), false);
  await game.flush();
  assert.equal(game.players[1].view.phase, 'writing');
  assert.equal(game.players[1].view.words[0], null);
  assert.equal(game.players[1].view.committed[0], true);
});

test('both players reveal the same ordered history and must both be ready to advance', async () => {
  const game = pair();
  await Promise.all([game.players[0].submit('月亮'), game.players[1].submit('兔子')]);
  await game.flush();
  for (const player of game.players) {
    assert.equal(player.view.phase, 'revealed');
    assert.deepEqual(player.view.history, [{ round: 1, words: ['月亮', '兔子'], matched: false }]);
  }
  game.players[0].readyNext();
  await game.flush();
  assert.equal(game.players[0].view.round, 1);
  assert.equal(game.players[1].view.round, 1);
  game.players[1].readyNext();
  await game.flush();
  for (const player of game.players) {
    assert.equal(player.view.round, 2);
    assert.equal(player.view.phase, 'writing');
    assert.deepEqual(player.view.committed, [false, false]);
  }
});

test('an exact match wins and rematch needs agreement from both players', async () => {
  const game = pair();
  await Promise.all([game.players[0].submit(' 玉兔 '), game.players[1].submit('玉兔')]);
  await game.flush();
  assert.equal(game.players[0].view.phase, 'matched');
  assert.equal(game.players[1].view.phase, 'matched');
  game.players[0].readyNext();
  await game.flush();
  assert.equal(game.players[0].view.match, 1);
  game.players[1].readyNext();
  await game.flush();
  for (const player of game.players) {
    assert.equal(player.view.match, 2);
    assert.equal(player.view.round, 1);
    assert.deepEqual(player.view.history, []);
  }
});

test('case and punctuation do not produce an accidental match', async () => {
  const game = pair();
  await Promise.all([game.players[0].submit('Moon'), game.players[1].submit('moon')]);
  await game.flush();
  assert.equal(game.players[0].view.phase, 'revealed');
});

test('concurrent clicks cannot change the locked answer', async () => {
  const game = pair();
  const first = game.players[0].submit('月亮');
  await assert.rejects(game.players[0].submit('太阳'));
  await first;
  assert.equal(game.queue.length, 1);
  assert.equal(game.players[0].view.ownWord, '月亮');
});

test('tampered reveals cannot enter the history', async () => {
  const game = pair();
  await Promise.all([game.players[0].submit('月亮'), game.players[1].submit('兔子')]);
  const first = game.queue.shift();
  await game.players[first.to].receive(first.message);
  const second = game.queue.shift();
  await game.players[second.to].receive(second.message);
  const reveal = game.queue.shift();
  reveal.message.word = '伪造';
  await assert.rejects(game.players[reveal.to].receive(reveal.message), /校验/);
  assert.deepEqual(game.players[reveal.to].view.history, []);
});

test('duplicate deliveries are idempotent and old-round packets cannot affect a new round', async () => {
  const game = pair();
  await Promise.all([game.players[0].submit('月亮'), game.players[1].submit('兔子')]);
  const stale = structuredClone(game.queue[0]);
  game.queue.push(structuredClone(game.queue[0]));
  await game.flush();
  assert.equal(game.players[0].view.history.length, 1);
  assert.equal(game.players[1].view.history.length, 1);
  game.players[0].readyNext();
  game.players[1].readyNext();
  await game.flush();
  await game.players[stale.to].receive(stale.message);
  assert.deepEqual(game.players[stale.to].view.committed, [false, false]);
  assert.equal(game.players[stale.to].view.history.length, 1);
});

test('an early reveal and malformed commitment are rejected', async () => {
  const game = pair();
  const envelope = { v: 1, sessionId: 'test-session', match: 1, round: 1 };
  await assert.rejects(game.players[0].receive({ ...envelope, type: 'reveal', word: '偷看', salt: 'a'.repeat(32) }));
  await assert.rejects(game.players[0].receive({ ...envelope, type: 'commit', hash: 'bad' }));
  assert.equal(game.players[0].view.words[1], null);
});
