// ============================================================
//  ДИАГНОСТИКА-2 WB Analytics  (вставляется в консоль, paste-safe)
//  Подслушивает ВСЕ сетевые запросы страницы, ищет JSON-LD,
//  data-атрибуты и показывает полный набор DOM-селекторов.
// ============================================================
void (async function () {
  const L = (t) => console.log('%c[WBA-DIAG2]', 'color:#0ea5e9;font-weight:bold', t);
  const seen = [];

  // --- 1. Подслушиваем ВСЕ сетевые запросы (fetch + XHR) ---
  const origFetch = window.fetch;
  window.fetch = function (...a) {
    try {
      const u = typeof a[0] === 'string' ? a[0] : (a[0] && a[0].url) || '';
      if (/wb|wildberries/i.test(u)) seen.push('FETCH ' + u.slice(0, 120));
    } catch (e) {}
    return origFetch.apply(this, a);
  };
  const oo = XMLHttpRequest.prototype.open;
  XMLHttpRequest.prototype.open = function (m, u) {
    try { if (/wb|wildberries/i.test(u)) seen.push('XHR ' + String(u).slice(0, 120)); } catch (e) {}
    return oo.apply(this, arguments);
  };
  L('Подслушиваю сеть 6 секунд... (полистай/подожди)');

  // --- 2. JSON-LD (часто содержит цену/рейтинг/бренд) ---
  L('--- JSON-LD ---');
  document.querySelectorAll('script[type="application/ld+json"]').forEach((s, i) => {
    L('  ld+json[' + i + ']: ' + (s.textContent || '').trim().slice(0, 300));
  });

  // --- 3. Полный DOM-парсинг по множеству селекторов ---
  const pick = (sel) => document.querySelector(sel);
  const txt = (sel) => { const e = pick(sel); return e ? JSON.stringify(e.textContent.trim().slice(0, 40)) : 'нет'; };

  L('--- НАЗВАНИЕ ---');
  ['h1', '[class*="product-page__header"] span', '.product-page__title', '[data-link*="textFormat"]'].forEach((s) => L('  ' + s + ' => ' + txt(s)));

  L('--- ЦЕНА ---');
  ['ins[class*="price"]', '.price-block__final-price', 'ins.price__lower-price', '.price-block__price'].forEach((s) => L('  ' + s + ' => ' + txt(s)));

  L('--- ЦЕНА ДО СКИДКИ ---');
  ['del[class*="price"]', '.price-block__old-price', 'del', '.price-block__old-price'].forEach((s) => L('  ' + s + ' => ' + txt(s)));

  L('--- РЕЙТИНГ / ОТЗЫВЫ ---');
  ['[class*="address-rate-mini"]', '.product-page__reviews', '[class*="reviews"]', '[class*="rating"]', '[class*="stars"]'].forEach((s) => L('  ' + s + ' => ' + txt(s)));
  // Ищем чисто по тексту «отзыв»
  const rev = Array.from(document.querySelectorAll('a, span, div')).find((e) => /отзыв/i.test(e.textContent) && e.textContent.trim().length < 30);
  L('  элемент с "отзыв": ' + (rev ? JSON.stringify(rev.textContent.trim()) + ' class=' + rev.className : 'нет'));

  L('--- ПРОДАВЕЦ ---');
  ['[class*="seller-info"]', '[class*="seller-content"]', 'a[href*="/seller/"]', '[class*="j-supplier"]'].forEach((s) => L('  ' + s + ' => ' + txt(s)));
  const sel = Array.from(document.querySelectorAll('a')).find((a) => /\/seller\//.test(a.href));
  L('  ссылка на /seller/: ' + (sel ? sel.href + ' | текст=' + JSON.stringify(sel.textContent.trim().slice(0, 30)) : 'нет'));

  // --- 4. data-атрибуты на body / контейнерах (WB иногда там прячет данные) ---
  L('--- DATA-АТРИБУТЫ (ищем nmId) ---');
  const withData = document.querySelectorAll('[data-nm-id], [data-popup-nm-id], [data-target-nm-id]');
  L('  найдено элементов с data-nm-id: ' + withData.length);
  if (withData.length) {
    const el = withData[0];
    L('  первый: nmId=' + (el.getAttribute('data-nm-id') || el.getAttribute('data-popup-nm-id')) + ' class=' + el.className.slice(0, 40));
  }

  // --- 5. Ждём и показываем перехваченные запросы ---
  await new Promise((r) => setTimeout(r, 6000));
  L('--- ПЕРЕХВАЧЕННЫЕ ЗАПРОСЫ (за 6 сек) ---');
  if (seen.length) {
    const uniq = [...new Set(seen)].slice(0, 30);
    uniq.forEach((u) => L('  ' + u));
  } else {
    L('  сетевых запросов к wb/wildberries НЕ перехвачено (данные пришли в SSR/HTML).');
  }
  L('=== ДИАГНОСТИКА-2 ГОТОВА. Пришли весь вывод. ===');
})();
