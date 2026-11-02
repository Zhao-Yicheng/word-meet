// 手写 OTS 客户端的本地联调脚本（不含密钥，凭据从环境变量读）。
// 用法：OTS_AK=xxx OTS_SK=yyy node scripts/ots-client-test.mjs
import { createOtsStore, createOtsTable } from '../edge/ots.mjs';

const ENDPOINT = process.env.OTS_ENDPOINT || 'https://word-meet.cn-shanghai.ots.aliyuncs.com';
const INSTANCE = process.env.OTS_INSTANCE || 'word-meet';
const TABLE = process.env.OTS_TABLE || 'rooms';
const AK = process.env.OTS_AK;
const SK = process.env.OTS_SK;

if (!AK || !SK) {
  console.error('缺少 OTS_AK / OTS_SK');
  process.exit(1);
}

const config = { endpoint: ENDPOINT, instance: INSTANCE, accessKeyId: AK, accessKeySecret: SK, table: TABLE };

const time = async (label, fn) => {
  const t0 = Date.now();
  try {
    const value = await fn();
    console.log(`✓ ${label} ${Date.now() - t0}ms`, typeof value === 'string' ? value.slice(0, 70) : JSON.stringify(value));
    return value;
  } catch (error) {
    console.log(`✗ ${label} ${Date.now() - t0}ms`, error.code || '', error.message || String(error));
    return undefined;
  }
};

console.log('建表:', await time('createTable', () => createOtsTable(config)));

const store = createOtsStore(config);
const key = 'TEST' + Date.now().toString(36).toUpperCase();
const payload = JSON.stringify({ code: key, hello: '相遇', ts: Date.now(), pad: 'x'.repeat(200) });

await time('put', () => store.put(key, payload));
const readBack = await time('get', () => store.get(key));
console.log('内容一致:', readBack === payload);
await time('get-missing', () => store.get(`NO_SUCH_${key}`));
await time('overwrite', () => store.put(key, JSON.stringify({ code: key, v: 2 })));
const second = await time('get-after-overwrite', () => store.get(key));
console.log('覆盖生效:', String(second).includes('"v":2'));
await time('delete', () => store.delete(key));
await time('get-after-delete', () => store.get(key));

const times = [];
for (let i = 0; i < 8; i += 1) {
  const t0 = Date.now();
  await store.put(key, JSON.stringify({ i }));
  await store.get(key);
  times.push(Date.now() - t0);
}
times.sort((a, b) => a - b);
console.log('put+get 往返 x8 (ms):', times.join(','), '| 中位', times[4]);
await store.delete(key);
