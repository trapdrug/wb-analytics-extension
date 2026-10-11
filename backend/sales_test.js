/* Тест новой логики скорости продаж по приросту отзывов. */
'use strict';
const db = require('./db.js');

const nmId = 999000111; // тестовый артикул
const now = Date.now();
const DAY = 24 * 60 * 60 * 1000;

// Чистим возможные старые записи теста через свежие снапшоты.
// Визит 1: 3 дня назад, 5000 отзывов, цена 1511
db.saveProduct({
  nmId, name: 'Тест товар', price: 1511, priceBefore: 22000, rating: 0,
  reviewsCount: 5000, seller: 'SIRENS', category: '', remaining: 0,
  parsedAt: now - 3 * DAY,
});
// Визит 2: сейчас, 5090 отзывов (прирост 90 за 3 дня = 30/день)
db.saveProduct({
  nmId, name: 'Тест товар', price: 1511, priceBefore: 22000, rating: 0,
  reviewsCount: 5090, seller: 'SIRENS', category: '', remaining: 0,
  parsedAt: now,
});

const m = db.getMetrics(nmId);
console.log('=== МЕТРИКИ после 2 визитов ===');
console.log('  method:', m.method, '(ожидаем "reviews")');
console.log('  salesSpeed:', m.salesSpeed.toFixed(2), '/ день');
console.log('  ожидаем: 90 отзывов / 15 / 3 дня = 2.0 / день');
console.log('  revenuePerDay:', Math.round(m.revenuePerDay), '₽ (1511 * 2.0 = 3022)');
console.log('  priceHistory точек:', m.priceHistory.length);

let ok = m.method === 'reviews' && Math.abs(m.salesSpeed - 2.0) < 0.1;
console.log('  ИТОГ:', ok ? 'OK ✅' : 'ПРОВЕРИТЬ ⚠️');

// Проверка: 1 визит -> скорость 0
db.saveProduct({
  nmId: 999000222, name: 'Один визит', price: 100, priceBefore: 0, rating: 0,
  reviewsCount: 100, seller: 'X', category: '', remaining: 0, parsedAt: now,
});
const m2 = db.getMetrics(999000222);
console.log('\n=== 1 визит (нет второго замера) ===');
console.log('  salesSpeed:', m2.salesSpeed, '(ожидаем 0)');
console.log('  ИТОГ:', m2.salesSpeed === 0 ? 'OK ✅' : 'FAIL ❌');

process.exit(0);
