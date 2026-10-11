/* Интеграционный тест перехвата: имитируем реальный ответ card.wb.ru
   и проверяем, что extractPrice + normalizeProduct дают верные числа. */
'use strict';

// --- Копия extractPrice из net-intercept.js ---
function extractPrice(product) {
  let sale = Number(product.salePriceU || product.salePrice || 0);
  let base = Number(product.priceU || product.basePriceU || product.price || 0);
  if ((!sale || !base) && Array.isArray(product.sizes)) {
    const totals = [];
    product.sizes.forEach((s) => {
      const p = s && s.price;
      if (p) {
        if (p.total) totals.push(Number(p.total));
        if (p.product) totals.push(Number(p.product));
      }
    });
    const nums = totals.filter((n) => n > 0);
    if (nums.length) {
      const min = Math.min(...nums);
      if (!sale) sale = min;
      if (!base) base = Math.max(...nums);
    }
  }
  return { sale, base };
}

// --- Копия normalizeProduct из content.js (упрощённая, та же логика цен) ---
const toRub = (v) => (Number(v) > 5000 ? Math.round(Number(v) / 100) : Number(v) || 0);
function normalizeProduct(raw, nmIdFromUrl) {
  if (!raw) return null;
  const saleU = Number(raw.salePriceU ?? raw.salePrice ?? raw.sale ?? 0) || 0;
  const baseU = Number(raw.priceU ?? raw.basePriceU ?? raw.price ?? raw.priceBefore ?? 0) || 0;
  let price = toRub(saleU);
  let priceBefore = toRub(baseU);
  if (!price) price = priceBefore;
  if (priceBefore && priceBefore < price) {
    const t = priceBefore; priceBefore = price; price = t;
  }
  if (priceBefore && priceBefore === price) priceBefore = 0;
  return {
    nmId: raw.nmId ?? raw.id ?? nmIdFromUrl ?? 0,
    name: raw.name ?? raw.title ?? '',
    price: price || 0,
    priceBefore: priceBefore || 0,
    rating: Number(raw.reviewRating ?? raw.rating ?? raw.productRating ?? 0) || 0,
    reviewsCount: Number(raw.feedbacks ?? raw.nmFeedbacks ?? raw.reviewsCount ?? 0) || 0,
    seller: raw.supplier ?? raw.supplierName ?? raw.seller ?? raw.brand ?? '',
  };
}

// --- Тест 1: обычная карточка с готовыми ценами ---
const sample1 = {
  nmId: 710463831,
  name: 'Вертикальный пылесос Truclean W30 Pro',
  salePriceU: 1908200,
  priceU: 2350000,
  reviewRating: 4.7,
  feedbacks: 203,
  supplier: 'Modern Device',
};
const r1 = normalizeProduct(sample1, 0);
console.log('Тест1 (обычная карточка):');
console.log('  price=' + r1.price + ' (ожидаем 19082)');
console.log('  priceBefore=' + r1.priceBefore + ' (ожидаем 23500)');
console.log('  rating=' + r1.rating + ' reviews=' + r1.reviewsCount + ' seller=' + r1.seller);
console.log('  ИТОГ: ' + (r1.price === 19082 && r1.priceBefore === 23500 && r1.rating === 4.7 && r1.reviewsCount === 203 && r1.seller === 'Modern Device' ? 'OK ✅' : 'FAIL ❌'));

// --- Тест 2: карточка, где цена только в sizes[] (WB часто так отдаёт) ---
const sample2 = {
  nmId: 12345678,
  name: 'Товар без salePriceU',
  sizes: [
    { price: { total: 99900, product: 99900 } },
    { price: { total: 129900, product: 129900 } },
  ],
};
const ep = extractPrice(sample2);
const sample2full = Object.assign({ salePriceU: ep.sale, priceU: ep.base }, sample2);
const r2 = normalizeProduct(sample2full, 0);
console.log('\nТест2 (цена только в sizes[]):');
console.log('  extractPrice => sale=' + ep.sale + ' base=' + ep.base);
console.log('  price=' + r2.price + ' (ожидаем 999)');
console.log('  ИТОГ: ' + (r2.price === 999 ? 'OK ✅' : 'FAIL ❌'));

// --- Тест 3: перехваченный объект отфильтрован по nmId ---
const readNetCard = (net, nmId) => {
  if (!net || !net.card) return null;
  if (nmId && Number(net.card.nmId || net.card.id) !== Number(nmId)) return null;
  return net.card;
};
const net = { card: { nmId: 710463831, salePriceU: 1908200, name: 'x' } };
console.log('\nТест3 (фильтр по nmId):');
console.log('  совпадает: ' + (readNetCard(net, 710463831) ? 'нашли ✅' : 'нет ❌'));
console.log('  чужой nmId: ' + (readNetCard(net, 999) === null ? 'верно отфильтрован ✅' : 'ошибка ❌'));
