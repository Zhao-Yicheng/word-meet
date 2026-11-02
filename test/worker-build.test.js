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
    'src/host.js': "export function prettyHref(href) { return href; }\n",
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
  await cp(new URL('../edge/ots.mjs', import.meta.url), path.join(root, 'edge/ots.mjs'));
  await cp(new URL('../server/protocol.mjs', import.meta.url), path.join(root, 'server/protocol.mjs'));
  await writeFile(path.join(root, 'package.json'), JSON.stringify({ type: 'module' }));
  execFileSync(process.execPath, ['scripts/build.mjs'], { cwd: root, stdio: 'pipe' });
  execFileSync(process.execPath, ['scripts/buildesa.mjs'], { cwd: root, stdio: 'pipe' });
  return path.join(root, 'dist/esa/worker.js');
}

test('the bundled worker ships as one importless file with the site and room API', async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), 'word-meet-esa-build-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const workerFile = await buildWorker(root);

  const code = await readFile(workerFile, 'utf8');
  assert.doesNotMatch(code, /^\s*import\s/m, '单文件函数不能再有 import 语句');
  assert.match(code, /同词相遇/, '网页资源已内联');
  assert.match(code, /function createRoomApi/, '房间协议已内联');
  assert.match(code, /function createOtsStore/, 'Tablestore 客户端已内联');
  assert.match(code, /export default \{/);
  assert.ok(code.length < 4 * 1024 * 1024, '打包体积在 ESA 4MB 上限内');

  const worker = (await import(pathToFileURL(workerFile).href)).default;

  const page = await worker.fetch(new Request(ORIGIN + '/'));
  assert.equal(page.status, 200);
  assert.match(page.headers.get('Content-Type'), /text\/html/);
  assert.match(await page.text(), /同词相遇/);
  const missing = await worker.fetch(new Request(ORIGIN + '/nope'));
  assert.equal(missing.status, 404);
});

test('without function variables the worker reports a clear 503 instead of crashing', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'word-meet-esa-build-'));
  try {
    const workerFile = await buildWorker(root);
    const worker = (await import(pathToFileURL(workerFile).href)).default;

    const diagnose = await (await worker.fetch(postRoom({ action: 'diagnose' }), {}, {})).json();
    assert.equal(diagnose.hasEndpoint, false);
    assert.equal(diagnose.hasInstance, false);
    assert.equal(diagnose.storeReady, false, '缺变量时不构造存储');
    assert.equal(JSON.stringify(diagnose).includes('LTAI'), false, '诊断结果绝不回显密钥');

    const health = await worker.fetch(postRoom({ action: 'health' }), {}, {});
    assert.equal(health.status, 503);
    const body = await health.json();
    assert.equal(body.code, 'PT503');
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('the room API reports method and payload problems before touching storage', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'word-meet-esa-build-'));
  try {
    const workerFile = await buildWorker(root);
    const worker = (await import(pathToFileURL(workerFile).href)).default;

    const get = await worker.fetch(new Request(ORIGIN + '/api/room'));
    assert.equal(get.status, 405);
    assert.equal((await get.json()).code, 'PT405');

    const options = await worker.fetch(new Request(ORIGIN + '/api/room', { method: 'OPTIONS' }));
    assert.equal(options.status, 204);

    const broken = await worker.fetch(new Request(ORIGIN + '/api/room', { method: 'POST', body: 'not json' }));
    assert.equal(broken.status, 400);

    const huge = await worker.fetch(new Request(ORIGIN + '/api/room', { method: 'POST', body: 'x'.repeat(5000) }));
    assert.equal(huge.status, 413);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
