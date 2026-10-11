/**
 * Генератор PNG-иконок для расширения WB Analytics.
 * Создаёт простые цветные квадраты с буквой «W» без внешних зависимостей
 * (используется встроенный zlib для сжатия PNG).
 *
 * Запуск: node tools/make_icons.js
 */

'use strict';

const fs = require('fs');
const path = require('path');
const zlib = require('zlib');

const OUT_DIR = path.join(__dirname, '..', 'extension', 'icons');
const SIZES = [16, 48, 128];

// Основной цвет (фиолетовый, как акцент в UI) и белый для «W»
const BG = [124, 58, 237, 255]; // #7c3aed
const FG = [255, 255, 255, 255]; // #ffffff

/** Вычисляет CRC32 (требуется для чанков PNG). */
function makeCrcTable() {
  const table = new Int32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) {
      c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    }
    table[n] = c;
  }
  return table;
}
const CRC_TABLE = makeCrcTable();

function crc32(buf) {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) {
    c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  }
  return (c ^ 0xffffffff) >>> 0;
}

/** Собирает PNG-чанк: длина + тип + данные + CRC. */
function chunk(type, data) {
  const typeBuf = Buffer.from(type, 'ascii');
  const body = Buffer.concat([typeBuf, data]);
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length, 0);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body), 0);
  return Buffer.concat([len, body, crc]);
}

/** Рисует грубую «W» пиксельной маской (масштабируется под размер). */
function isWPixel(x, y, size) {
  // Нормализуем координаты в диапазон 0..1
  const nx = x / size;
  const ny = y / size;
  // Центральная область для буквы
  if (nx < 0.2 || nx > 0.8 || ny < 0.2 || ny > 0.8) return false;
  // «W» как три вертикали + две диагонали (упрощённо, пиксельно)
  const col = (v) => Math.abs(v - 0.5);
  // Левая стойка, правая стойка, средняя стойка
  const left = Math.abs(nx - 0.3);
  const right = Math.abs(nx - 0.7);
  const mid = Math.abs(nx - 0.5) + Math.abs(ny - 0.65) * 0.6;
  // Вертикали
  if (left < 0.06 && ny < 0.7) return true;
  if (right < 0.06 && ny < 0.7) return true;
  // Диагонали к центру снизу
  if (mid < 0.1 && ny > 0.4) return true;
  // Соединяем верх
  if (ny < 0.4 && (left < 0.1 || right < 0.1)) return true;
  return false;
}

/** Формирует буфер PNG заданного размера. */
function buildPng(size) {
  const raw = Buffer.alloc((size * 4 + 1) * size);
  let p = 0;
  for (let y = 0; y < size; y++) {
    raw[p++] = 0; // filter type 0 для каждой строки
    for (let x = 0; x < size; x++) {
      const w = isWPixel(x, y, size);
      const c = w ? FG : BG;
      raw[p++] = c[0];
      raw[p++] = c[1];
      raw[p++] = c[2];
      raw[p++] = c[3];
    }
  }

  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // color type RGBA
  ihdr[10] = 0; // compression
  ihdr[11] = 0; // filter
  ihdr[12] = 0; // interlace

  const idat = zlib.deflateSync(raw, { level: 9 });

  const signature = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
  return Buffer.concat([
    signature,
    chunk('IHDR', ihdr),
    chunk('IDAT', idat),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

/** Точка входа: создаёт иконки всех размеров. */
function main() {
  fs.mkdirSync(OUT_DIR, { recursive: true });
  SIZES.forEach((size) => {
    const png = buildPng(size);
    const file = path.join(OUT_DIR, 'icon' + size + '.png');
    fs.writeFileSync(file, png);
    console.log('создана иконка:', file, '(' + png.length + ' байт)');
  });
}

main();
