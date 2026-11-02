// 本地 OTS 连通性 / 延迟探针（仅开发用，凭据从环境变量读，绝不入库）。
// 用法：
//   OTS_AK=xxx OTS_SK=yyy node scripts/ots-probe.mjs
import TableStore from 'tablestore';

const { OTS_AK, OTS_SK } = process.env;
const ENDPOINT = process.env.OTS_ENDPOINT || 'https://word-meet.cn-shanghai.ots.aliyuncs.com';
const INSTANCE = process.env.OTS_INSTANCE || 'word-meet';
const TABLE = process.env.OTS_TABLE || 'rooms';

if (!OTS_AK || !OTS_SK) {
  console.error('缺少 OTS_AK / OTS_SK 环境变量');
  process.exit(1);
}

const client = new TableStore.Client({
  accessKeyId: OTS_AK,
  secretAccessKey: OTS_SK,
  endpoint: ENDPOINT,
  instancename: INSTANCE,
  maxRetries: 2,
});

const ms = async (label, fn) => {
  const t0 = Date.now();
  try {
    const res = await fn();
    console.log(`✓ ${label} ${Date.now() - t0}ms`, res === undefined ? '' : JSON.stringify(res).slice(0, 160));
    return res;
  } catch (err) {
    console.log(`✗ ${label} ${Date.now() - t0}ms`, err.code || '', err.message || String(err));
    return null;
  }
};

await ms('ListTable', async () => (await client.listTable()).table_names);

const tables = await ms('ListTable2', async () => (await client.listTable()).table_names);
if (!tables || !tables.includes(TABLE)) {
  await ms('CreateTable', async () => {
    await client.createTable(
      TABLE,
      { tableName: TABLE, primaryKey: [{ name: 'code', type: TableStore.PrimaryKeyType.STRING }] },
      { timeToLive: 3600, maxVersions: 1 },
      { read: 0, write: 0 },
    );
    return 'created';
  });
}

const key = [{ code: 'PROBE01' }];
const payload = JSON.stringify({ hello: 'world', ts: Date.now() });

await ms('PutRow', async () => {
  await client.putRow(TABLE, { primaryKey: key, attributeColumns: [{ data: payload }] });
  return 'ok';
});
await ms('GetRow', async () => {
  const r = await client.getRow(TABLE, { primaryKey: key, maxVersions: 1 });
  return r.row;
});
await ms('DeleteRow', async () => {
  await client.deleteRow(TABLE, { primaryKey: key });
  return 'ok';
});
await ms('GetRow-after-delete', async () => {
  const r = await client.getRow(TABLE, { primaryKey: key, maxVersions: 1 });
  return r.row ? 'still-there' : 'gone';
});

// 连续 10 次 GetRow 看延迟分布
const times = [];
for (let i = 0; i < 10; i += 1) {
  const t0 = Date.now();
  await client.getRow(TABLE, { primaryKey: key, maxVersions: 1 });
  times.push(Date.now() - t0);
}
times.sort((a, b) => a - b);
console.log('GetRow x10 延迟 ms:', times.join(','), '中位:', times[5]);
