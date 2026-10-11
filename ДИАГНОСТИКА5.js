// ============================================================
//  ДИАГНОСТИКА-5 WB Analytics  (paste-safe).
//  Проверяет ЭТОТ товар: рейтинг/отзывы в DOM + ищет любые
//  признаки данных о продажах («купили», «в корзине», «заказов»).
// ============================================================
void (function () {
  const L = (t) => console.log('%c[WBA-DIAG5]', 'color:#8b5cf6;font-weight:bold', t);

  L('URL: ' + location.href);
  const nm = (location.pathname.match(/\/catalog\/(\d+)\/detail/) || [])[1];
  L('nmId: ' + nm);

  // === РЕЙТИНГ / ОТЗЫВЫ этого товара ===
  L('=== РЕЙТИНГ / ОТЗЫВЫ ===');
  const rateEl = document.querySelector('[class*="address-rate-mini"]');
  L('  address-rate-mini: ' + (rateEl ? JSON.stringify(rateEl.textContent.trim()) : 'НЕТ'));
  const revEl = document.querySelector('[class*="reviews"]');
  L('  [class*="reviews"]: ' + (revEl ? JSON.stringify(revEl.textContent.trim().slice(0, 40)) : 'НЕТ'));
  L('  сколько [class*="reviews"]: ' + document.querySelectorAll('[class*="reviews"]').length);
  L('  data-testid reviews-icon: ' + document.querySelectorAll('[data-testid="product-page-reviews-icon"]').length);

  // Все reviews элементы
  L('  --- все reviews ---');
  document.querySelectorAll('[class*="reviews"]').forEach((e, i) => {
    if (i < 6) L('    [' + i + '] "' + e.textContent.trim().slice(0, 35) + '"');
  });

  // === ИЩЕМ ДАННЫЕ О ПРОДАЖАХ (важно!) ===
  L('=== ДАННЫЕ О ПРОДАЖАХ НА СТРАНИЦЕ ===');
  const patterns = [
    { re: /купил[ио]?\b/i, name: 'купили' },
    { re: /в\s+корзин/i, name: 'в корзине' },
    { re: /заказ[ао]в/i, name: 'заказов' },
    { re: /остал[ои]/i, name: 'осталось' },
    { re: /шт\.?\s/i, name: 'шт' },
    { re: /продаж/i, name: 'продаж' },
  ];
  const all = Array.from(document.querySelectorAll('span, div, a, p'));
  patterns.forEach((pat) => {
    const found = all.filter((e) => {
      const t = e.textContent || '';
      return pat.re.test(t) && t.trim().length < 60 && t.trim().length > 2;
    });
    if (found.length) {
      L('  [' + pat.name + '] найдено ' + found.length + ': ');
      found.slice(0, 4).forEach((e) => L('      "' + e.textContent.trim().slice(0, 45) + '"'));
    } else {
      L('  [' + pat.name + '] НЕ найдено');
    }
  });

  // === Остаток/количество (для расчёта скорости продаж) ===
  L('=== ОСТАТОК / КОЛИЧЕСТВО ===');
  ['[class*="remain"]', '[class*="stock"]', '[class*="quantity"]', '[class*="count"]'].forEach((s) => {
    const els = document.querySelectorAll(s);
    if (els.length) {
      L('  ' + s + ' (' + els.length + '): ');
      Array.from(els).slice(0, 3).forEach((e) => L('      "' + e.textContent.trim().slice(0, 40) + '"'));
    }
  });

  L('=== ДИАГНОСТИКА-5 ГОТОВА ===');
})();
