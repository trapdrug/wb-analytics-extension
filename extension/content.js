/**
 * Wildberries Analytics — content script.
 *
 * Что делает:
 *  1. Определяет тип страницы: поиск (каталог) или карточка товара (detail.aspx);
 *  2. Парсит данные товара из window.__INITIAL_STATE__ (приоритет) и из DOM (fallback);
 *  3. Проксирует сетевые запросы через background service worker
 *     (chrome.runtime.sendMessage), чтобы обойти CORS и получить throttling/backoff;
 *  4. Рисует изолированный UI через Shadow DOM:
 *     - на поиске — бейдж с выручкой в день рядом с карточкой;
 *     - на карточке — панель справа с графиком цены, прогнозом продаж
 *       и кнопкой «Отслеживать».
 *
 * Комментарии на русском. Внешних зависимостей нет, кроме Chart.js (CDN),
 * который лениво подгружается только для панели карточки.
 */

(function () {
  'use strict';

  /** CDN для Chart.js — используется в панели карточки. */
  const CHARTJS_CDN =
    'https://cdn.jsdelivr.net/npm/chart.js@4.4.1/dist/chart.umd.min.js';

  /** Максимум карточек, которые размечаем бейджами на странице поиска. */
  const MAX_SEARCH_BADGES = 40;

  /** ─────────── Состояние модуля ─────────── */

  /** Корень Shadow DOM, в котором живёт весь наш UI (создаётся один раз). */
  let shadowRoot = null;

  /** Последний распарсенный товар карточки (для панели). */
  let currentProduct = null;

  /** Таймер debounce для наблюдателя мутаций DOM. */
  let mutationDebounce = null;

  /** Метки страницы. */
  let isSearchPage = false;
  let isDetailPage = false;

  /** ─────────── Мелкие утилиты ─────────── */

  /** Логи с префиксом — удобно отлаживать в консоли страницы. */
  function log(...args) {
    console.log('[WBAnalytics]', ...args);
  }

  /** Преобразует строку вида «1 299 ₽» / «1299,50» в число. */
  function toNumber(raw) {
    if (typeof raw === 'number') return raw;
    if (raw == null) return 0;
    const cleaned = String(raw)
      .replace(/[\s\u00A0\u202F]/g, '')
      .replace(/[^\d.,]/g, '')
      .replace(',', '.');
    const n = parseFloat(cleaned);
    return Number.isFinite(n) ? n : 0;
  }

  /** Форматирует число в денежный вид: 1299 -> «1 299 ₽». */
  function fmtMoney(value) {
    const n = Number(value);
    if (!Number.isFinite(n) || n <= 0) return '—';
    return n.toLocaleString('ru-RU', { maximumFractionDigits: 0 }) + ' ₽';
  }

  /** Форматирует «большие» деньги коротко: 152000 -> «152 тыс ₽». */
  function fmtMoneyShort(value) {
    const n = Number(value);
    if (!Number.isFinite(n) || n <= 0) return '—';
    if (n >= 1_000_000) return (n / 1_000_000).toFixed(1).replace('.0', '') + ' млн ₽';
    if (n >= 1000) return Math.round(n / 1000) + ' тыс ₽';
    return Math.round(n) + ' ₽';
  }

  /** Форматирует число: 12345 -> «12 345». */
  function fmtNum(value) {
    const n = Number(value);
    if (!Number.isFinite(n)) return '—';
    return n.toLocaleString('ru-RU', { maximumFractionDigits: 1 });
  }

  /** Дожидается появления элемента в DOM (WB — SPA, рендерит позже). */
  function waitFor(selector, timeout = 8000) {
    return new Promise((resolve) => {
      const found = document.querySelector(selector);
      if (found) return resolve(found);
      const obs = new MutationObserver(() => {
        const el = document.querySelector(selector);
        if (el) {
          obs.disconnect();
          resolve(el);
        }
      });
      obs.observe(document.body, { childList: true, subtree: true });
      setTimeout(() => {
        obs.disconnect();
        resolve(null);
      }, timeout);
    });
  }

  /** ─────────── Определение типа страницы ─────────── */

  /**
   * Ищет первый элемент, у которого РОВНО совпадает текст (или текст ребёнка)
   * с регуляркой. Учитывает видимые текстовые узлы, чтобы не цеплять огромные
   * контейнеры. Возвращает самый «глубокий/точный» совпавший элемент.
   */
  function findByText(regex, selector) {
    const els = document.querySelectorAll(selector);
    let best = null;
    for (const el of els) {
      // собственный текст элемента без вложенных детей — точнее
      const own = Array.from(el.childNodes)
        .filter((n) => n.nodeType === Node.TEXT_NODE)
        .map((n) => n.textContent.trim())
        .join(' ')
        .trim();
      const text = own || (el.textContent || '').trim();
      if (!text || text.length > 60) continue;
      if (regex.test(text)) {
        best = el;
        break; // берём первый (самый ранний в DOM) совпавший
      }
    }
    return best;
  }

  function detectPageType() {
    const path = window.location.pathname;
    // Карточка: /catalog/12345678/detail.aspx
    isDetailPage = /\/catalog\/\d+\/detail\.aspx/i.test(path);
    // Поиск/каталог: /catalog/... но не detail.aspx
    isSearchPage = /^\/catalog\//.test(path) && !isDetailPage;
  }

  /** Достаёт nmId из URL карточки или query-параметра ?nm=. */
  function getNmIdFromUrl() {
    const m = window.location.pathname.match(/\/catalog\/(\d+)\/detail\.aspx/i);
    if (m) return parseInt(m[1], 10);
    const q = new URLSearchParams(window.location.search).get('nm');
    return q ? parseInt(q, 10) : 0;
  }

  /** ─────────── Парсинг данных товара ─────────── */

  /** Читает window.__INITIAL_STATE__ (может быть строкой JSON или объектом). */
  function getInitialState() {
    // Новые/старые имена, под которыми WB мог отдавать состояние.
    const names = [
      '__INITIAL_STATE__',
      '__PRELOADED_STATE__',
      '__NUXT__',
      '__DATA__',
      'WB_STATE',
    ];
    for (const name of names) {
      const raw = window[name];
      if (!raw) continue;
      if (typeof raw === 'string') {
        try {
          const parsed = JSON.parse(raw);
          if (parsed) return parsed;
        } catch (e) {
          // не JSON — пропускаем
        }
      } else if (typeof raw === 'object') {
        return raw;
      }
    }
    return null;
  }

  /**
   * Глубоко ищет в объекте первый подходящий товар (с полями nmId/id и
   * ценой salePriceU/priceU). Помогает, когда WB меняет структуру состояния.
   * Ограничиваем глубину и число узлов, чтобы не тормозить.
   */
  function deepFindProduct(root, nmId, maxNodes) {
    let visited = 0;
    const seen = new Set();
    const stack = [root];
    while (stack.length && visited < maxNodes) {
      const node = stack.pop();
      if (!node || typeof node !== 'object') continue;
      if (seen.has(node)) continue;
      seen.add(node);
      visited++;
      // Похоже на товар WB?
      if (
        (node.nmId === nmId || node.id === nmId) &&
        (node.salePriceU !== undefined ||
          node.priceU !== undefined ||
          node.name !== undefined)
      ) {
        return node;
      }
      for (const key in node) {
        if (!Object.prototype.hasOwnProperty.call(node, key)) continue;
        const val = node[key];
        if (val && typeof val === 'object') stack.push(val);
      }
    }
    return null;
  }

  /**
   * Вытаскивает объект товара из состояния карточки WB.
   * В разных версиях вёрстки структура отличается — пробуем несколько путей,
   * затем — глубокий поиск.
   */
  function extractFromState(state) {
    if (!state) return null;
    const nmId = getNmIdFromUrl();
    const paths = [
      state?.product,
      state?.productGroup?.product,
      state?.mainNode?.product,
      state?.route?.product,
      state?.detail?.product,
      state?.card?.product,
      state?.data?.product,
      state?.data?.products?.[0],
      state?.products?.[0],
    ];
    for (const p of paths) {
      if (p && (p.nmId || p.id)) return p;
    }
    // Глубокий поиск как последний шанс из состояния.
    if (nmId) {
      const found = deepFindProduct(state, nmId, 20000);
      if (found) return found;
    }
    return null;
  }

  /** Приводит «сырой» объект товара к нашему единому виду. */
  function normalizeProduct(raw, nmIdFromUrl) {
    if (!raw) return null;

    // WB отдаёт цены в копейках. Текущая цена (крупная на странице) — salePriceU,
    // цена без скидки (зачёркнутая) — priceU / basePriceU. Нормализуем в рубли.
    const toRub = (v) => (Number(v) > 5000 ? Math.round(Number(v) / 100) : Number(v) || 0);
    const saleU = Number(raw.salePriceU ?? raw.salePrice ?? raw.sale ?? 0) || 0;
    const baseU = Number(raw.priceU ?? raw.basePriceU ?? raw.price ?? raw.priceBefore ?? 0) || 0;

    let price = toRub(saleU);
    let priceBefore = toRub(baseU);
    // Если скидки нет (sale == base), показываем только одну цену
    if (!price) price = priceBefore;
    if (priceBefore && priceBefore < price) {
      // На случай если WB поменял поля местами — гарантируем price <= priceBefore
      const t = priceBefore; priceBefore = price; price = t;
    }
    if (priceBefore && priceBefore === price) priceBefore = 0;

    return {
      nmId: raw.nmId ?? raw.id ?? nmIdFromUrl ?? 0,
      imtId: raw.imtId ?? 0,
      name: raw.name ?? raw.title ?? '',
      price: price || 0,
      priceBefore: priceBefore || 0,
      rating: Number(raw.reviewRating ?? raw.rating ?? raw.productRating ?? 0) || 0,
      reviewsCount: Number(raw.feedbacks ?? raw.nmFeedbacks ?? raw.reviewsCount ?? raw.feedbackCount ?? 0) || 0,
      seller: raw.supplier ?? raw.supplierName ?? raw.seller ?? raw.brand ?? '',
      remaining: Number(raw.totalQuantity ?? raw.remaining ?? raw.stocks ?? 0) || 0,
      category: raw.subjectParent ?? raw.subject ?? raw.entity ?? raw.category ?? '',
      parsedAt: Date.now(),
    };
  }

  /**
   * Имя продавца из DOM карточки.
   * В текущей вёрстке WB ссылка на продавца пустая по тексту, а имя лежит
   * в родительском блоке вида "House hold ecomПродавец4,9" — берём текст
   * этого блока и отрезаем всё со слова «Продавец» (подпись + рейтинг продавца).
   */
  function getSellerFromDom() {
    const link = document.querySelector('a[href*="/seller/"]');
    if (link) {
      const item =
        link.closest('[class*="sellerAndBrand"]') ||
        link.closest('[class*="seller-info"]') ||
        link.closest('[class*="seller-content"]') ||
        link.parentElement;
      if (item) {
        let t = (item.textContent || '').trim();
        // Отрезаем подпись «Продавец» и всё после неё (рейтинг продавца).
        t = t.split(/продавец/i)[0].trim();
        // Убираем возможные хвостовые цифры/рейтинг.
        t = t.replace(/[\s\d.,]+$/, '').trim();
        if (t && t.length >= 2 && !/стать продавцом/i.test(t)) return t;
      }
    }
    // Фолбэк: альтернативные селекторы.
    const sels = [
      '[class*="sellerAndBrandItem"] [class*="seller-name"]',
      '[class*="seller-name"]',
      '[class*="seller-info"] a',
      '.product-page__seller a',
    ];
    for (const sel of sels) {
      const el = document.querySelector(sel);
      const txt = el?.textContent?.trim();
      if (txt && txt.length >= 2 && !/стать продавцом/i.test(txt)) return txt;
    }
    return '';
  }

  /**
   * Название из DOM карточки.
   * WB больше не использует <h1> для названия, зато всегда кладёт его в
   * document.title в виде «<название> <артикул> купить за <цена> ₽ ...».
   */
  function getNameFromDom() {
    const title = (document.title || '').trim();
    if (title) {
      let name = title
        .replace(/\s+купить\s+за.*$/i, '')      // хвост «купить за ...»
        .replace(/\s+в\s+интернет[-‑]?магазине.*$/i, '')
        .replace(/\s+\d{5,}\s*$/, '');            // артикул в конце
      name = name.trim();
      if (name.length > 3) return name;
    }
    const sels = ['h1', '.product-page__title', '[class*="product-page__header"]'];
    for (const sel of sels) {
      const t = document.querySelector(sel)?.textContent?.trim();
      if (t && t.length > 3) return t;
    }
    return '';
  }

  /** Текущая цена из DOM. */
  function getPriceFromDom() {
    const sels = [
      'ins[class*="price"]',
      '.price-block__final-price',
      'ins.price__lower-price',
    ];
    for (const sel of sels) {
      const v = toNumber(document.querySelector(sel)?.textContent);
      if (v > 0) return v;
    }
    return 0;
  }

  /** Цена до скидки из DOM. Старая цена WB часто зачёркнута (del/old-price). */
  function getPriceBeforeFromDom() {
    const price = getPriceFromDom();
    const sels = [
      'del[class*="price"]',
      '.price-block__old-price',
      'del.price__old-price',
      '[class*="old-price"]',
      '[class*="price"] del',
    ];
    for (const sel of sels) {
      const v = toNumber(document.querySelector(sel)?.textContent);
      if (v > 0 && v !== price && v > price) return v;
    }
    // Фолбэк: в блоке покупки цены идут текстом «1 511 ₽22 000 ₽…».
    // Собираем все «N ₽» и берём максимум, больший текущей цены.
    const cur = document.querySelector('ins[class*="price"]');
    const block =
      cur?.closest('[class*="price"], [class*="order"], [class*="buy"]') ||
      document.querySelector('[class*="order"], [class*="buy"]');
    if (block) {
      const nums = (block.textContent.match(/\d[\d\s\u00A0\u202F]*₽/g) || [])
        .map((s) => toNumber(s))
        .filter((n) => n > 0 && n > price);
      if (nums.length) return Math.max(...nums);
    }
    return 0;
  }

  /** Рейтинг из DOM. */
  function getRatingFromDom() {
    const sels = [
      '[class*="address-rate-mini"]',
      '[class*="product-page__reviews"] [class*="address-rate-mini"]',
    ];
    for (const sel of sels) {
      const v = toNumber(document.querySelector(sel)?.textContent);
      if (v > 0) return v;
    }
    return 0;
  }

  /**
   * Количество отзывов из DOM.
   * Текст блока отзывов — «5,076 оценок53+» или «51 123 оценки99+».
   * Запятая тут разделитель разрядов (5,076 = 5076), поэтому убираем её
   * ДО парсинга, иначе toNumber примет «5,076» за дробное 5.076.
   */
  function getReviewsFromDom() {
    const el = document.querySelector('[class*="reviews"]');
    if (el) {
      let t = (el.textContent || '').replace(/,/g, ''); // 5,076 -> 5076
      const m =
        t.match(/([\d\s\u00A0\u202F]+)\s*оцен/i) ||
        t.match(/([\d\s\u00A0\u202F]+)\s*отзыв/i);
      if (m) {
        const n = toNumber(m[1]);
        if (n > 0) return n;
      }
    }
    const sels = [
      '[class*="reviews"] [class*="count"]',
      '[class*="feedback"] [class*="count"]',
    ];
    for (const sel of sels) {
      const v = toNumber(document.querySelector(sel)?.textContent);
      if (v > 0) return v;
    }
    return 0;
  }

  /** Остаток из DOM (если WB показывает «Осталось N шт»). */
  function getRemainingFromDom() {
    const el = document.querySelector('[class*="remain"], [class*="stock"], [class*="quantity"]');
    if (!el) return 0;
    const m = (el.textContent || '').match(/(\d+)/);
    return m ? parseInt(m[1], 10) : 0;
  }

  /** Собирает товар карточки из DOM (фолбэк, если API недоступен). */
  function parseProductFromDom(nmId) {
    return {
      nmId,
      imtId: 0,
      name: getNameFromDom(),
      price: getPriceFromDom(),
      priceBefore: getPriceBeforeFromDom(),
      rating: getRatingFromDom(),
      reviewsCount: getReviewsFromDom(),
      seller: getSellerFromDom(),
      remaining: getRemainingFromDom(),
      category: '',
      parsedAt: Date.now(),
    };
  }


  /** Объединяет несколько источников товара, отдавая приоритет ранним полям. */
  function mergeProducts(...sources) {
    const out = {
      nmId: 0, imtId: 0, name: '', price: 0, priceBefore: 0,
      rating: 0, reviewsCount: 0, seller: '', remaining: 0,
      category: '', parsedAt: Date.now(),
    };
    for (const src of sources) {
      if (!src) continue;
      if (!out.nmId && src.nmId) out.nmId = src.nmId;
      if (!out.imtId && src.imtId) out.imtId = src.imtId;
      if (!out.name && src.name) out.name = src.name;
      if (!out.price && src.price) out.price = src.price;
      if (!out.priceBefore && src.priceBefore) out.priceBefore = src.priceBefore;
      if (!out.rating && src.rating) out.rating = src.rating;
      if (!out.reviewsCount && src.reviewsCount) out.reviewsCount = src.reviewsCount;
      if (!out.seller && src.seller) out.seller = src.seller;
      if (!out.remaining && src.remaining) out.remaining = src.remaining;
      if (!out.category && src.category) out.category = src.category;
    }
    return out;
  }

  /**
   * Собирает товар карточки.
   * Практика показала: на текущей вёрстке WB данные карточки лежат прямо
   * в HTML (SSR), а сетевые запросы к card.wb.ru блокируются (403/CORS).
   * Поэтому ГЛАВНЫЙ источник — DOM. Сеть/состояние используем как бонус,
   * не блокируя отрисовку панели ожиданием.
   * Возвращает promise с товаром.
   */
  async function parseProduct() {
    const nmId = getNmIdFromUrl();

    // 0. DOM — единственный надёжный источник на текущей вёрстке WB
    // (запросы к card.wb.ru блокируются: 403/CORS/CSP).
    const fromDom = parseProductFromDom(nmId);

    // 1. Состояние WB (если присутствует).
    const state = getInitialState();
    const fromState = normalizeProduct(extractFromState(state), nmId);

    // Приоритет: DOM → состояние. Доминирует то, что заполнено.
    const merged = mergeProducts(fromDom, fromState, { nmId });
    if (!merged.seller) merged.seller = getSellerFromDom();
    merged.nmId = merged.nmId || nmId;
    return merged;
  }

  /** ─────────── Парсинг страницы поиска ─────────── */

  /**
   * Достаёт товары из выдачи: сначала __INITIAL_STATE__ (SSR-состояние WB),
   * затем DOM. Возвращаем массив «лёгких» объектов карточек.
   */
  function parseSearchResults() {
    // 1. Состояние WB (если присутствует).
    const state = getInitialState();
    const fromState = extractSearchFromState(state);
    if (fromState && fromState.length) return fromState;
    // 2. DOM.
    return extractSearchFromDom();
  }

  /** Приводит «сырой» товар выдачи к единому виду. */
  function mapSearchProduct(p) {
    const price = normalizeMoney(p.salePriceU ?? p.priceU ?? p.price);
    const priceBefore = normalizeMoney(p.priceU ?? p.basePriceU ?? p.price_before);
    return {
      nmId: p.nmId ?? p.id ?? 0,
      name: p.name ?? p.title ?? '',
      price,
      priceBefore: priceBefore && priceBefore !== price ? priceBefore : 0,
      rating: p.rating ?? p.reviewRating ?? 0,
      reviewsCount: p.reviewsCount ?? p.feedbacks ?? 0,
      seller: p.supplier ?? p.seller ?? p.brand ?? '',
      remaining: p.totalQuantity ?? p.remaining ?? 0,
    };
  }

  /** Ищет массив товаров внутри состояния (пути могут отличаться). */
  function extractSearchFromState(state) {
    if (!state) return [];
    const containers = [
      state?.search?.products,
      state?.search2?.products,
      state?.catalog?.products,
      state?.mainNode?.catalog?.products,
      state?.search?.data?.products,
      state?.data?.products,
    ];
    for (const list of containers) {
      if (Array.isArray(list) && list.length) {
        return list.slice(0, MAX_SEARCH_BADGES).map((p) => {
          const price = normalizeMoney(p.salePriceU ?? p.priceU ?? p.price);
          const priceBefore = normalizeMoney(p.priceU ?? p.basePriceU ?? p.price_before);
          return {
            nmId: p.nmId ?? p.id ?? 0,
            name: p.name ?? p.title ?? '',
            price,
            priceBefore: priceBefore && priceBefore !== price ? priceBefore : 0,
            rating: p.rating ?? p.reviewRating ?? 0,
            reviewsCount: p.reviewsCount ?? p.feedbacks ?? 0,
            seller: p.supplier ?? p.seller ?? p.brand ?? '',
            remaining: p.totalQuantity ?? p.remaining ?? 0,
          };
        });
      }
    }
    return [];
  }

  /** Цены в состоянии WB — в копейках, нормализуем в рубли. */
  function normalizeMoney(value) {
    const n = Number(value) || 0;
    return n > 5000 ? Math.round(n / 100) : n;
  }

  /** Fallback: парсим карточки прямо из DOM выдачи. */
  function extractSearchFromDom() {
    const cards = document.querySelectorAll(
      '.product-card__wrapper, [class*="product-card"], .j-card-item'
    );
    const result = [];
    cards.forEach((card) => {
      if (result.length >= MAX_SEARCH_BADGES) return;
      const nmId =
        card.getAttribute('data-nm-id') ||
        card.getAttribute('data-popup-nm-id') ||
        card.getAttribute('data-id') ||
        extractNmIdFromLink(card);
      const priceEl = card.querySelector('.price__lower-price, ins[class*="price"]');
      const nameEl = card.querySelector(
        '.product-card__name, [class*="goods-name"], span[class*="name"]'
      );
      result.push({
        nmId: parseInt(nmId, 10) || 0,
        name: nameEl?.textContent?.trim() || '',
        price: toNumber(priceEl?.textContent),
        priceBefore: 0,
        rating: 0,
        reviewsCount: 0,
        seller: '',
        remaining: 0,
      });
    });
    return result.filter((p) => p.nmId > 0);
  }

  /** Достаёт nmId из ссылки на карточку внутри элемента. */
  function extractNmIdFromLink(card) {
    const link = card.querySelector('a[href*="/catalog/"]');
    if (!link) return 0;
    const m = link.getAttribute('href').match(/\/catalog\/(\d+)\/detail/);
    return m ? parseInt(m[1], 10) : 0;
  }

  /** ─────────── Связь с background service worker ─────────── */

  /** Универсальная обёртка над chrome.runtime.sendMessage с ожиданием ответа. */
  function sendToBackground(message) {
    return new Promise((resolve) => {
      try {
        chrome.runtime.sendMessage(message, (response) => {
          // В MV3 при ошибке обращения lastError заполнен
          if (chrome.runtime.lastError) {
            log('background ошибка:', chrome.runtime.lastError.message);
            return resolve({ ok: false, error: chrome.runtime.lastError.message });
          }
          resolve(response || { ok: false, error: 'пустой ответ' });
        });
      } catch (e) {
        resolve({ ok: false, error: e.message });
      }
    });
  }

  /**
   * Отправляет товар на локальный backend через background (обход CORS).
   * background делает fetch POST /api/product и возвращает метрики.
   */
  function reportProduct(product) {
    return sendToBackground({ type: 'WB_REPORT_PRODUCT', product });
  }

  /**
   * Запрашивает у backend метрики (скорость продаж, история цен) для nmId.
   */
  function getMetrics(nmId) {
    return sendToBackground({ type: 'WB_GET_METRICS', nmId });
  }

  /** Локальная оценка выручки в день (price * продаж/день). */
  function estimateRevenuePerDay(price, salesPerDay) {
    if (!price || !salesPerDay) return 0;
    return price * salesPerDay;
  }

  /** ─────────── Изолированный UI: Shadow DOM ─────────── */

  /**
   * Создаёт (один раз) host-элемент с Shadow DOM и возвращает его корень.
   * Весь наш UI живёт внутри shadow-root — стили WB не затрагиваются.
   */
  function ensureShadowHost() {
    if (shadowRoot) return shadowRoot;
    const host = document.createElement('div');
    host.id = 'wb-analytics-host';
    // host не должен влиять на вёрстку WB
    host.style.cssText = 'all: initial; position: static; z-index: 2147483000;';
    document.body.appendChild(host);
    shadowRoot = host.attachShadow({ mode: 'open' });
    const style = document.createElement('style');
    style.textContent = SHADOW_STYLES;
    shadowRoot.appendChild(style);
    return shadowRoot;
  }

  /** CSS для нашего UI. Живёт внутри shadow-root, стили WB не трогает. */
  const SHADOW_STYLES = `
    :host { all: initial; }
    .wba-panel {
      /* Встраиваемый блок: участвует в потоке WB, НЕ висит поверх страницы. */
      position: static;
      width: 100%;
      box-sizing: border-box;
      background: #ffffff;
      border: 1px solid #e2e8f0;
      border-radius: 16px;
      box-shadow: 0 2px 10px rgba(15, 23, 42, 0.06);
      font-family: -apple-system, "Segoe UI", Roboto, Arial, sans-serif;
      color: #0f172a;
      padding: 16px;
      margin: 16px 0;
    }
    .wba-panel__header {
      display: flex; align-items: center; justify-content: space-between;
      margin-bottom: 12px;
    }
    .wba-panel__title { font-size: 15px; font-weight: 700; }
    .wba-panel__close {
      border: none; background: #f1f5f9; color: #475569; cursor: pointer;
      width: 26px; height: 26px; border-radius: 8px; font-size: 14px; line-height: 1;
    }
    .wba-panel__close:hover { background: #e2e8f0; }
    .wba-row {
      display: flex; align-items: baseline; justify-content: space-between;
      padding: 7px 0; border-bottom: 1px dashed #eef2f7; font-size: 13px;
    }
    .wba-row:last-child { border-bottom: none; }
    .wba-row__label { color: #64748b; }
    .wba-row__value { font-weight: 700; font-variant-numeric: tabular-nums; }
    .wba-row__value--up { color: #059669; }
    .wba-row__value--down { color: #dc2626; }
    .wba-chart-wrap { margin-top: 12px; height: 150px; position: relative; }
    .wba-chart { width: 100% !important; height: 150px !important; }
    .wba-btn {
      margin-top: 14px; width: 100%; padding: 10px 12px;
      border: none; border-radius: 10px; cursor: pointer;
      background: #7c3aed; color: #fff; font-size: 13px; font-weight: 600;
      transition: background 0.15s ease;
    }
    .wba-btn:hover { background: #6d28d9; }
    .wba-btn--tracked { background: #059669; }
    .wba-btn--tracked:hover { background: #047857; }
    .wba-badge {
      display: inline-flex; align-items: center; gap: 4px;
      margin: 6px 0 0; padding: 3px 8px;
      background: #ede9fe; color: #6d28d9;
      border: 1px solid #ddd6fe; border-radius: 999px;
      font-family: -apple-system, "Segoe UI", Roboto, Arial, sans-serif;
      font-size: 11px; font-weight: 700; line-height: 1.4;
      white-space: nowrap; cursor: default;
    }
    .wba-badge--hot { background: #fee2e2; color: #b91c1c; border-color: #fecaca; }
    .wba-toast {
      position: fixed; bottom: 24px; left: 50%; transform: translateX(-50%);
      background: #0f172a; color: #fff; padding: 10px 18px; border-radius: 10px;
      font-family: -apple-system, "Segoe UI", Roboto, Arial, sans-serif;
      font-size: 13px; z-index: 2147483001; opacity: 0.95;
      transition: opacity 0.3s ease;
    }
  `;

  /** Показывает короткое всплывающее уведомление. */
  function showToast(text, ms = 2600) {
    const root = ensureShadowHost();
    const toast = document.createElement('div');
    toast.className = 'wba-toast';
    toast.textContent = text;
    root.appendChild(toast);
    setTimeout(() => {
      toast.style.opacity = '0';
      setTimeout(() => toast.remove(), 350);
    }, ms);
  }

  /** ─────────── UI: бейджи на странице поиска ─────────── */

  /**
   * Создаёт бейдж с расчётной выручкой в день.
   * «Горячие» товары (выручка >= 100 000 ₽/день) подсвечиваются красным.
   */
  function createBadge(revenuePerDay) {
    const badge = document.createElement('span');
    const isHot = revenuePerDay >= 100000; // порог «горячего» товара
    badge.className = 'wba-badge' + (isHot ? ' wba-badge--hot' : '');
    badge.title = 'Расчётная выручка в день (WB Analytics)';
    badge.textContent = '≈ ' + fmtMoneyShort(revenuePerDay) + '/день';
    return badge;
  }

  /** Размечает выдачу: парсит товары и вешает бейджи на карточки. */
  async function decorateSearchPage() {
    const products = parseSearchResults();
    if (!products.length) return;

    // Карточки в DOM в том же порядке, что и товары в состоянии
    const cards = document.querySelectorAll(
      '.product-card__wrapper, [class*="product-card"], .j-card-item'
    );

    let matched = 0;
    for (let i = 0; i < products.length && matched < MAX_SEARCH_BADGES; i++) {
      const product = products[i];
      const card = cards[i];
      if (!card || !product.nmId) continue;

      // Не дублируем бейдж при повторной обработке (SPA перерисовывает выдачу)
      if (card.querySelector('.wba-badge-host')) continue;

      // Просим backend пересчитать метрики по этому товару
      const res = await reportProduct(product);
      const metrics = res && res.ok ? res.metrics : null;
      const revenuePerDay = metrics?.revenuePerDay ?? 0;

      // Хост для бейджа (shadow, чтобы CSS не конфликтовал)
      const host = document.createElement('div');
      host.className = 'wba-badge-host';
      host.style.cssText = 'all: initial; display: block;';
      const badgeRoot = host.attachShadow({ mode: 'open' });
      const badgeStyle = document.createElement('style');
      badgeStyle.textContent = SHADOW_STYLES;
      badgeRoot.appendChild(badgeStyle);
      badgeRoot.appendChild(createBadge(revenuePerDay));

      // Вставляем бейдж в футер карточки (или просто в конец)
      const footer = card.querySelector('.product-card__footer, [class*="footer"]') || card;
      footer.appendChild(host);
      matched++;
    }
  }

  /** ─────────── UI: панель на карточке товара ─────────── */

  /** Ленивая загрузка Chart.js (один раз) и возврат глобального конструктора. */
  let chartJsPromise = null;
  function loadChartJs() {
    if (chartJsPromise) return chartJsPromise;
    chartJsPromise = new Promise((resolve, reject) => {
      if (window.Chart) return resolve(window.Chart);
      const script = document.createElement('script');
      script.src = CHARTJS_CDN;
      script.onload = () => resolve(window.Chart);
      script.onerror = () => reject(new Error('не удалось загрузить Chart.js'));
      document.head.appendChild(script);
    });
    return chartJsPromise;
  }

  /**
   * Находит место в интерфейсе WB, куда встроить панель.
   * Пользователь просил: в правой колонке, под кнопкой «Купить сейчас».
   * Возвращает { parent, ref } — куда вставлять (ref=null → добавить в конец).
   */
  function findInsertionPoint() {
    // Приоритет 1: блок заказа/покупки (кнопки «В корзину» / «Купить сейчас»).
    // Вставляем панель сразу ПОСЛЕ этого блока — т.е. под кнопками, в той же
    // правой колонке карточки.
    const buySelectors = [
      '.order',
      '[class*="order-wrap"]',
      '[class*="product-page__order"]',
      '[class*="j-order"]',
      '[class*="buy-block"]',
      '[class*="orderBlock"]',
    ];
    for (const sel of buySelectors) {
      const el = document.querySelector(sel);
      if (el && el.parentElement) {
        return { parent: el.parentElement, ref: el.nextElementSibling };
      }
    }

    // Приоритет 2: кнопка «Купить сейчас»/«Добавить в корзину» по тексту.
    // Поднимаемся до её «колоночного» контейнера и вставляем панель после него.
    const buyBtn = findByText(
      /купить сейчас|добавить в корзину/i,
      'button, a, div[role="button"]'
    );
    if (buyBtn) {
      let node = buyBtn;
      for (let i = 0; i < 6 && node; i++) {
        node = node.parentElement;
        if (!node) break;
        const w = node.offsetWidth;
        // колонка WB справа обычно 240–520px; вставляем сразу под ней
        if (w >= 240 && w <= 520 && node.parentElement) {
          return { parent: node.parentElement, ref: node.nextElementSibling };
        }
      }
      if (buyBtn.parentElement) {
        return { parent: buyBtn.parentElement, ref: buyBtn.nextElementSibling };
      }
    }

    // Приоритет 3: блок спец-предложений («Все N предложений от ...»).
    const offersHeading = findByText(
      /все\s+\d+\s+предложени|предложени\w*\s+от\s+\d/i,
      'h1, h2, h3, div, span'
    );
    if (offersHeading) {
      const section = offersHeading.closest('section, div[class]') || offersHeading;
      if (section && section.parentElement) {
        return { parent: section.parentElement, ref: section };
      }
    }

    // Приоритет 4: блок цены — берём его контейнер-колонку.
    const priceEl = document.querySelector(
      '.price-block, .product-page__price, [class*="price-block"], ins[class*="price"]'
    );
    if (priceEl) {
      let node = priceEl;
      for (let i = 0; i < 6 && node; i++) {
        node = node.parentElement;
        if (!node) break;
        const w = node.offsetWidth;
        if (w >= 240 && w <= 520) {
          return { parent: node, ref: null };
        }
      }
      if (priceEl.parentElement) {
        return { parent: priceEl.parentElement, ref: priceEl.nextElementSibling };
      }
    }

    return null;
  }

  /** Создаёт host + Shadow DOM для панели (отдельно от тостов). */
  function createPanelHost() {
    const host = document.createElement('div');
    host.className = 'wba-panel-host';
    host.style.cssText =
      'all: initial; display: block; width: 100%; box-sizing: border-box;';
    const root = host.attachShadow({ mode: 'open' });
    const style = document.createElement('style');
    style.textContent = SHADOW_STYLES;
    root.appendChild(style);
    return { host, root };
  }

  /** Строит и встраивает панель аналитики в интерфейс WB (под блоком цены). */
  async function renderProductPanel(product) {
    // Удаляем старую панель, если была (SPA-перерисовка)
    const oldHost = document.querySelector('.wba-panel-host');
    if (oldHost) oldHost.remove();

    const { host, root } = createPanelHost();

    const panel = document.createElement('div');
    panel.className = 'wba-panel';
    panel.innerHTML = `
      <div class="wba-panel__header">
        <span class="wba-panel__title">WB Analytics</span>
        <button class="wba-panel__close" title="Закрыть">✕</button>
      </div>
      <div class="wba-row">
        <span class="wba-row__label">Артикул</span>
        <span class="wba-row__value" data-field="nmId">${product.nmId || '—'}</span>
      </div>
      <div class="wba-row">
        <span class="wba-row__label">Цена</span>
        <span class="wba-row__value" data-field="price">${fmtMoney(product.price)}</span>
      </div>
      <div class="wba-row">
        <span class="wba-row__label">Цена до скидки</span>
        <span class="wba-row__value" data-field="priceBefore">${fmtMoney(product.priceBefore)}</span>
      </div>
      <div class="wba-row">
        <span class="wba-row__label">Рейтинг</span>
        <span class="wba-row__value" data-field="rating">${product.rating ? fmtNum(product.rating) + ' ★' : '—'}</span>
      </div>
      <div class="wba-row">
        <span class="wba-row__label">Отзывов</span>
        <span class="wba-row__value" data-field="reviewsCount">${product.reviewsCount ? fmtNum(product.reviewsCount) : '—'}</span>
      </div>
      <div class="wba-row">
        <span class="wba-row__label">Продавец</span>
        <span class="wba-row__value" data-field="seller">${product.seller || '—'}</span>
      </div>
      <div class="wba-row">
        <span class="wba-row__label">Скорость продаж</span>
        <span class="wba-row__value" data-speed>—</span>
      </div>
      <div class="wba-row">
        <span class="wba-row__label">Выручка/день</span>
        <span class="wba-row__value" data-revenue>—</span>
      </div>
      <div class="wba-row">
        <span class="wba-row__label">Прогноз/месяц</span>
        <span class="wba-row__value" data-forecast>—</span>
      </div>
      <div class="wba-chart-wrap">
        <canvas class="wba-chart"></canvas>
      </div>
      <button class="wba-btn" data-track-btn>Отслеживать</button>
    `;
    root.appendChild(panel);

    // Кнопка закрытия убирает host из DOM WB
    panel.querySelector('.wba-panel__close').addEventListener('click', () => host.remove());

    // Встраиваем host в интерфейс WB
    const point = findInsertionPoint();
    if (point) {
      if (point.ref && point.ref.parentElement === point.parent) {
        point.parent.insertBefore(host, point.ref);
      } else {
        point.parent.appendChild(host);
      }
    } else {
      // Фолбэк: если не нашли место — добавляем в конец правой колонки/body.
      document.body.appendChild(host);
    }

    // Заполняем метрики из backend (асинхронно)
    fillPanelMetrics(panel, product);

    // Если какие-то поля ещё «—» (WB догружает их позже) — держим панель
    // «живой»: обновляем значения, как только рейтинг/отзывы/продавец
    // появятся в DOM WB (до ~40 секунд).
    if (!product.rating || !product.reviewsCount || !product.seller) {
      watchProductFill(product.nmId, 40000);
    }

    // Кнопка «Отслеживать» — сохраняем nmId в chrome.storage.local
    setupTrackButton(panel.querySelector('[data-track-btn]'), product.nmId);

    return panel;
  }

  /** Запрашивает метрики у backend и подставляет их в панель + график. */
  async function fillPanelMetrics(panel, product) {
    const res = await getMetrics(product.nmId);
    const metrics = res && res.ok ? res.metrics : null;

    const speedEl = panel.querySelector('[data-speed]');
    const revenueEl = panel.querySelector('[data-revenue]');
    const forecastEl = panel.querySelector('[data-forecast]');

    if (!metrics) {
      // Backend недоступен или ещё не сохранил товар
      if (speedEl) speedEl.textContent = 'нет данных';
      if (revenueEl) revenueEl.textContent = 'нет данных';
      if (forecastEl) forecastEl.textContent = 'нет данных';
      return;
    }

    // История цен для графика всегда есть (хотя бы 1 точка за текущий визит)
    const history = metrics.priceHistory || [];

    // Скорость продаж считает backend по приросту отзывов между визитами
    // (WB не показывает остаток). Пока 2-го замера нет — просим зайти ещё раз.
    const speed = Number(metrics.salesSpeed) || 0;
    if (speedEl) {
      speedEl.textContent =
        speed > 0 ? fmtNum(speed) + ' / день' : 'зайдите на товар ещё раз позже';
    }
    if (revenueEl) {
      revenueEl.textContent =
        speed > 0 ? fmtMoney(metrics.revenuePerDay) : 'нужен 2-й визит';
    }
    if (forecastEl) {
      forecastEl.textContent =
        speed > 0 ? fmtMoney(metrics.revenuePerMonth) : 'нужен 2-й визит';
    }

    if (history.length >= 2) {
      drawPriceChart(panel, history);
    } else {
      const wrap = panel.querySelector('.wba-chart-wrap');
      if (wrap) wrap.style.display = 'none';
    }
  }

  /**
   * Обновляет значения в уже отрисованной панели БЕЗ пересоздания
   * (чтобы не мигало). Меняем только те ячейки, где сейчас «—», а новые
   * данные непустые. Нужно потому, что WB подгружает рейтинг/отзывы/
   * продавца чуть позже первой отрисовки панели.
   */
  function updatePanelValues(panel, product) {
    if (!panel || !product) return;
    const set = (field, text) => {
      const el = panel.querySelector('[data-field="' + field + '"]');
      if (el && text && el.textContent !== text && el.textContent === '—') {
        el.textContent = text;
      }
    };
    set('nmId', product.nmId ? String(product.nmId) : '');
    set('price', product.price ? fmtMoney(product.price) : '');
    set('priceBefore', product.priceBefore ? fmtMoney(product.priceBefore) : '');
    set('rating', product.rating ? fmtNum(product.rating) + ' ★' : '');
    set('reviewsCount', product.reviewsCount ? fmtNum(product.reviewsCount) : '');
    set('seller', product.seller ? product.seller : '');
  }

  /** Находит живую (текущую) панель внутри её shadow-root. */
  function getLivePanel() {
    const host = document.querySelector('.wba-panel-host');
    if (!host || !document.contains(host)) return null;
    const root = host.shadowRoot;
    return root ? root.querySelector('.wba-panel') : null;
  }

  /**
   * Держит панель «живой»: WB догружает рейтинг/отзывы/продавца позже
   * первой отрисовки. Два механизма:
   *  - MutationObserver — реагирует в момент изменения DOM WB;
   *  - интервал-поллинг — страховка на случай, когда мутации не триггерят.
   * Оба находят панель ЗАНОВО (ссылка не устаревает) и работают до 40с,
   * либо пока ключевые поля не заполнятся.
   */
  function watchProductFill(nmId, maxMs) {
    const start = Date.now();
    let stopped = false;

    const refresh = async () => {
      if (stopped) return;
      const panel = getLivePanel();
      if (!panel) return;
      const p = await parseProduct();
      if (!p) return;
      updatePanelValues(panel, p);
      const filled = p.rating && p.reviewsCount && p.seller;
      if (filled) {
        stop();
      } else if (Date.now() - start > maxMs) {
        stop();
      }
    };

    const stop = () => {
      if (stopped) return;
      stopped = true;
      if (observer) observer.disconnect();
      if (intervalId) clearInterval(intervalId);
    };

    // 1. Поллинг каждые 1.5с — надёжная страховка.
    const intervalId = setInterval(refresh, 1500);

    // 2. MutationObserver — мгновенная реакция на появление данных в WB.
    let debounce = null;
    const observer = new MutationObserver(() => {
      if (stopped) return;
      clearTimeout(debounce);
      debounce = setTimeout(refresh, 250);
    });
    observer.observe(document.body, { childList: true, subtree: true, characterData: true });

    // Первый зонд — чуть позже старта.
    setTimeout(refresh, 800);
  }

  /** Рисует график изменения цены по истории из backend. */
  async function drawPriceChart(panel, history) {
    const canvas = panel.querySelector('.wba-chart');
    if (!canvas) return;
    if (!history || history.length < 2) {
      // Нужно минимум 2 точки, иначе график бессмысленен
      const ctx = canvas.getContext('2d');
      if (ctx) {
        ctx.fillStyle = '#94a3b8';
        ctx.font = '12px sans-serif';
        ctx.fillText('Недостаточно данных для графика', 10, 80);
      }
      return;
    }
    try {
      const Chart = await loadChartJs();
      const labels = history.map((h) =>
        new Date(h.parsed_at).toLocaleString('ru-RU', {
          day: '2-digit',
          month: '2-digit',
          hour: '2-digit',
          minute: '2-digit',
        })
      );
      const data = history.map((h) => h.price);
      new Chart(canvas, {
        type: 'line',
        data: {
          labels,
          datasets: [
            {
              label: 'Цена, ₽',
              data,
              borderColor: '#7c3aed',
              backgroundColor: 'rgba(124, 58, 237, 0.12)',
              fill: true,
              tension: 0.3,
              pointRadius: 2,
            },
          ],
        },
        options: {
          responsive: false,
          maintainAspectRatio: false,
          plugins: { legend: { display: false } },
          scales: {
            x: { ticks: { maxTicksLimit: 4, font: { size: 9 } } },
            y: { ticks: { font: { size: 9 } } },
          },
        },
      });
    } catch (e) {
      log('Chart.js ошибка:', e.message);
    }
  }

  /** Вешает обработчик «Отслеживать»: пишет nmId в chrome.storage.local. */
  function setupTrackButton(btn, nmId) {
    if (!btn) return;
    const KEY = 'wba_tracked';
    // Читаем текущее состояние, чтобы сразу показать верную подпись
    chrome.storage.local.get([KEY], (res) => {
      const tracked = (res[KEY] || []).includes(nmId);
      btn.textContent = tracked ? '✓ Отслеживается' : 'Отслеживать';
      btn.classList.toggle('wba-btn--tracked', tracked);
    });

    btn.addEventListener('click', () => {
      chrome.storage.local.get([KEY], (res) => {
        let list = res[KEY] || [];
        const idx = list.indexOf(nmId);
        if (idx >= 0) {
          list.splice(idx, 1);
          btn.textContent = 'Отслеживать';
          btn.classList.remove('wba-btn--tracked');
          showToast('Убрано из отслеживания');
        } else {
          list.push(nmId);
          btn.textContent = '✓ Отслеживается';
          btn.classList.add('wba-btn--tracked');
          showToast('Товар отслеживается');
        }
        chrome.storage.local.set({ [KEY]: list });
      });
    });
  }

  /** ─────────── Инициализация и запуск ─────────── */

  /** Флаг, чтобы не запускать сценарий карточки несколько раз одновременно. */
  let detailInProgress = false;

  /** Основной сценарий для страницы карточки. */
  async function initDetailPage() {
    try {
      // Ждём, пока WB отрендерит карточку. На текущей вёрстке нет <h1>,
      // поэтому ориентируемся на цену/блок покупки (появляются раньше всего).
      await waitFor(
        'ins[class*="price"], [class*="product-page"], [class*="order"], [class*="address-rate-mini"]',
        8000
      );

      const product = await parseProduct();
      if (!product || !product.nmId) {
        log('не удалось распарсить товар');
        return;
      }
      currentProduct = product;

      // Отправляем на backend (он посчитает метрики и вернёт их)
      try {
        await reportProduct(product);
      } catch (e) {
        log('reportProduct:', e.message);
      }

      // Рисуем панель
      await renderProductPanel(product);
    } catch (e) {
      log('initDetailPage ошибка:', e && e.message ? e.message : e);
    }
  }

  /** Обёртка initDetailPage с защитой от параллельных запусков. */
  function initDetailPageOnce() {
    if (detailInProgress) return;
    detailInProgress = true;
    initDetailPage().finally(() => {
      detailInProgress = false;
    });
  }

  /** Основной сценарий для страницы поиска. */
  async function initSearchPage() {
    // Ждём появления карточек выдачи
    await waitFor(
      '.product-card__wrapper, [class*="product-card"], .j-card-item',
      10000
    );
    await decorateSearchPage();
  }

  /**
   * Наблюдает за изменениями DOM, чтобы перерисовывать UI при
   * SPA-навигации WB (бесконечный скролл, смена фильтров).
   */
  function observeDomChanges() {
    const observer = new MutationObserver(() => {
      clearTimeout(mutationDebounce);
      mutationDebounce = setTimeout(() => {
        detectPageType();
        if (isDetailPage && !document.querySelector('.wba-panel-host')) {
          initDetailPageOnce();
        } else if (isSearchPage) {
          decorateSearchPage();
        }
      }, 1500);
    });
    observer.observe(document.body, { childList: true, subtree: true });
  }

  /** Точка входа content script. */
  function main() {
    detectPageType();
    if (isDetailPage) {
      initDetailPageOnce();
    } else if (isSearchPage) {
      initSearchPage();
    }
    observeDomChanges();
  }

  // Запускаем после загрузки DOM
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', main);
  } else {
    main();
  }
})();
