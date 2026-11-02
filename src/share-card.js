// 把「本局总览」画成一张可以发出去的图。
// 用 Canvas 手绘而不是截 DOM：不引第三方库，排版可控，而且能确定地排除房间码和「再来一局」按钮。
import { QR_MATRIX, QR_SIZE } from './qr-card.js';

// 图里显示的链接用中文域名；二维码是静态的，内容为 ASCII 原形，兼容性更好。
const DISPLAY_URL = 'https://word-meet.奶龙传媒学院.com/';

const SERIF = '"Songti SC","Noto Serif CJK SC","Source Han Serif SC",SimSun,Georgia,serif';
const SANS = '-apple-system,BlinkMacSystemFont,"PingFang SC","Microsoft YaHei",sans-serif';
const MONO = 'ui-monospace,"SFMono-Regular",Consolas,monospace';

const C = {
  paper: '#f5f2eb',
  ink: '#303d35',
  muted: '#7e8379',
  faint: '#a3a89b',
  line: '#dedfd4',
  white: '#fffefa',
  ownBg: '#f8e8de',
  ownBorder: '#e9cabb',
  otherBg: '#e9eee4',
  otherBorder: '#cedac7',
  mergedBg: '#e5eddb',
  mergedBorder: '#b8cba8',
  mergedInk: '#506f43',
  connector: '#b0baa5',
};

const WIDTH = 1000;
const PADDING = 72;
const SCALE = 2;
const GAP = 18;
const ROUND_COLUMN = 40;
const BOX_PAD_X = 20;
const BOX_PAD_Y = 18;
const WORD_SIZE = 26;
const WORD_LINE = 38;
const MERGED_SIZE = 30;
const MERGED_LINE = 42;
const MIN_BOX = 88;
const ROW_GAP = 30;
const QR_BOX = 148;
const QR_PAD = 12;

function font(weight, size, family) {
  return `${weight} ${size}px ${family}`;
}

function wrap(ctx, text, maxWidth) {
  const lines = [];
  let line = '';
  for (const char of String(text)) {
    const next = line + char;
    if (line && ctx.measureText(next).width > maxWidth) {
      lines.push(line);
      line = char;
    } else {
      line = next;
    }
  }
  if (line) lines.push(line);
  return lines.length ? lines : [''];
}

// 昵称这类单行文字放不下就截断加省略号，宁可少几个字也不要压到隔壁列。
function fitText(ctx, text, maxWidth) {
  const value = String(text);
  if (ctx.measureText(value).width <= maxWidth) return value;
  let result = '';
  for (const char of value) {
    if (ctx.measureText(result + char + '…').width > maxWidth) break;
    result += char;
  }
  return result + '…';
}

function roundRect(ctx, x, y, width, height, radius) {
  const r = Math.min(radius, width / 2, height / 2);
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.lineTo(x + width - r, y);
  ctx.quadraticCurveTo(x + width, y, x + width, y + r);
  ctx.lineTo(x + width, y + height - r);
  ctx.quadraticCurveTo(x + width, y + height, x + width - r, y + height);
  ctx.lineTo(x + r, y + height);
  ctx.quadraticCurveTo(x, y + height, x, y + height - r);
  ctx.lineTo(x, y + r);
  ctx.quadraticCurveTo(x, y, x + r, y);
  ctx.closePath();
}

function drawWord(ctx, lines, left, top, width, size, lineHeight) {
  ctx.font = font(400, size, SERIF);
  ctx.fillStyle = C.ink;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  const start = top - ((lines.length - 1) * lineHeight) / 2;
  lines.forEach((line, index) => ctx.fillText(line, left + width / 2, start + index * lineHeight));
}

// 把每一轮排成「轮次 + 两个词框」，量出高度，便于先算总高再画。
function planRows(ctx, history, seat, boxWidth) {
  const other = 1 - seat;
  const inner = boxWidth - BOX_PAD_X * 2;
  return history.map((entry, index) => {
    // 量宽度前必须先设字体，否则用的是默认 10px，长词不会换行、直接溢出框外。
    ctx.font = font(400, WORD_SIZE, SERIF);
    const ownLines = wrap(ctx, entry.words[seat], inner);
    const otherLines = wrap(ctx, entry.words[other], inner);
    ctx.font = font(500, MERGED_SIZE, SERIF);
    const mergedLines = entry.matched
      ? wrap(ctx, entry.words[seat], boxWidth * 2 + GAP - BOX_PAD_X * 2)
      : [];
    const height = entry.matched
      ? Math.max(104, BOX_PAD_Y * 2 + 20 + mergedLines.length * MERGED_LINE)
      : Math.max(MIN_BOX, BOX_PAD_Y * 2 + Math.max(ownLines.length, otherLines.length) * WORD_LINE);
    return { entry, ownLines, otherLines, mergedLines, height, last: index === history.length - 1 };
  });
}

function drawQr(ctx, x, y, size) {
  ctx.fillStyle = C.white;
  roundRect(ctx, x, y, size, size, 8);
  ctx.fill();
  const cell = size / (QR_SIZE + 8);
  const origin = 4 * cell;
  ctx.fillStyle = '#1f2a24';
  for (let row = 0; row < QR_SIZE; row++) {
    for (let column = 0; column < QR_SIZE; column++) {
      if (QR_MATRIX[row][column] !== '1') continue;
      const x0 = Math.round(x + origin + column * cell);
      const x1 = Math.round(x + origin + (column + 1) * cell);
      const y0 = Math.round(y + origin + row * cell);
      const y1 = Math.round(y + origin + (row + 1) * cell);
      ctx.fillRect(x0, y0, x1 - x0, y1 - y0);
    }
  }
}

/**
 * 生成结束对局的分享图。
 * @param {{names: string[], history: Array<{round: number, words: string[], matched: boolean}>, seat: number}} data
 * @returns {HTMLCanvasElement}
 */
export function renderShareCard({ names, history, seat }) {
  const measure = document.createElement('canvas').getContext('2d');
  const other = 1 - seat;
  const boxWidth = (WIDTH - PADDING * 2 - ROUND_COLUMN - GAP * 2) / 2;
  const rows = planRows(measure, history, seat, boxWidth);
  const rounds = history.length;

  // ---- 先算总高 ----
  let height = PADDING;
  height += 26; // 小标题
  height += 52; // 主标题
  height += 34; // 分隔线下方留白
  height += 32; // 列标签
  for (const row of rows) height += row.height + (row.last ? 0 : ROW_GAP);
  height += 46; // 结果文字上方
  height += 32; // 结果文字
  height += 40; // 分隔线
  height += 168; // 页脚（与二维码等高）
  height += PADDING;

  const canvas = document.createElement('canvas');
  canvas.width = WIDTH * SCALE;
  canvas.height = Math.round(height) * SCALE;
  const ctx = canvas.getContext('2d');
  ctx.scale(SCALE, SCALE);
  ctx.textBaseline = 'alphabetic';

  ctx.fillStyle = C.paper;
  ctx.fillRect(0, 0, WIDTH, canvas.height / SCALE);

  let y = PADDING;
  ctx.textAlign = 'left';
  ctx.font = font(500, 13, SANS);
  ctx.fillStyle = C.faint;
  ctx.fillText('同词相遇 · WORD MEET', PADDING, y + 13);
  y += 26;

  ctx.font = font(600, 44, SERIF);
  ctx.fillStyle = C.ink;
  ctx.fillText('本局总览', PADDING, y + 40);
  ctx.textAlign = 'right';
  ctx.font = font(400, 15, SANS);
  ctx.fillStyle = C.muted;
  ctx.fillText(`共 ${rounds} 轮`, WIDTH - PADDING, y + 40);
  ctx.textAlign = 'left';
  y += 52;

  ctx.strokeStyle = C.line;
  ctx.lineWidth = 1;
  ctx.beginPath();
  ctx.moveTo(PADDING, y + 0.5);
  ctx.lineTo(WIDTH - PADDING, y + 0.5);
  ctx.stroke();
  y += 34;

  const ownX = PADDING + ROUND_COLUMN + GAP;
  const otherX = ownX + boxWidth + GAP;
  ctx.font = font(400, 14, SANS);
  ctx.fillStyle = C.faint;
  ctx.fillText('轮次', PADDING, y + 14);
  ctx.fillText(fitText(ctx, names[seat] + '（你）', boxWidth), ownX, y + 14);
  ctx.fillText(fitText(ctx, names[other], boxWidth), otherX, y + 14);
  y += 32;

  for (const row of rows) {
    const { entry, height: boxHeight, last } = row;
    ctx.font = font(400, 15, MONO);
    ctx.fillStyle = C.faint;
    ctx.textAlign = 'left';
    ctx.textBaseline = 'middle';
    ctx.fillText(String(entry.round).padStart(2, '0'), PADDING, y + boxHeight / 2);

    if (entry.matched) {
      ctx.fillStyle = C.mergedBg;
      roundRect(ctx, ownX, y, boxWidth * 2 + GAP, boxHeight, 6);
      ctx.fill();
      ctx.strokeStyle = C.mergedBorder;
      ctx.lineWidth = 1.5;
      ctx.stroke();
      ctx.textAlign = 'center';
      ctx.font = font(400, 13, SANS);
      ctx.fillStyle = C.mergedInk;
      const centerY = y + boxHeight / 2;
      ctx.fillText('双方相同', ownX + (boxWidth * 2 + GAP) / 2, centerY - row.mergedLines.length * MERGED_LINE / 2 - 4);
      ctx.font = font(500, MERGED_SIZE, SERIF);
      drawWord(ctx, row.mergedLines, ownX, centerY + 12, boxWidth * 2 + GAP, MERGED_SIZE, MERGED_LINE);
    } else {
      for (const [index, x, bg, border, lines] of [
        [seat, ownX, C.ownBg, C.ownBorder, row.ownLines],
        [other, otherX, C.otherBg, C.otherBorder, row.otherLines],
      ]) {
        ctx.fillStyle = bg;
        roundRect(ctx, x, y, boxWidth, boxHeight, 6);
        ctx.fill();
        ctx.strokeStyle = border;
        ctx.lineWidth = 1.5;
        ctx.stroke();
        drawWord(ctx, lines, x, y + boxHeight / 2, boxWidth, WORD_SIZE, WORD_LINE);
        void index;
      }
    }

    if (!last) {
      ctx.strokeStyle = C.connector;
      ctx.lineWidth = 1;
      const startY = y + boxHeight + 2;
      const endY = y + boxHeight + ROW_GAP - 12;
      for (const x of entry.matched ? [ownX + (boxWidth * 2 + GAP) / 2] : [ownX + boxWidth / 2, otherX + boxWidth / 2]) {
        ctx.beginPath();
        ctx.moveTo(x, startY);
        ctx.lineTo(x, endY);
        ctx.stroke();
        ctx.beginPath();
        ctx.moveTo(x - 4, endY - 4);
        ctx.lineTo(x, endY);
        ctx.lineTo(x + 4, endY - 4);
        ctx.stroke();
      }
    }
    y += boxHeight + (last ? 0 : ROW_GAP);
  }

  y += 46;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'alphabetic';
  ctx.font = font(400, 24, SERIF);
  ctx.fillStyle = C.ink;
  ctx.fillText(rounds ? `成功，共用 ${rounds} 轮。` : '本局结束。', WIDTH / 2, y);
  y += 32;

  ctx.strokeStyle = C.line;
  ctx.beginPath();
  ctx.moveTo(PADDING, y + 20.5);
  ctx.lineTo(WIDTH - PADDING, y + 20.5);
  ctx.stroke();

  const footerTop = y + 40;
  const qrX = WIDTH - PADDING - QR_BOX;
  drawQr(ctx, qrX, footerTop + 4, QR_BOX);

  ctx.textAlign = 'left';
  const textCenter = footerTop + 4 + QR_BOX / 2;
  ctx.font = font(400, 13, SANS);
  ctx.fillStyle = C.faint;
  ctx.fillText('访问', PADDING, textCenter - 26);
  ctx.font = font(500, 20, SANS);
  ctx.fillStyle = C.ink;
  ctx.fillText(`“${DISPLAY_URL}”`, PADDING, textCenter + 2);
  ctx.font = font(400, 14, SANS);
  ctx.fillStyle = C.muted;
  ctx.fillText('扫码游玩', PADDING, textCenter + 32);

  return canvas;
}

export async function downloadShareCard(canvas, filename) {
  const blob = await new Promise((resolve) => canvas.toBlob(resolve, 'image/png'));
  if (!blob) throw new Error('导出图片失败，请重试');
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = filename;
  document.body.append(link);
  link.click();
  link.remove();
  setTimeout(() => URL.revokeObjectURL(url), 10000);
}
