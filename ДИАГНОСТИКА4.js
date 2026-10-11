// ============================================================
//  ДИАГНОСТИКА-4 WB Analytics  (paste-safe).
//  Запускает ТОЧНЫЕ копии функций парсинга из content.js на живой
//  странице и показывает пошагово, что находит каждый селектор.
// ============================================================
void (function () {
  const L = (t) => console.log('%c[WBA-DIAG4]', 'color:#ef4444;font-weight:bold', t);

  function toNumber(raw) {
    if (typeof raw === 'number') return raw;
    if (raw == null) return 0;
    const cleaned = String(raw).replace(/[\s\u00A0\u202F]/g, '').replace(/[^\d.,]/g, '').replace(',', '.');
    const n = parseFloat(cleaned);
    return Number.isFinite(n) ? n : 0;
  }

  // === ТОЧНЫЕ КОПИИ из content.js ===
  function getRatingFromDom() {
    const sels = ['[class*="address-rate-mini"]', '[class*="product-page__reviews"] [class*="address-rate-mini"]'];
    for (const sel of sels) {
      const el = document.querySelector(sel);
      L('  рейтинг селектор "' + sel + '" => ' + (el ? 'ЭЛЕМЕНТ: ' + JSON.stringify(el.textContent.trim().slice(0, 20)) : 'нет'));
      const v = toNumber(el?.textContent);
      if (v > 0) return v;
    }
    return 0;
  }
  function getReviewsFromDom() {
    const el = document.querySelector('[class*="reviews"]');
    if (el) {
      const t = el.textContent || '';
      L('  отзывы [class*="reviews"] текст: ' + JSON.stringify(t.slice(0, 40)));
      const m = t.match(/([\d\s\u00A0\u202F]+)\s*оцен/i) || t.match(/([\d\s\u00A0\u202F]+)\s*отзыв/i);
      L('  регулярка match: ' + (m ? JSON.stringify(m[1]) : 'НЕ НАШЛО'));
      if (m) { const n = toNumber(m[1]); if (n > 0) return n; }
    } else {
      L('  отзывы [class*="reviews"] => нет элемента');
    }
    return 0;
  }

  L('=== ПРОВЕРКА РЕЙТИНГА ===');
  L('  ИТОГ рейтинг: ' + getRatingFromDom());
  L('=== ПРОВЕРКА ОТЗЫВОВ ===');
  L('  ИТОГ отзывы: ' + getReviewsFromDom());

  // Сколько таких элементов на странице?
  L('=== СКОЛЬКО ЭЛЕМЕНТОВ ===');
  L('  [class*="address-rate-mini"]: ' + document.querySelectorAll('[class*="address-rate-mini"]').length);
  L('  [class*="reviews"]: ' + document.querySelectorAll('[class*="reviews"]').length);
  L('  [data-testid="product-page-reviews-icon"]: ' + document.querySelectorAll('[data-testid="product-page-reviews-icon"]').length);
  L('  [data-testid="product-page-reviews"]: ' + document.querySelectorAll('[data-testid="product-page-reviews"]').length);

  // Все элементы address-rate-mini и их текст
  L('=== ВСЕ address-rate-mini ===');
  document.querySelectorAll('[class*="address-rate-mini"]').forEach((e, i) => {
    L('  [' + i + '] "' + e.textContent.trim().slice(0, 20) + '" class=' + e.className.slice(0, 40));
  });

  // Проверка Shadow DOM (WB может прятать данные в web-компонентах)
  L('=== SHADOW DOM ===');
  const withShadow = Array.from(document.querySelectorAll('*')).filter((e) => e.shadowRoot);
  L('  элементов с shadowRoot: ' + withShadow.length);
  withShadow.slice(0, 5).forEach((e, i) => {
    const inner = e.shadowRoot.querySelector('[class*="address-rate-mini"], [class*="reviews"], [class*="price"]');
    L('  [' + i + '] <' + e.tagName.toLowerCase() + '> shadow содержит аналитику: ' + (inner ? JSON.stringify(inner.textContent.trim().slice(0, 30)) : 'нет'));
  });

  L('=== ДИАГНОСТИКА-4 ГОТОВА ===');
})();
