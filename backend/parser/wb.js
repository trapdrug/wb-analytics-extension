/**
 * Wildberries Analytics — модуль запросов к внутренним API WB.
 *
 * ПРИМЕЧАНИЕ О ЮРИДИКЕ:
 * Использование недокументированных (внутренних) эндпоинтов Wildberries
 * нарушает их Пользовательское соглашение (ToS). Данный код предоставлен
 * в образовательных целях; ответственность за использование лежит на вас.
 * См. README.md — раздел «Дисклеймер».
 *
 * Этот модуль используется БЭКЕНДОМ (не расширением напрямую): он умеет
 * дозапросить данные карточки/поиска у WB, если content script не смог
 * вытащить их из window.__INITIAL_STATE__ или DOM.
 */

'use strict';

/** ─────────── Утилиты сети ─────────── */

/** Случайный элемент массива. */
function pick(arr) {
  return arr[Math.floor(Math.random() * arr.length)];
}

/** Задержка на N мс. */
function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Пул User-Agent для ротации. */
const USER_AGENTS = [
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/123.0.0.0 Safari/537.36',
  'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36',
];

/** Рефереры, среди которых выбираем (выглядит как переход с WB). */
const REFERERS = [
  'https://www.wildberries.ru/',
  'https://www.wildberries.ru/catalog/0/search.aspx?search=',
];

/** Заголовки с ротацией User-Agent и Referer. */
function buildHeaders(extra) {
  return Object.assign(
    {
      'User-Agent': pick(USER_AGENTS),
      Referer: pick(REFERERS),
      Accept: 'application/json, text/plain, */*',
      'Accept-Language': 'ru-RU,ru;q=0.9,en;q=0.8',
    },
    extra || {}
  );
}

/** ─────────── Параметры повторов ─────────── */

const MAX_RETRIES = 4; // число повторов при 429/403/5xx
const BACKOFF_BASE_MS = 1000; // базовая задержка backoff (удваивается)
const BACKOFF_MAX_MS = 20000; // максимум задержки

/**
 * Выполняет fetch с экспоненциальным backoff при 429/403/5xx.
 * Возвращает { ok, status, data } (data — распарсенный JSON или текст).
 */
async function fetchWithRetry(url, options) {
  let attempt = 0;

  while (attempt <= MAX_RETRIES) {
    let res;
    try {
      res = await fetch(url, { ...options, headers: buildHeaders(options && options.headers) });
    } catch (e) {
      // Сетевая ошибка — можно повторить
      if (attempt < MAX_RETRIES) {
        await sleep(BACKOFF_BASE_MS * Math.pow(2, attempt));
        attempt++;
        continue;
      }
      return { ok: false, status: 0, error: e.message };
    }

    if (res.ok) {
      const text = await res.text();
      try {
        return { ok: true, status: res.status, data: JSON.parse(text) };
      } catch (e) {
        return { ok: true, status: res.status, data: text };
      }
    }

    if (res.status === 429 || res.status === 403 || res.status >= 500) {
      const retryAfter = res.headers.get('Retry-After');
      let delay = BACKOFF_BASE_MS * Math.pow(2, attempt);
      if (retryAfter) {
        const ra = parseInt(retryAfter, 10);
        if (!Number.isNaN(ra)) delay = Math.max(delay, ra * 1000);
      }
      delay = Math.min(delay, BACKOFF_MAX_MS);
      if (attempt < MAX_RETRIES) {
        await sleep(delay);
        attempt++;
        continue;
      }
      return { ok: false, status: res.status, error: 'лимит запросов после повторов' };
    }

    return { ok: false, status: res.status, error: 'HTTP ' + res.status };
  }

  return { ok: false, status: 0, error: 'исчерпаны повторы' };
}

/** ─────────── Публичные запросы ─────────── */

/**
 * Запрашивает карточку товара у внутреннего API WB.
 * URL: https://card.wb.ru/cards/v1/detail?appType=1&curr=rub&dest=...&nm={nmId}
 */
function fetchCard(nmId) {
  const url =
    'https://card.wb.ru/cards/v1/detail?appType=1&curr=rub&dest=-1257786&nm=' +
    encodeURIComponent(nmId);
  return fetchWithRetry(url);
}

/**
 * Запрашивает выдачу поиска у внутреннего API WB.
 * URL: https://search.wb.ru/exactmatch/ru/common/v4/search?query={q}&resultset=catalog
 */
function fetchSearch(query) {
  const url =
    'https://search.wb.ru/exactmatch/ru/common/v4/search?query=' +
    encodeURIComponent(query) +
    '&resultset=catalog&dest=-1257786';
  return fetchWithRetry(url);
}

/**
 * Нормализует ответ карточки WB к нашему виду товара.
 * WB отдаёт цены в копейках (priceU) — переводим в рубли.
 */
function normalizeCard(json, nmId) {
  if (!json) return null;
  const p =
    (json.data && json.data.products && json.data.products[0]) ||
    (json.products && json.products[0]) ||
    (json.data && json.data.product) ||
    json.product ||
    null;
  if (!p) return null;

  const priceU = p.priceU ?? p.salePriceU ?? p.sale ?? 0;
  const price = priceU > 5000 ? Math.round(priceU / 100) : priceU;
  const priceBeforeU = p.basePriceU ?? p.price_before ?? 0;
  const priceBefore = priceBeforeU > 5000 ? Math.round(priceBeforeU / 100) : priceBeforeU;

  return {
    nmId: p.nmId ?? p.id ?? nmId ?? 0,
    imtId: p.imtId ?? 0,
    name: p.name ?? p.title ?? '',
    price: price || 0,
    priceBefore: priceBefore || 0,
    rating: p.rating ?? p.reviewRating ?? 0,
    reviewsCount: p.reviewsCount ?? p.feedbacks ?? 0,
    seller: p.seller ?? p.brand ?? p.supplierName ?? '',
    remaining: p.volume ?? p.totalQuantity ?? 0,
    category: p.subject ?? p.entity ?? '',
    parsedAt: Date.now(),
  };
}

// ─────────── Экспорт ───────────

module.exports = {
  fetchCard,
  fetchSearch,
  normalizeCard,
  fetchWithRetry, // экспортируем для тестируемости
};

