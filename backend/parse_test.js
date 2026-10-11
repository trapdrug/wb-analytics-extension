/* Проверка парсинга названия, продавца и отзывов на реальных данных диагностики. */
'use strict';

const toNumber = (raw) => {
  if (typeof raw === 'number') return raw;
  if (raw == null) return 0;
  const cleaned = String(raw).replace(/[\s\u00A0\u202F]/g, '').replace(/[^\d.,]/g, '').replace(',', '.');
  const n = parseFloat(cleaned);
  return Number.isFinite(n) ? n : 0;
};

// --- getNameFromDom по document.title ---
function getNameFromTitle(title) {
  if (!title) return '';
  let name = title
    .replace(/\s+купить\s+за.*$/i, '')
    .replace(/\s+в\s+интернет[-‑]?магазине.*$/i, '')
    .replace(/\s+\d{5,}\s*$/, '');
  return name.trim();
}

// --- getSellerFromDom: текст блока -> имя ---
function parseSeller(blockText) {
  if (!blockText) return '';
  let t = blockText.trim().split(/продавец/i)[0].trim();
  t = t.replace(/[\s\d.,]+$/, '').trim();
  return t;
}

// --- getReviewsFromDom ---
function parseReviews(reviewsText) {
  const m = reviewsText.match(/([\d\s\u00A0\u202F]+)\s*оцен/i) || reviewsText.match(/([\d\s\u00A0\u202F]+)\s*отзыв/i);
  if (m) { const n = toNumber(m[1]); if (n > 0) return n; }
  return 0;
}

// РЕАЛЬНЫЕ данные из твоей диагностики:
const title = 'Пылесос моющий вертикальный для пола мощный Kiwis 1405065261 купить за 15 199 ₽ в интернет‑магазине Wildberries';
const sellerBlock = 'House hold ecomПродавец4,9';
const reviewsText = '51 123 оценки99+';

console.log('НАЗВАНИЕ:');
console.log('  => ' + JSON.stringify(getNameFromTitle(title)));
console.log('  ожидаем: "Пылесос моющий вертикальный для пола мощный Kiwis"');
console.log('  ИТОГ: ' + (getNameFromTitle(title) === 'Пылесос моющий вертикальный для пола мощный Kiwis' ? 'OK ✅' : 'ПРОВЕРИТЬ ⚠️'));
console.log('');
console.log('ПРОДАВЕЦ:');
console.log('  => ' + JSON.stringify(parseSeller(sellerBlock)));
console.log('  ожидаем: "House hold ecom"');
console.log('  ИТОГ: ' + (parseSeller(sellerBlock) === 'House hold ecom' ? 'OK ✅' : 'ПРОВЕРИТЬ ⚠️'));
console.log('');
console.log('ОТЗЫВЫ:');
console.log('  => ' + parseReviews(reviewsText));
console.log('  ожидаем: 51123');
console.log('  ИТОГ: ' + (parseReviews(reviewsText) === 51123 ? 'OK ✅' : 'ПРОВЕРИТЬ ⚠️'));
