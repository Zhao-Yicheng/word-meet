import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, cp, writeFile, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';

const ORIGIN = 'https://word-meet.example.com';

function postRoom(body) {
  return new Request(ORIGIN + '/api/room', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
}

async function buildWorker(root) {
  const files = {
    'index.html': '<!doctype html><title>同词相遇</title><link rel="stylesheet" href="./src/style.css"><script type="module" src="./src/main.js"></script>',
    'src/main.js': "import './room.js';\nconsole.log('main');",
    'src/game.js': "export const value = 'game';\n",
    'src/room.js': "import './config.js';\nconsole.log('room');",
    'src/config.js': 'export const ROOM_ENDPOINT = "";',
    'src/style.css': 'body{color:#f5f2eb}',
    'public/favicon.svg': '<svg/>',
  };
  for (const [name, content] of Object.entries(files)) {
    await mkdir(path.dirname(path.join(root, name)), { recursive: true });
    await writeFile(path.join(root, name), content);
  }
  for (const dir of ['scripts', 'edge', 'server']) await mkdir(path.join(root, dir), { recursive: true });
  await cp(new URL('../scripts/build.mjs', import.meta.url), path.join(root, 'scripts/build.mjs'));
  await cp(new URL('../scripts/buildesa.mjs', import.meta.url), path.join(root, 'scripts/buildesa.mjs'));
  await cp(new URL('../edge/worker.mjs', import.meta.url), path.join(root, 'edge/worker.mjs'));
  await cp(new URL('../server/protocol.mjs', import.meta.url), path.join(root, 'server/protocol.mjs'));
  await writeFile(path.join(root, 'package.json'), JSON.stringify({ type: 'module' }));
  execFileSync(process.execPath, ['scripts/build.mjs'], { cwd: root, stdio: 'pipe' });
  execFileSync(process.execPath, ['scripts/buildesa.mjs'], { cwd: root, stdio: 'pipe' });
  return path.join(root, 'dist/esa/worker.js');
}

test('the bundled worker serves the site and completes a two-player game in one file', async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), 'word-meet-esa-build-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const workerFile = await buildWorker(root);

  const code = await readFile(workerFile, 'utf8');
  assert.doesNotMatch(code, /^\s*import\s/m, '单文件函数不能再有 import 语句');
  assert.match(code, /同词相遇/, '网页资源已内联');
  assert.match(code, /function createRoomApi/, '房间协议已内联');
  assert.match(code, /export default \{/);

  const store = new Map();
  globalThis.EdgeKV = class {
    constructor({ namespace }) { this.namespace = namespace; }
    async get(key) { return store.get(this.namespace + ':' + key); }
    async put(key, value) { store.set(this.namespace + ':' + key, value); }
    async delete(key) { store.delete(this.namespace + ':' + key); return true; }
  };
  const worker = (await import(pathToFileURL(workerFile).href)).default;

  const page = await worker.fetch(new Request(ORIGIN + '/'));
  assert.equal(page.status, 200);
  assert.match(page.headers.get('Content-Type'), /text\/html/);
  assert.match(await page.text(), /同词相遇/);
  const missing = await worker.fetch(new Request(ORIGIN + '/nope'));
  assert.equal(missing.status, 404);

  const health = await (await worker.fetch(postRoom({ action: 'health' }))).json();
  assert.deepEqual(health, { ok: true, transport: 'esa', protocol: 3 });

  const host = await (await worker.fetch(postRoom({ action: 'create', name: '甲' }))).json();
  assert.equal(host.seat, 0);
  assert.match(host.code, /^[A-HJ-NP-Z2-9]{8}$/);
  const guest = await (await worker.fetch(postRoom({ action: 'join', code: host.code, name: '乙' }))).json();
  assert.equal(guest.seat, 1);
  assert.equal(typeof guest.sessionId, 'string');
  assert.notEqual(guest.sessionId, host.sessionId);

  const base = { v: 1, sessionId: guest.sessionId, match: 1, round: 1 };
  for (const player of [host, guest]) {
    const reply = await worker.fetch(postRoom({ action: 'messages', code: host.code, token: player.token, id: player.seat + '-one', message: { ...base, type: 'commit', hash: (player.seat ? 'b' : 'a').repeat(64) } }));
    assert.equal(reply.status, 200, '消息写入成功');
  }
  const polled = await (await worker.fetch(postRoom({ action: 'poll', code: host.code, token: guest.token, after: 0 }))).json();
  assert.equal(polled.messages.length, 2);
  assert.deepEqual(polled.messages.map((message) => message.payload.hash), ['a'.repeat(64), 'b'.repeat(64)]);
});
