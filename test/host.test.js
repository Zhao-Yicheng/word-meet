import test from 'node:test';
import assert from 'node:assert/strict';
import { domainToUnicode } from 'node:url';
import { prettyHost, prettyHref } from '../src/host.js';

test('xn-- labels are decoded to the Chinese domain they stand for', () => {
  assert.equal(prettyHost('word-meet.xn--dpqu5wnyaiyf17sktl.com'), 'word-meet.奶龙传媒学院.com');
  assert.equal(prettyHost('xn--fiqs8s.xn--fiqz9s'), '中国.中國');
  assert.equal(prettyHost('xn--0zwm56d.com'), '测试.com');
});

test('ascii hosts and broken labels are passed through untouched', () => {
  assert.equal(prettyHost('word-meet.example.com'), 'word-meet.example.com');
  assert.equal(prettyHost('localhost'), 'localhost');
  assert.equal(prettyHost(''), '');
  // 解不开的标签原样保留，不能因为一个坏域名让整个页面挂掉。
  assert.equal(prettyHost('xn--bad-.com'), 'bad.com');
  assert.equal(prettyHost('xn--!!!.com'), 'xn--!!!.com');
});

test('decoding matches the platform implementation', () => {
  const samples = ['xn--dpqu5wnyaiyf17sktl.com', 'xn--wgbh1c.com', 'xn--80akhbyknj4f.com', 'a.xn--0zwm56d.cn'];
  for (const host of samples) assert.equal(prettyHost(host), domainToUnicode(host), host);
});

test('prettyHref only rewrites the host of an absolute url', () => {
  const room = 'https://word-meet.xn--dpqu5wnyaiyf17sktl.com/#room=ABCD2345';
  assert.equal(prettyHref(room), 'https://word-meet.奶龙传媒学院.com/#room=ABCD2345');
  // ASCII 域名不该被改动。
  const plain = 'https://word-meet.example.com/#room=ABCD2345';
  assert.equal(prettyHref(plain), plain);
  // 带端口的也别把端口弄丢。
  assert.equal(prettyHref('http://xn--0zwm56d.com:8080/x'), 'http://测试.com:8080/x');
});
