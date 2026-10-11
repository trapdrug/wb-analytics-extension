// ============================================================
//  ДИАГНОСТИКА-3 WB Analytics  (paste-safe). Ищем НАЗВАНИЕ и
//  ИМЯ ПРОДАВЦА + показываем HTML блоков, чтобы понять структуру.
// ============================================================
void (async function () {
  const L = (t) => console.log('%c[WBA-DIAG3]', 'color:#f59e0b;font-weight:bold', t);
  const q = (s) => document.querySelector(s);
  const txt = (s) => { const e = q(s); return e ? JSON.stringify(e.textContent.trim().slice(0, 60)) : 'нет'; };

  // --- НАЗВАНИЕ ---
  L('--- НАЗВАНИЕ ---');
  L('  document.title: ' + JSON.stringify(document.title));
  L('  [itemprop="name"]: ' + txt('[itemprop="name"]'));
  L('  h1 любой: ' + (document.querySelector('h1') ? 'есть' : 'НЕТ'));
  ['h1', '.product-page__header', '[class*="product-page__header"]',
   '.collapsable__text', '[class*="collapsable"]', '[data-link*="title"]',
   '.product-page__title-wrap', '[class*="goods-name"]'].forEach((s) => L('  ' + s + ' => ' + txt(s)));
  // itemprop среди всех элементов
  const ipn = Array.from(document.querySelectorAll('[itemprop]')).map((e) => e.getAttribute('itemprop'));
  L('  все itemprop на странице: ' + JSON.stringify([...new Set(ipn)]));
  const ipName = q('[itemprop="name"]');
  L('  itemprop=name HTML: ' + (ipName ? JSON.stringify(ipName.outerHTML.slice(0, 200)) : 'нет'));

  // --- ПРОДАВЕЦ (имя) ---
  L('--- ПРОДАВЕЦ (имя) ---');
  const sellerLink = q('a[href*="/seller/"]');
  if (sellerLink) {
    L('  ссылка: ' + sellerLink.href);
    L('  текст ссылки: ' + JSON.stringify(sellerLink.textContent.trim().slice(0, 50)));
    // Ищем имя вверх/вниз по дереву
    let node = sellerLink;
    for (let i = 0; i < 4 && node; i++) {
      node = node.parentElement;
      if (!node) break;
      L('  предок[' + i + '] class="' + node.className.slice(0, 40) + '" текст: ' + JSON.stringify(node.textContent.trim().slice(0, 80)));
    }
    // itemprop seller/brand
    L('  [itemprop="brand"]: ' + txt('[itemprop="brand"]'));
    L('  [itemprop="seller"]: ' + txt('[itemprop="seller"]'));
  } else {
    L('  ссылка /seller/ не найдена');
  }

  // --- ОТЗЫВЫ (точное число) ---
  L('--- ОТЗЫВЫ (точное число) ---');
  const revEl = q('[class*="reviews"]');
  L('  reviews текст: ' + (revEl ? JSON.stringify(revEl.textContent.trim().slice(0, 60)) : 'нет'));
  L('  reviews HTML: ' + (revEl ? JSON.stringify(revEl.outerHTML.slice(0, 300)) : 'нет'));
  // Ищем отдельно "оценк" и "отзыв"
  const oc = Array.from(document.querySelectorAll('span, a, div')).find((e) => /оцен[кi]/.test(e.textContent) && e.textContent.trim().length < 25);
  L('  "N оценок": ' + (oc ? JSON.stringify(oc.textContent.trim()) : 'нет'));

  // --- РЕЙТИНГ (точный) ---
  L('--- РЕЙТИНГ ---');
  const rateEl = q('[class*="address-rate-mini"]');
  L('  address-rate-mini: ' + (rateEl ? JSON.stringify(rateEl.textContent.trim()) : 'нет'));
  L('  [itemprop="ratingValue"]: ' + txt('[itemprop="ratingValue"]'));

  L('=== ДИАГНОСТИКА-3 ГОТОВА. Пришли весь вывод. ===');
})();
