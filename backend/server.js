/**
 * Wildberries Analytics — HTTP backend.
 *
 * Реализован на встроенном модуле Node.js `http` БЕЗ Express и прочих
 * зависимостей — установка пакетов не требуется, запуск через `node server.js`.
 *
 * Эндпоинты:
 *   POST /api/product        — сохранить спарсенный товар, вернуть метрики;
 *   GET  /api/metrics/:nmId  — метрики по артикулу (скорость/выручка/история);
 *   GET  /api/products       — последние спарсенные товары (?limit=N);
 *   GET  /api/top            — топ товаров по выручке в день;
 *   GET  /api/health         — проверка живости backend.
 *
 * CORS: разрешён доступ с wildberries.ru и с chrome-extension://, т.к.
 * запросы шлёт фоновый service worker расширения (host_permissions).
 */

'use strict';

const http = require('http');
const {
  saveProduct,
  getMetrics,
  getRecentProducts,
  getTopProducts,
} = require('./db');

/** Порт (можно переопределить через PORT). */
const PORT = Number(process.env.PORT) || 4000;

/** ─────────── Утилиты HTTP ─────────── */

/** Заголовки CORS для ответа. */
function corsHeaders(origin) {
  // Расширение обращается с origin = chrome-extension://<id>, сайт — с https://www.wildberries.ru.
  // Отвечаем разрешением на конкретный origin, если он ожидаемый; иначе — на origin WB.
  let allow = 'https://www.wildberries.ru';
  if (origin && (origin.startsWith('chrome-extension://') || origin === 'https://www.wildberries.ru')) {
    allow = origin;
  }
  return {
    'Access-Control-Allow-Origin': allow,
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
    Vary: 'Origin',
  };
}

/** Отправляет JSON-ответ. */
function sendJson(res, status, obj, origin) {
  const body = JSON.stringify(obj);
  res.writeHead(
    status,
    Object.assign(
      {
        'Content-Type': 'application/json; charset=utf-8',
        'Content-Length': Buffer.byteLength(body),
      },
      corsHeaders(origin)
    )
  );
  res.end(body);
}

/** Читает тело запроса (JSON) целиком. */
function readBody(req) {
  return new Promise((resolve, reject) => {
    let data = '';
    req.on('data', (chunk) => {
      data += chunk;
      // Защита от слишком больших тел (1 МБ хватит с запасом)
      if (data.length > 1_000_000) {
        reject(new Error('тело слишком большое'));
        req.destroy();
      }
    });
    req.on('end', () => resolve(data));
    req.on('error', reject);
  });
}

/** ─────────── Маршрутизация ─────────── */

/**
 * Разбирает путь и метод запроса, вызывает нужный обработчик.
 * Возвращает Promise, который всегда заканчивается ответом.
 */
async function route(req, res) {
  const origin = req.headers.origin;
  const url = new URL(req.url, 'http://localhost');
  const path = url.pathname.replace(/\/+$/, '') || '/';

  // Preflight CORS
  if (req.method === 'OPTIONS') {
    res.writeHead(204, corsHeaders(origin));
    return res.end();
  }

  // GET /api/health — проверка живости
  if (req.method === 'GET' && path === '/api/health') {
    return sendJson(res, 200, { ok: true, service: 'wb-analytics' }, origin);
  }

  // POST /api/product — сохранить товар, вернуть метрики
  if (req.method === 'POST' && path === '/api/product') {
    let product;
    try {
      const raw = await readBody(req);
      product = JSON.parse(raw || '{}');
    } catch (e) {
      return sendJson(res, 400, { ok: false, error: 'невалидный JSON: ' + e.message }, origin);
    }
    if (!product || !product.nmId) {
      return sendJson(res, 400, { ok: false, error: 'нет поля nmId' }, origin);
    }
    try {
      const metrics = saveProduct(product);
      return sendJson(res, 200, { ok: true, metrics }, origin);
    } catch (e) {
      return sendJson(res, 500, { ok: false, error: e.message }, origin);
    }
  }

  // GET /api/metrics/:nmId — метрики по артикулу
  const mMatch = path.match(/^\/api\/metrics\/(\d+)$/);
  if (req.method === 'GET' && mMatch) {
    const metrics = getMetrics(Number(mMatch[1]));
    if (!metrics) return sendJson(res, 404, { ok: false, error: 'товар не найден' }, origin);
    return sendJson(res, 200, { ok: true, metrics }, origin);
  }

  // GET /api/products?limit=N — последние товары
  if (req.method === 'GET' && path === '/api/products') {
    const limit = Math.min(Number(url.searchParams.get('limit')) || 50, 500);
    return sendJson(res, 200, { ok: true, products: getRecentProducts(limit) }, origin);
  }

  // GET /api/top — топ по выручке в день
  if (req.method === 'GET' && path === '/api/top') {
    return sendJson(res, 200, { ok: true, top: getTopProducts(5) }, origin);
  }

  // Неизвестный маршрут
  return sendJson(res, 404, { ok: false, error: 'не найдено: ' + path }, origin);
}

/** ─────────── Запуск сервера ─────────── */

const server = http.createServer((req, res) => {
  route(req, res).catch((err) => {
    console.error('[WBAnalytics][api] ошибка:', err);
    try {
      sendJson(res, 500, { ok: false, error: 'внутренняя ошибка сервера' }, req.headers.origin);
    } catch (_) {
      // если заголовки уже отправлены — просто логируем
    }
  });
});

// Строго localhost: сервер не должен быть доступен из локальной сети.
server.listen(PORT, '127.0.0.1', () => {
  console.log('[WBAnalytics][api] backend слушает http://127.0.0.1:' + PORT);
  console.log('[WBAnalytics][api] БД:', require('./db').DB_PATH);
});
