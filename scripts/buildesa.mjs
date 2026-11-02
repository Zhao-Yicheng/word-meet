// 把边缘函数、房间协议和 dist/ 静态资源打包成单个 ESA 边缘函数文件。
// 输出 dist/esa/worker.js：没有 import 语句，可直接粘贴进 ESA 控制台代码编辑器。
// 用法：先 npm run build 生成 dist/，再运行本脚本（或直接 npm run build:esa）。

import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const root = fileURLToPath(new URL('../', import.meta.url));
const entry = path.join(root, 'edge/worker.mjs');
const output = path.join(root, 'dist/esa/worker.js');

const IMPORT_RE = /^import\s+(?:(\w+)\s+from|\{([^}]+)\}\s+from)\s+['"]([^'"]+)['"];?\s*$/gm;
const EXPORT_PREFIX_RE = /^export\s+/gm;

function jsString(value) {
  return JSON.stringify(value).replace(/\u2028/g, '\\u2028').replace(/\u2029/g, '\\u2029');
}

async function readModuleCode(file) {
  const source = await readFile(file, 'utf8');
  if (/\bexport\s*\{/.test(source) || /\bexport\s+default\b/.test(source)) {
    throw new Error(`${file} 使用了 buildesa 不支持的 export 写法（只允许 export const/function/async function）`);
  }
  return source.replace(EXPORT_PREFIX_RE, '');
}

async function bundle(entryFile) {
  const source = await readFile(entryFile, 'utf8');
  const base = path.dirname(entryFile);
  let result = '';
  let cursor = 0;
  for (const match of source.matchAll(IMPORT_RE)) {
    result += source.slice(cursor, match.index);
    cursor = match.index + match[0].length;
    const resolved = path.resolve(base, match[3]);
    const isServerModule = resolved.startsWith(path.join(root, 'server') + path.sep);
    if (isServerModule) {
      if (match[1]) throw new Error(`不支持默认导入模块：${match[0]}`);
      result += `\n// ---- 内联模块：${path.relative(root, resolved).split(path.sep).join('/')} ----\n`;
      result += await readModuleCode(resolved);
      result += '\n// ---- 内联模块结束 ----\n';
    } else {
      if (!match[1]) throw new Error(`资源导入需要默认导入：${match[0]}`);
      const content = await readFile(resolved, 'utf8');
      result += `const ${match[1]} = ${jsString(content)};\n`;
    }
  }
  result += source.slice(cursor);
  if (/^\s*import\s/m.test(result)) throw new Error('打包结果中仍存在 import 语句');
  return result;
}

const banner = `// 同词相遇 · 阿里云 ESA 边缘函数（由 scripts/buildesa.mjs 自动生成，请勿手动修改）
// 部署步骤：
// 1. ESA 控制台「边缘计算和 AI > KV存储」创建命名空间 word-meet
// 2. 「函数和Pages」创建函数（建议 50ms 规格），代码页粘贴本文件全部内容
// 3. 保存 → 生成版本 → 发布到生产环境，并把函数绑定到站点域名
// 4. 用 curl POST /api/room {"action":"health"} 验证，再打开域名开始游戏
// 详细说明见 docs/esa-setup.md
`;

await mkdir(path.dirname(output), { recursive: true });
await writeFile(output, banner + await bundle(entry));
console.log('Built dist/esa/worker.js — 单文件 ESA 边缘函数，直接粘贴到控制台即可上线');
