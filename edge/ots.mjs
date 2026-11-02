// 极简 Tablestore(OTS) HTTP 客户端 —— 专为 ESA 边缘函数环境手写，零依赖。
// 只实现房间状态需要的三个操作：GetRow / PutRow / DeleteRow。
// 认证走 V2 签名（x-ots-* + HMAC-SHA1），行数据走 PlainBuffer 编码，请求体走 Protobuf。
// 之所以不用官方 SDK：边缘函数没有 node_modules，且 SDK 体积远超函数限制。

const API_VERSION = '2015-12-31';

// ---------------------------------------------------------------------------
// 基础字节工具
// ---------------------------------------------------------------------------

const encoder = new TextEncoder();

function utf8(text) {
  return encoder.encode(text);
}

const B64_CHARS = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';

function base64(bytes) {
  let out = '';
  for (let i = 0; i < bytes.length; i += 3) {
    const b0 = bytes[i];
    const b1 = i + 1 < bytes.length ? bytes[i + 1] : 0;
    const b2 = i + 2 < bytes.length ? bytes[i + 2] : 0;
    out += B64_CHARS[b0 >> 2];
    out += B64_CHARS[((b0 & 0x3) << 4) | (b1 >> 4)];
    out += i + 1 < bytes.length ? B64_CHARS[((b1 & 0xf) << 2) | (b2 >> 6)] : '=';
    out += i + 2 < bytes.length ? B64_CHARS[b2 & 0x3f] : '=';
  }
  return out;
}

function rotl(x, n) {
  return ((x << n) | (x >>> (32 - n))) >>> 0;
}

// ---------------------------------------------------------------------------
// MD5（Web Crypto 不提供 MD5，只能手写）
// ---------------------------------------------------------------------------

const MD5_K = new Uint32Array(64);
for (let i = 0; i < 64; i += 1) {
  MD5_K[i] = Math.floor(Math.abs(Math.sin(i + 1)) * 4294967296) >>> 0;
}

const MD5_S = [
  7, 12, 17, 22, 7, 12, 17, 22, 7, 12, 17, 22, 7, 12, 17, 22,
  5, 9, 14, 20, 5, 9, 14, 20, 5, 9, 14, 20, 5, 9, 14, 20,
  4, 11, 16, 23, 4, 11, 16, 23, 4, 11, 16, 23, 4, 11, 16, 23,
  6, 10, 15, 21, 6, 10, 15, 21, 6, 10, 15, 21, 6, 10, 15, 21,
];

function md5(bytes) {
  const len = bytes.length;
  const total = (((len + 8) >> 6) + 1) << 6;
  const buf = new Uint8Array(total);
  buf.set(bytes);
  buf[len] = 0x80;
  const bits = len * 8;
  const hiBits = Math.floor(bits / 4294967296);
  const loBits = bits >>> 0;
  buf[total - 8] = loBits & 0xff;
  buf[total - 7] = (loBits >>> 8) & 0xff;
  buf[total - 6] = (loBits >>> 16) & 0xff;
  buf[total - 5] = (loBits >>> 24) & 0xff;
  buf[total - 4] = hiBits & 0xff;

  let a0 = 0x67452301;
  let b0 = 0xefcdab89;
  let c0 = 0x98badcfe;
  let d0 = 0x10325476;
  const m = new Uint32Array(16);

  for (let off = 0; off < total; off += 64) {
    for (let i = 0; i < 16; i += 1) {
      const p = off + i * 4;
      m[i] = (buf[p] | (buf[p + 1] << 8) | (buf[p + 2] << 16) | (buf[p + 3] << 24)) >>> 0;
    }
    let a = a0;
    let b = b0;
    let c = c0;
    let d = d0;
    for (let i = 0; i < 64; i += 1) {
      let f;
      let g;
      if (i < 16) {
        f = (b & c) | (~b & d);
        g = i;
      } else if (i < 32) {
        f = (d & b) | (~d & c);
        g = (5 * i + 1) % 16;
      } else if (i < 48) {
        f = b ^ c ^ d;
        g = (3 * i + 5) % 16;
      } else {
        f = c ^ (b | ~d);
        g = (7 * i) % 16;
      }
      f = (f + a + MD5_K[i] + m[g]) >>> 0;
      a = d;
      d = c;
      c = b;
      b = (b + rotl(f, MD5_S[i])) >>> 0;
    }
    a0 = (a0 + a) >>> 0;
    b0 = (b0 + b) >>> 0;
    c0 = (c0 + c) >>> 0;
    d0 = (d0 + d) >>> 0;
  }

  const out = new Uint8Array(16);
  const words = [a0, b0, c0, d0];
  for (let i = 0; i < 4; i += 1) {
    out[i * 4] = words[i] & 0xff;
    out[i * 4 + 1] = (words[i] >>> 8) & 0xff;
    out[i * 4 + 2] = (words[i] >>> 16) & 0xff;
    out[i * 4 + 3] = (words[i] >>> 24) & 0xff;
  }
  return out;
}

// ---------------------------------------------------------------------------
// SHA-1 + HMAC-SHA1（用于 x-ots-signature）
// ---------------------------------------------------------------------------

function sha1(bytes) {
  const len = bytes.length;
  const total = (((len + 8) >> 6) + 1) << 6;
  const buf = new Uint8Array(total);
  buf.set(bytes);
  buf[len] = 0x80;
  const bits = len * 8;
  const hiBits = Math.floor(bits / 4294967296);
  const loBits = bits >>> 0;
  buf[total - 8] = (hiBits >>> 24) & 0xff;
  buf[total - 7] = (hiBits >>> 16) & 0xff;
  buf[total - 6] = (hiBits >>> 8) & 0xff;
  buf[total - 5] = hiBits & 0xff;
  buf[total - 4] = (loBits >>> 24) & 0xff;
  buf[total - 3] = (loBits >>> 16) & 0xff;
  buf[total - 2] = (loBits >>> 8) & 0xff;
  buf[total - 1] = loBits & 0xff;

  let h0 = 0x67452301;
  let h1 = 0xefcdab89;
  let h2 = 0x98badcfe;
  let h3 = 0x10325476;
  let h4 = 0xc3d2e1f0;
  const w = new Uint32Array(80);

  for (let off = 0; off < total; off += 64) {
    for (let i = 0; i < 16; i += 1) {
      const p = off + i * 4;
      w[i] = ((buf[p] << 24) | (buf[p + 1] << 16) | (buf[p + 2] << 8) | buf[p + 3]) >>> 0;
    }
    for (let i = 16; i < 80; i += 1) {
      w[i] = rotl(w[i - 3] ^ w[i - 8] ^ w[i - 14] ^ w[i - 16], 1);
    }
    let a = h0;
    let b = h1;
    let c = h2;
    let d = h3;
    let e = h4;
    for (let i = 0; i < 80; i += 1) {
      let f;
      let k;
      if (i < 20) {
        f = (b & c) | (~b & d);
        k = 0x5a827999;
      } else if (i < 40) {
        f = b ^ c ^ d;
        k = 0x6ed9eba1;
      } else if (i < 60) {
        f = (b & c) | (b & d) | (c & d);
        k = 0x8f1bbcdc;
      } else {
        f = b ^ c ^ d;
        k = 0xca62c1d6;
      }
      const t = (rotl(a, 5) + (f >>> 0) + e + k + w[i]) >>> 0;
      e = d;
      d = c;
      c = rotl(b, 30);
      b = a;
      a = t;
    }
    h0 = (h0 + a) >>> 0;
    h1 = (h1 + b) >>> 0;
    h2 = (h2 + c) >>> 0;
    h3 = (h3 + d) >>> 0;
    h4 = (h4 + e) >>> 0;
  }

  const out = new Uint8Array(20);
  [h0, h1, h2, h3, h4].forEach((h, i) => {
    out[i * 4] = (h >>> 24) & 0xff;
    out[i * 4 + 1] = (h >>> 16) & 0xff;
    out[i * 4 + 2] = (h >>> 8) & 0xff;
    out[i * 4 + 3] = h & 0xff;
  });
  return out;
}

function hmacSha1(key, message) {
  const blockSize = 64;
  let k = key.length > blockSize ? sha1(key) : key;
  const padded = new Uint8Array(blockSize);
  padded.set(k);

  const inner = new Uint8Array(blockSize + message.length);
  for (let i = 0; i < blockSize; i += 1) inner[i] = padded[i] ^ 0x36;
  inner.set(message, blockSize);

  const outer = new Uint8Array(blockSize + 20);
  for (let i = 0; i < blockSize; i += 1) outer[i] = padded[i] ^ 0x5c;
  outer.set(sha1(inner), blockSize);

  return sha1(outer);
}

// ---------------------------------------------------------------------------
// CRC8（PlainBuffer 校验，查表法，多项式 0x07）
// ---------------------------------------------------------------------------

const CRC8_TABLE = new Uint8Array([
  0x00, 0x07, 0x0e, 0x09, 0x1c, 0x1b, 0x12, 0x15, 0x38, 0x3f, 0x36, 0x31, 0x24, 0x23, 0x2a, 0x2d,
  0x70, 0x77, 0x7e, 0x79, 0x6c, 0x6b, 0x62, 0x65, 0x48, 0x4f, 0x46, 0x41, 0x54, 0x53, 0x5a, 0x5d,
  0xe0, 0xe7, 0xee, 0xe9, 0xfc, 0xfb, 0xf2, 0xf5, 0xd8, 0xdf, 0xd6, 0xd1, 0xc4, 0xc3, 0xca, 0xcd,
  0x90, 0x97, 0x9e, 0x99, 0x8c, 0x8b, 0x82, 0x85, 0xa8, 0xaf, 0xa6, 0xa1, 0xb4, 0xb3, 0xba, 0xbd,
  0xc7, 0xc0, 0xc9, 0xce, 0xdb, 0xdc, 0xd5, 0xd2, 0xff, 0xf8, 0xf1, 0xf6, 0xe3, 0xe4, 0xed, 0xea,
  0xb7, 0xb0, 0xb9, 0xbe, 0xab, 0xac, 0xa5, 0xa2, 0x8f, 0x88, 0x81, 0x86, 0x93, 0x94, 0x9d, 0x9a,
  0x27, 0x20, 0x29, 0x2e, 0x3b, 0x3c, 0x35, 0x32, 0x1f, 0x18, 0x11, 0x16, 0x03, 0x04, 0x0d, 0x0a,
  0x57, 0x50, 0x59, 0x5e, 0x4b, 0x4c, 0x45, 0x42, 0x6f, 0x68, 0x61, 0x66, 0x73, 0x74, 0x7d, 0x7a,
  0x89, 0x8e, 0x87, 0x80, 0x95, 0x92, 0x9b, 0x9c, 0xb1, 0xb6, 0xbf, 0xb8, 0xad, 0xaa, 0xa3, 0xa4,
  0xf9, 0xfe, 0xf7, 0xf0, 0xe5, 0xe2, 0xeb, 0xec, 0xc1, 0xc6, 0xcf, 0xc8, 0xdd, 0xda, 0xd3, 0xd4,
  0x69, 0x6e, 0x67, 0x60, 0x75, 0x72, 0x7b, 0x7c, 0x51, 0x56, 0x5f, 0x58, 0x4d, 0x4a, 0x43, 0x44,
  0x19, 0x1e, 0x17, 0x10, 0x05, 0x02, 0x0b, 0x0c, 0x21, 0x26, 0x2f, 0x28, 0x3d, 0x3a, 0x33, 0x34,
  0x4e, 0x49, 0x40, 0x47, 0x52, 0x55, 0x5c, 0x5b, 0x76, 0x71, 0x78, 0x7f, 0x6a, 0x6d, 0x64, 0x63,
  0x3e, 0x39, 0x30, 0x37, 0x22, 0x25, 0x2c, 0x2b, 0x06, 0x01, 0x08, 0x0f, 0x1a, 0x1d, 0x14, 0x13,
  0xae, 0xa9, 0xa0, 0xa7, 0xb2, 0xb5, 0xbc, 0xbb, 0x96, 0x91, 0x98, 0x9f, 0x8a, 0x8d, 0x84, 0x83,
  0xde, 0xd9, 0xd0, 0xd7, 0xc2, 0xc5, 0xcc, 0xcb, 0xe6, 0xe1, 0xe8, 0xef, 0xfa, 0xfd, 0xf4, 0xf3,
]);

function crc8(crc, byte) {
  return CRC8_TABLE[((crc & 0xff) ^ byte) & 0xff];
}

function crc8Bytes(crc, bytes) {
  let out = crc;
  for (let i = 0; i < bytes.length; i += 1) out = crc8(out, bytes[i] & 0xff);
  return out;
}

function crc8Int32(crc, value) {
  let out = crc;
  for (let i = 0; i < 4; i += 1) out = crc8(out, (value >>> (i * 8)) & 0xff);
  return out;
}

// ---------------------------------------------------------------------------
// PlainBuffer 编码 / 解码
// ---------------------------------------------------------------------------

const TAG_ROW_PK = 0x01;
const TAG_ROW_DATA = 0x02;
const TAG_CELL = 0x03;
const TAG_CELL_NAME = 0x04;
const TAG_CELL_VALUE = 0x05;
const TAG_CELL_TYPE = 0x06;
const TAG_CELL_TIMESTAMP = 0x07;
const TAG_DELETE_ROW_MARKER = 0x08;
const TAG_ROW_CHECKSUM = 0x09;
const TAG_CELL_CHECKSUM = 0x0a;
const TAG_EXTENSION = 0x0b;
const VT_STRING = 0x03;
const HEADER = 0x75;

function createWriter() {
  const chunks = [];
  let size = 0;
  const api = {
    u8(byte) {
      chunks.push(Uint8Array.of(byte & 0xff));
      size += 1;
    },
    le32(value) {
      const b = new Uint8Array(4);
      b[0] = value & 0xff;
      b[1] = (value >>> 8) & 0xff;
      b[2] = (value >>> 16) & 0xff;
      b[3] = (value >>> 24) & 0xff;
      chunks.push(b);
      size += 4;
    },
    raw(bytes) {
      chunks.push(bytes);
      size += bytes.length;
    },
    done() {
      const out = new Uint8Array(size);
      let offset = 0;
      for (const chunk of chunks) {
        out.set(chunk, offset);
        offset += chunk.length;
      }
      return out;
    },
  };
  return api;
}

// 写一个 string cell 的 name 段，返回累积的 cell 校验和
function writeCellName(writer, name, checksum) {
  const nameBytes = utf8(name);
  writer.u8(TAG_CELL_NAME);
  writer.le32(nameBytes.length);
  writer.raw(nameBytes);
  return crc8Bytes(checksum, nameBytes);
}

// 写一个 string cell 的 value 段
function writeCellValue(writer, value, checksum) {
  const valueBytes = utf8(value);
  writer.u8(TAG_CELL_VALUE);
  writer.le32(5 + valueBytes.length); // 4 字节长度前缀 + 1 字节类型 + 内容
  writer.u8(VT_STRING);
  writer.le32(valueBytes.length);
  writer.raw(valueBytes);
  let crc = crc8(checksum, VT_STRING);
  crc = crc8Int32(crc, valueBytes.length);
  return crc8Bytes(crc, valueBytes);
}

function writeCell(writer, name, value, isPrimaryKey) {
  let cellCrc = 0;
  writer.u8(TAG_CELL);
  cellCrc = writeCellName(writer, name, cellCrc);
  cellCrc = writeCellValue(writer, value, cellCrc);
  writer.u8(TAG_CELL_CHECKSUM);
  writer.u8(cellCrc);
  return cellCrc;
}

// 只有主键的 PlainBuffer（GetRow 用）
function encodePrimaryKey(pkName, pkValue) {
  const w = createWriter();
  w.le32(HEADER);
  w.u8(TAG_ROW_PK);
  let rowCrc = crc8(0, writeCell(w, pkName, pkValue, true));
  rowCrc = crc8(rowCrc, 0);
  w.u8(TAG_ROW_CHECKSUM);
  w.u8(rowCrc);
  return w.done();
}

// DeleteRow 需要额外带一个删除标记，否则服务端报 "Delete marker is missing"
function encodeDeleteKey(pkName, pkValue) {
  const w = createWriter();
  w.le32(HEADER);
  w.u8(TAG_ROW_PK);
  let rowCrc = crc8(0, writeCell(w, pkName, pkValue, true));
  w.u8(TAG_DELETE_ROW_MARKER);
  rowCrc = crc8(rowCrc, 1);
  w.u8(TAG_ROW_CHECKSUM);
  w.u8(rowCrc);
  return w.done();
}

// 主键 + 一个字符串列的 PlainBuffer（PutRow 用）
function encodeRow(pkName, pkValue, columnName, columnValue) {
  const w = createWriter();
  w.le32(HEADER);
  w.u8(TAG_ROW_PK);
  let rowCrc = crc8(0, writeCell(w, pkName, pkValue, true));
  w.u8(TAG_ROW_DATA);
  rowCrc = crc8(rowCrc, writeCell(w, columnName, columnValue, false));
  rowCrc = crc8(rowCrc, 0);
  w.u8(TAG_ROW_CHECKSUM);
  w.u8(rowCrc);
  return w.done();
}

function readLe32(bytes, offset) {
  return (bytes[offset] | (bytes[offset + 1] << 8) | (bytes[offset + 2] << 16) | (bytes[offset + 3] << 24)) >>> 0;
}

const decoder = new TextDecoder();

// 从 GetRowResponse 的 row 字段解出列名到字符串值的映射
function decodeRow(bytes) {
  const columns = {};
  if (!bytes || bytes.length < 4) return columns;
  let offset = 4; // 跳过 header
  let lastTag = -1;

  const readCell = () => {
    // 当前 offset 指向 TAG_CELL 之后
    let name = null;
    let value = null;
    while (offset < bytes.length) {
      const tag = bytes[offset];
      offset += 1;
      if (tag === TAG_CELL_NAME) {
        const len = readLe32(bytes, offset);
        offset += 4;
        name = decoder.decode(bytes.subarray(offset, offset + len));
        offset += len;
      } else if (tag === TAG_CELL_VALUE) {
        const total = readLe32(bytes, offset);
        offset += 4;
        const start = offset;
        const type = bytes[offset];
        offset += 1;
        if (type === VT_STRING) {
          const len = readLe32(bytes, offset);
          offset += 4;
          value = decoder.decode(bytes.subarray(offset, offset + len));
          offset += len;
        } else {
          value = null;
        }
        offset = start + total;
      } else if (tag === TAG_CELL_CHECKSUM) {
        offset += 1;
        break;
      } else if (tag === TAG_CELL_TYPE) {
        offset += 1;
      } else if (tag === TAG_CELL_TIMESTAMP) {
        offset += 8;
      } else {
        break;
      }
    }
    if (name !== null) columns[name] = value;
  };

  while (offset < bytes.length) {
    const tag = bytes[offset];
    offset += 1;
    lastTag = tag;
    if (tag === TAG_ROW_PK || tag === TAG_ROW_DATA) {
      // 进入 pk / 数据区，接下来是一串 cell
      while (offset < bytes.length && bytes[offset] === TAG_CELL) {
        offset += 1;
        readCell();
      }
    } else if (tag === TAG_ROW_CHECKSUM) {
      offset += 1;
      break;
    } else if (tag === TAG_DELETE_ROW_MARKER) {
      // 逻辑删除标记，无内容
    } else if (tag === TAG_EXTENSION) {
      break;
    }
  }
  return columns;
}

// ---------------------------------------------------------------------------
// Protobuf 最小实现（只用到 length-delimited 与 varint）
// ---------------------------------------------------------------------------

function pbVarint(value) {
  const out = [];
  let v = value >>> 0;
  while (v >= 0x80) {
    out.push((v & 0x7f) | 0x80);
    v >>>= 7;
  }
  out.push(v);
  return out;
}

function pbTag(field, wire) {
  return pbVarint((field << 3) | wire);
}

function pbBytes(field, bytes) {
  return [...pbTag(field, 2), ...pbVarint(bytes.length), ...bytes];
}

function pbString(field, text) {
  return pbBytes(field, utf8(text));
}

function pbInt(field, value) {
  return [...pbTag(field, 0), ...pbVarint(value)];
}

function toBytes(array) {
  return Uint8Array.from(array);
}

// 解析 length-delimited 字段，返回 { field: [bytes...] }
function pbParse(bytes) {
  const fields = {};
  let offset = 0;
  while (offset < bytes.length) {
    let key = 0;
    let shift = 0;
    let byte;
    do {
      byte = bytes[offset];
      offset += 1;
      key |= (byte & 0x7f) << shift;
      shift += 7;
    } while (byte & 0x80);
    const field = key >>> 3;
    const wire = key & 0x7;
    if (wire === 2) {
      let len = 0;
      shift = 0;
      do {
        byte = bytes[offset];
        offset += 1;
        len |= (byte & 0x7f) << shift;
        shift += 7;
      } while (byte & 0x80);
      const slice = bytes.subarray(offset, offset + len);
      offset += len;
      (fields[field] = fields[field] || []).push(slice);
    } else if (wire === 0) {
      let value = 0;
      shift = 0;
      do {
        byte = bytes[offset];
        offset += 1;
        value |= (byte & 0x7f) << shift;
        shift += 7;
      } while (byte & 0x80);
      (fields[field] = fields[field] || []).push(value);
    } else if (wire === 1) {
      offset += 8;
    } else if (wire === 5) {
      offset += 4;
    } else {
      break;
    }
  }
  return fields;
}

// ---------------------------------------------------------------------------
// OTS 请求
// ---------------------------------------------------------------------------

function canonicalHeaders(headers) {
  return Object.keys(headers)
    .map((name) => name.toLowerCase())
    .sort()
    .map((name) => `${name}:${headers[Object.keys(headers).find((k) => k.toLowerCase() === name)]}`)
    .join('\n');
}

export class OtsError extends Error {
  constructor(code, message) {
    super(message || code);
    this.name = 'OtsError';
    this.code = code;
  }
}

async function request(config, operation, body) {
  const path = `/${operation}`;
  const headers = {
    'x-ots-apiversion': API_VERSION,
    'x-ots-instancename': config.instance,
    'x-ots-date': new Date().toISOString(),
    'x-ots-accesskeyid': config.accessKeyId,
    'x-ots-contentmd5': base64(md5(body)),
  };
  const stringToSign = `${path}\nPOST\n\n${canonicalHeaders(headers)}\n`;
  headers['x-ots-signature'] = base64(hmacSha1(utf8(config.accessKeySecret), utf8(stringToSign)));

  const response = await fetch(config.endpoint.replace(/\/$/, '') + path, {
    method: 'POST',
    headers: { ...headers, 'Content-Type': 'application/x-protobuf' },
    body,
  });
  const buffer = new Uint8Array(await response.arrayBuffer());
  if (!response.ok) {
    const fields = pbParse(buffer);
    const code = fields[1] ? decoder.decode(fields[1][0]) : `HTTP_${response.status}`;
    const message = fields[2] ? decoder.decode(fields[2][0]) : '';
    throw new OtsError(code, message);
  }
  return buffer;
}

/**
 * 创建房间状态存储，接口与协议层需要的 {get, put, delete} 一致。
 * 每行一条房间记录：主键 code，列 data 存 JSON 字符串。
 */
export function createOtsStore(config) {
  const table = config.table || 'rooms';
  const column = config.column || 'data';
  const pkName = config.primaryKey || 'code';
  const base = { ...config, table };

  const tableField = () => pbString(1, table);
  const conditionIgnore = () => pbBytes(3, toBytes([...pbTag(1, 0), 0])); // Condition{ row_existence = IGNORE(0) }

  return {
    async get(key) {
      const body = toBytes([
        ...tableField(),
        ...pbBytes(2, encodePrimaryKey(pkName, key)),
        ...pbInt(5, 1), // max_versions：不指定会报 "No version condition is specified"
      ]);
      const response = await request(base, 'GetRow', body);
      const fields = pbParse(response);
      const rowBytes = fields[2] ? fields[2][0] : null;
      if (!rowBytes || rowBytes.length === 0) return null;
      const row = decodeRow(rowBytes);
      const value = row[column];
      return typeof value === 'string' ? value : null;
    },

    async put(key, value) {
      const body = toBytes([
        ...tableField(),
        ...pbBytes(2, encodeRow(pkName, key, column, value)),
        ...conditionIgnore(),
      ]);
      await request(base, 'PutRow', body);
    },

    async delete(key) {
      const body = toBytes([
        ...tableField(),
        ...pbBytes(2, encodeDeleteKey(pkName, key)),
        ...conditionIgnore(),
      ]);
      await request(base, 'DeleteRow', body);
    },
  };
}

/**
 * 建表（运维脚本用，幂等：表已存在时静默返回 false）。
 * 主键列默认 code(STRING)，表选项 TTL 由调用方给，房间数据过期自动回收。
 */
export async function createOtsTable(config) {
  const pkName = config.primaryKey || 'code';
  const tableMeta = toBytes([
    ...pbString(1, config.table),
    ...pbBytes(2, toBytes([...pbString(1, pkName), ...pbInt(2, 2)])), // type: STRING = 2
  ]);
  const reserved = toBytes([...pbBytes(1, toBytes([...pbInt(1, 0), ...pbInt(2, 0)]))]);
  const options = toBytes([...pbInt(1, config.timeToLive || 86400), ...pbInt(2, 1)]);
  const body = toBytes([
    ...pbBytes(1, tableMeta),
    ...pbBytes(2, reserved),
    ...pbBytes(3, options),
  ]);
  try {
    await request({ ...config }, 'CreateTable', body);
    return true;
  } catch (error) {
    if (error && (error.code === 'OTSTableAlreadyExist' || error.code === 'OTSObjectAlreadyExist')) return false;
    throw error;
  }
}

// 供本地自测使用
export const __internals = { md5, sha1, hmacSha1, base64, encodeRow, encodePrimaryKey, encodeDeleteKey, decodeRow, pbParse };
