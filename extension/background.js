/**
 * Wildberries Analytics — background service worker (Manifest V3).
 *
 * Задачи:
 *  1. Проксировать сетевые запросы из content script (обход CORS):
 *     - WB_FETCH          — запрос к внутренним API WB (card.wb.ru, search.wb.ru);
 *     - WB_REPORT_PRODUCT — отправка товара на локальный backend (POST /api/product);
 *     - WB_GET_METRICS    — запрос метрик у backend (GET /api/metrics/:nmId);
 *     - WB_GET_RECENT     — список последних товаров (GET /api/products) для popup;
 *     - WB_GET_TOP        — топ по скорости продаж (GET /api/top) для popup.
 *  2. Throttling: не чаще 1 запроса в секунду на домен wb.ru.
 *  3. Ротация User-Agent и Referer для снижения риска блокировки.
 *  4. Экспоненциальный backoff при ответах 429/403/5xx от WB.
 *
 * Все fetch идут отсюда, потому что content script ограничен CORS,
 * а у service worker'а с host_permissions — нет.
 */

'use strict';

/** Базовый адрес локального backend (Node.js). */
const API_BASE = 'http://127.0.0.1:4000';

/** Минимальный интервал между запросами к одному домену wb.ru, мс. */
const THROTTLE_MS = 1000;

/** Максимальное число повторов при 429/403/5xx. */
const MAX_RETRIES = 5;

/** Базовая задержка backoff, мс (удваивается на каждой попытке). */
const BACKOFF_BASE_MS = 1000;

/** Максимальная задержка backoff, мс. */
const BACKOFF_MAX_MS = 30000;

/** Пул User-Agent для ротации. */
const USER_AGENTS = [
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/123.0.0.0 Safari/537.36',
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:125.0) Gecko/20100101 Firefox/125.0',
  'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36',
];

/** Рефереры, среди которых выбираем (выглядит как переход с WB). */
const REFERERS = [
  'https://www.wildberries.ru/',
  'https://www.wildberries.ru/catalog/0/search.aspx?search=',
  'https://www.wildberries.ru/',
];

/** Карта «домен -> время последнего запроса» для throttling. */
const lastRequestAt = new Map();

/** ─────────── Утилиты сети ─────────── */

/** Случайный элемент массива. */
function pick(arr) {
  return arr[Math.floor(Math.random() * arr.length)];
}

/** Задержка на N мс. */
function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Извлекает домен из URL. */
function getHost(url) {
  try {
    return new URL(url).host;
  } catch (e) {
    return 'unknown';
  }
}

/**
 * Throttling: ждём, пока с момента последнего запроса к этому хосту
 * пройдёт THROTTLE_MS. Гарантирует не чаще 1 запроса/сек на домен wb.ru.
 */
async function throttle(host) {
  const now = Date.now();
  const last = lastRequestAt.get(host) || 0;
  const wait = THROTTLE_MS - (now - last);
  if (wait > 0) await sleep(wait);
  lastRequestAt.set(host, Date.now());
}

/** Собирает заголовки с ротацией User-Agent и Referer. */
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

/**
 * Выполняет fetch с throttling, ротацией заголовков и экспоненциальным
 * backoff при 429/403/5xx. Возвращает распарсенный JSON (или текст).
 */
async function fetchWithRetry(url, options) {
  const host = getHost(url);
  let attempt = 0;

  while (attempt <= MAX_RETRIES) {
    await throttle(host);

    const res = await fetch(url, {
      ...options,
      headers: buildHeaders(options && options.headers),
    });

    // Успех — читаем тело
    if (res.ok) {
      const text = await res.text();
      try {
        return { ok: true, status: res.status, data: JSON.parse(text) };
      } catch (e) {
        return { ok: true, status: res.status, data: text };
      }
    }

    // 429 (too many requests) или 403 (forbidden) — backoff и повтор
    if (res.status === 429 || res.status === 403 || res.status >= 500) {
      // Уважаем заголовок Retry-After, если WB его прислал
      const retryAfter = res.headers.get('Retry-After');
      let delay = BACKOFF_BASE_MS * Math.pow(2, attempt); // экспонента
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

    // Прочие ошибки — не повторяем
    return { ok: false, status: res.status, error: 'HTTP ' + res.status };
  }

  return { ok: false, status: 0, error: 'исчерпаны повторы' };
}

/** ─────────── Обработчики запросов к WB ─────────── */

/**
 * Запрос к карточному API WB.
 * URL: https://card.wb.ru/cards/v1/detail?appType=1&curr=rub&dest=...&nm={nmId}
 */
async function wbFetchCard(nmId) {
  const url =
    'https://card.wb.ru/cards/v1/detail?appType=1&curr=rub&dest=-1257786&nm=' +
    encodeURIComponent(nmId);
  // Фолбэк-источник: основной запрос делает content script из main-world
  // (с её cookie/Origin). Здесь добавляем браузероподобные заголовки.
  return fetchWithRetry(url, {
    headers: {
      Origin: 'https://www.wildberries.ru',
      'sec-fetch-dest': 'empty',
      'sec-fetch-mode': 'cors',
      'sec-fetch-site': 'same-site',
    },
  });
}

/**
 * Запрос к поисковому API WB.
 * URL: https://search.wb.ru/exactmatch/ru/common/v4/search?query={q}&resultset=catalog
 */
async function wbFetchSearch(query) {
  const url =
    'https://search.wb.ru/exactmatch/ru/common/v4/search?query=' +
    encodeURIComponent(query) +
    '&resultset=catalog&dest=-1257786';
  return fetchWithRetry(url);
}

/** ─────────── Обработчики запросов к backend ─────────── */

/** POST /api/product — сохраняет товар и возвращает пересчитанные метрики. */
async function reportProduct(product) {
  try {
    const res = await fetch(API_BASE + '/api/product', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(product),
    });
    if (!res.ok) return { ok: false, status: res.status, error: 'backend HTTP ' + res.status };
    const data = await res.json();
    return { ok: true, metrics: data.metrics || null };
  } catch (e) {
    // Backend может быть не запущен — не роняем воркер
    return { ok: false, error: e.message };
  }
}

/** GET /api/metrics/:nmId — метрики по артикулу (скорость, история цен). */
async function getMetrics(nmId) {
  try {
    const res = await fetch(API_BASE + '/api/metrics/' + encodeURIComponent(nmId));
    if (!res.ok) return { ok: false, status: res.status, error: 'backend HTTP ' + res.status };
    const data = await res.json();
    return { ok: true, metrics: data.metrics || null };
  } catch (e) {
    return { ok: false, error: e.message };
  }
}

/** GET /api/products — список последних товаров (для popup). */
async function getRecentProducts(limit) {
  try {
    const res = await fetch(API_BASE + '/api/products?limit=' + (limit || 50));
    if (!res.ok) return { ok: false, status: res.status };
    const data = await res.json();
    return { ok: true, products: data.products || [] };
  } catch (e) {
    return { ok: false, error: e.message };
  }
}

/** GET /api/top — топ товаров по скорости продаж (для popup). */
async function getTopProducts() {
  try {
    const res = await fetch(API_BASE + '/api/top');
    if (!res.ok) return { ok: false, status: res.status };
    const data = await res.json();
    return { ok: true, top: data.top || [] };
  } catch (e) {
    return { ok: false, error: e.message };
  }
}

/** ─────────── Фоновое обновление отслеживаемых товаров ─────────── */

/** Ключ списка отслеживаемых nmId в chrome.storage.local. */
const TRACKED_KEY = 'wba_tracked';

/** Имя alarm'а периодического обновления. */
const REFRESH_ALARM = 'wba_refresh_tracked';

/** Период фонового обновления, минуты. */
const REFRESH_PERIOD_MIN = 60;

/** Максимум товаров за один цикл (чтобы не раздувать вкладки). */
const REFRESH_MAX_ITEMS = 10;

/** Защита от параллельных циклов обновления. */
let refreshInProgress = false;

/**
 * Фоновое обновление: открывает отслеживаемые товары в НЕактивных вкладках.
 * Content script сам распарсит актуальные отзывы/цену и отправит их backend'у,
 * после чего вкладка закрывается. Так данные накапливаются без ваших визитов.
 */
async function refreshTrackedProducts() {
  if (refreshInProgress) return { ok: false, error: 'обновление уже идёт' };
  refreshInProgress = true;
  let opened = 0;
  try {
    const res = await chrome.storage.local.get([TRACKED_KEY]);
    const list = (res[TRACKED_KEY] || []).slice(0, REFRESH_MAX_ITEMS);
    for (const nmId of list) {
      const tab = await chrome.tabs.create({
        url: 'https://www.wildberries.ru/catalog/' + nmId + '/detail.aspx',
        active: false,
      });
      opened++;
      // Даём странице время отрендериться и content script'у — отправить данные,
      // затем закрываем фоновую вкладку.
      setTimeout(() => {
        chrome.tabs.remove(tab.id).catch(() => {});
      }, 20000);
      // Пауза между товарами, чтобы не нагружать WB и backend.
      await sleep(25000);
    }
    return { ok: true, opened };
  } catch (e) {
    return { ok: false, error: e.message, opened };
  } finally {
    refreshInProgress = false;
  }
}

/** Создаёт alarm при установке/запуске браузера. */
function ensureRefreshAlarm() {
  chrome.alarms.create(REFRESH_ALARM, { periodInMinutes: REFRESH_PERIOD_MIN });
}

chrome.runtime.onInstalled.addListener(ensureRefreshAlarm);
chrome.runtime.onStartup.addListener(ensureRefreshAlarm);
chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === REFRESH_ALARM) refreshTrackedProducts();
});


/** ─────────── Маршрутизация сообщений от content script и popup ─────────── */

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (!message || !message.type) return false; // не наше сообщение

  (async () => {
    switch (message.type) {
      case 'WB_REPORT_PRODUCT':
        return await reportProduct(message.product);

      case 'WB_GET_METRICS':
        return await getMetrics(message.nmId);

      case 'WB_GET_RECENT':
        return await getRecentProducts(message.limit);

      case 'WB_GET_TOP':
        return await getTopProducts();

      case 'WB_REFRESH_TRACKED':
        return await refreshTrackedProducts();

      case 'WB_FETCH_CARD':
        return await wbFetchCard(message.nmId);

      case 'WB_FETCH_SEARCH':
        return await wbFetchSearch(message.query);

      default:
        return { ok: false, error: 'неизвестный тип сообщения: ' + message.type };
    }
  })()
    .then((result) => sendResponse(result))
    .catch((err) => sendResponse({ ok: false, error: err.message }));

  // Возвращаем true, чтобы канал сообщения оставался открытым для асинхронного ответа
  return true;
});
