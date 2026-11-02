// 中文域名在浏览器里会被标准化成 xn-- 形式（punycode）。
// 邀请链接直接显示 xn--dpqu5wnyaiyf17sktl.com 没法读，所以按 RFC 3492 解回中文。
// 只用于展示：浏览器解析中文域名会自动转回 punycode，不用手动编码。

const BASE = 36;
const TMIN = 1;
const TMAX = 26;
const SKEW = 38;
const DAMP = 700;
const INITIAL_BIAS = 72;
const INITIAL_N = 128;

function adapt(delta, points, firstTime) {
  let value = firstTime ? Math.floor(delta / DAMP) : delta >> 1;
  value += Math.floor(value / points);
  let k = 0;
  while (value > ((BASE - TMIN) * TMAX) >> 1) {
    value = Math.floor(value / (BASE - TMIN));
    k += BASE;
  }
  return k + Math.floor(((BASE - TMIN + 1) * value) / (value + SKEW));
}

function digitOf(code) {
  if (code >= 0x30 && code <= 0x39) return code - 22; // 0-9
  if (code >= 0x41 && code <= 0x5a) return code - 65; // A-Z
  if (code >= 0x61 && code <= 0x7a) return code - 97; // a-z
  return -1;
}

function decodeLabel(input) {
  const output = [];
  let i = 0;
  let n = INITIAL_N;
  let bias = INITIAL_BIAS;
  const dash = input.lastIndexOf('-');
  const basicEnd = dash < 0 ? 0 : dash;
  for (let j = 0; j < basicEnd; j += 1) {
    const code = input.charCodeAt(j);
    if (code >= 0x80) throw new Error('punycode: non-basic code point');
    output.push(code);
  }
  let index = dash < 0 ? 0 : dash + 1;
  while (index < input.length) {
    const before = i;
    let weight = 1;
    for (let k = BASE; ; k += BASE) {
      if (index >= input.length) throw new Error('punycode: truncated');
      const digit = digitOf(input.charCodeAt(index));
      index += 1;
      if (digit < 0) throw new Error('punycode: bad digit');
      i += digit * weight;
      const t = k <= bias ? TMIN : k >= bias + TMAX ? TMAX : k - bias;
      if (digit < t) break;
      weight *= BASE - t;
    }
    const length = output.length + 1;
    bias = adapt(i - before, length, before === 0);
    n += Math.floor(i / length);
    i %= length;
    output.splice(i, 0, n);
    i += 1;
  }
  return String.fromCodePoint(...output);
}

/** 把主机名里的 xn-- 标签解回 Unicode；解不开就原样返回，绝不抛错。 */
export function prettyHost(host) {
  if (!host || !host.includes('xn--')) return host;
  return host
    .split('.')
    .map((label) => {
      if (!label.startsWith('xn--')) return label;
      try {
        return decodeLabel(label.slice(4));
      } catch {
        return label;
      }
    })
    .join('.');
}

/**
 * 把一个 ASCII 的绝对 URL 变成展示用的 URL。
 * 非 ASCII 域名放不进 URL 对象（会被重新编码），所以直接在字符串上替换主机名。
 */
export function prettyHref(href) {
  const url = new URL(href);
  const pretty = prettyHost(url.hostname);
  return pretty === url.hostname ? href : href.replace(url.hostname, pretty);
}
