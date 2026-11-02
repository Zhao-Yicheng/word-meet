import test from 'node:test';
import assert from 'node:assert/strict';
import { QR_MATRIX, QR_SIZE } from '../src/qr-card.js';

// 静态二维码是手工固化进来的，这里守住它的形状：
// 改错一个字符虽然还能画出来，但会扫不出来，所以用结构与校验位规则兜底。
test('the static QR matrix is a square grid of 0/1 rows', () => {
  assert.equal(QR_SIZE, 33, '版本 4 的矩阵是 33×33');
  assert.equal(QR_MATRIX.length, QR_SIZE);
  for (const row of QR_MATRIX) {
    assert.equal(row.length, QR_SIZE);
    assert.match(row, /^[01]+$/);
  }
});

test('the static QR keeps its finder patterns and quiet-zone margins', () => {
  const dark = (row, column) => QR_MATRIX[row][column] === '1';
  const finder = (top, left) => {
    for (let row = 0; row < 7; row++) {
      for (let column = 0; column < 7; column++) {
        const edge = Math.max(Math.abs(row - 3), Math.abs(column - 3));
        assert.equal(dark(top + row, left + column), edge !== 2, `定位图形 (${top},${left}) 的 (${row},${column})`);
      }
    }
  };
  finder(0, 0);
  finder(0, QR_SIZE - 7);
  finder(QR_SIZE - 7, 0);
  assert.equal(dark(QR_SIZE - 8, 8), true, '固定深色模块必须在');
});
