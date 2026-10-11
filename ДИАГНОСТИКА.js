// ============================================================
//  ДИАГНОСТИКА расширения WB Analytics  (вставляется в консоль)
//  ВАЖНО: файл начинается с "void" — при копировании в консоль
//  Chrome не «съест» первый символ, и код гарантированно запустится.
// ============================================================
void (async function () {
  const L = (t) => console.log('%c[WBA-DIAG]', 'color:#7c3aed;font-weight:bold', t);

  L('URL: ' + location.href);
  const nm = (location.pathname.match(/\/catalog\/(\d+)\/detail/) || [])[1];
  L('nmId из URL: ' + (nm || 'НЕ карточка товара'));

  // 1. Перехваченные сетью данные (наш net-intercept.js)
  const net = window.__WBA_NET__ || null;
  L('window.__WBA_NET__: ' + (net ? 'ЕСТЬ' : 'НЕТ (перехват не сработал)'));
  if (net && net.card) {
    L('  net.card => nmId=' + (net.card.nmId || net.card.id) +
      ' salePriceU=' + net.card.salePriceU +
      ' priceU=' + net.card.priceU +
      ' rating=' + net.card.reviewRating +
      ' feedbacks=' + net.card.feedbacks +
      ' supplier=' + net.card.supplier);
  } else if (net) {
    L('  net.card пустой. search.length=' + (net.search ? net.search.length : 0));
  }

  // 2. Глобальные состояния WB
  L('__INITIAL_STATE__: ' + typeof window.__INITIAL_STATE__);
  L('__PRELOADED_STATE__: ' + typeof window.__PRELOADED_STATE__);
  const nextKeys = Object.keys(window).filter((k) => /next|initial|state|redux|store/i.test(k));
  L('похожие глобальные ключи: ' + JSON.stringify(nextKeys));

  // 3. Цена в DOM
  L('--- ЦЕНА В DOM ---');
  ['.price-block__final-price', 'ins.price__lower-price', 'ins[class*="price"]',
   '.product-page__price ins', '[class*="price-block"] ins'].forEach((s) => {
    const el = document.querySelector(s);
    L('  ' + s + ' => ' + (el ? JSON.stringify(el.textContent.trim().slice(0, 30)) : 'нет'));
  });

  // 4. Продавец / название
  L('--- ПРОДАВЕЦ ---');
  ['[class*="seller"] a', 'a[href*="/seller/"]'].forEach((s) => {
    const el = document.querySelector(s);
    L('  ' + s + ' => ' + (el ? JSON.stringify(el.textContent.trim().slice(0, 30)) : 'нет'));
  });
  const h1 = document.querySelector('h1');
  L('h1 (название): ' + (h1 ? JSON.stringify(h1.textContent.trim().slice(0, 50)) : 'нет'));

  // 5. Живой запрос к API карточки прямо из консоли (как это делает страница)
  L('--- ПРЯМОЙ ЗАПРОС card.wb.ru ---');
  if (nm) {
    try {
      const r = await fetch('https://card.wb.ru/cards/v1/detail?appType=1&curr=rub&dest=-1257786&nm=' + nm,
        { credentials: 'include', headers: { Accept: 'application/json' } });
      const j = await r.json();
      const p = (j && j.data && j.data.products && j.data.products[0]) || null;
      if (p) {
        L('API OK ✓  price=' + (p.salePriceU / 100) + '  priceU=' + (p.priceU / 100) +
          '  rating=' + p.reviewRating + '  feedbacks=' + p.feedbacks + '  supplier=' + p.supplier);
      } else {
        L('API ответил, но товара нет: ' + JSON.stringify(j).slice(0, 200));
      }
    } catch (e) {
      L('API ОШИБКА: ' + e.message);
    }
  }

  L('=== ГОТОВО. Скопируй весь вывод выше (начиная с [WBA-DIAG]) и пришли. ===');
})();
