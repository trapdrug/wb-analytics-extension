/**
 * Wildberries Analytics — сквозной (end-to-end) тест backend.
 *
 * Проверяет полный цикл без обращения к реальному WB:
 *   1. health-эндпоинт отвечает;
 *   2. POST /api/product сохраняет товар и возвращает метрики;
 *   3. Скорость продаж считается по разнице остатков между парсингами;
 *   4. Выручка день/неделя/месяц = цена * скорость;
 *   5. История цен возвращается;
 *   6. Список последних и топ работают.
 *
 * Запуск:  node e2e_test.js    (сервер поднимается сам на свободном порту)
 */

'use strict';

const { spawn } = require('child_process');
const path = require('path');
const fs = require('fs');
const os = require('os');

/** Временный файл БД, чтобы не трогать боевые данные. */
const TEST_DB = path.join(os.tmpdir(), 'wba_e2e_' + Date.now() + '.sqlite');

/** Свободный порт, чтобы не конфликтовать с запущенным сервером. */
const PORT = String(4100 + Math.floor(Math.random() * 500));
const BASE = 'http://127.0.0.1:' + PORT;

/** Счётчики результата. */
let passed = 0;
let failed = 0;

/** Проверка утверждения. */
function assert(cond, name) {
  if (cond) {
    passed++;
    console.log('  ✓ ' + name);
  } else {
    failed++;
    console.log('  ✗ FAIL: ' + name);
  }
}

/** Небольшая задержка. */
function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

/** Ждёт, пока сервер начнёт отвечать на /api/health. */
async function waitForServer(timeoutMs) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    try {
      const r = await fetch(BASE + '/api/health');
      if (r.ok) return true;
    } catch (e) {
      // ещё не поднялся — ждём
    }
    await sleep(200);
  }
  return false;
}

/** Основная логика теста. */
async function main() {
  console.log('Запуск тестового backend на порту ' + PORT + '...');

  // Поднимаем сервер дочерним процессом с тестовой БД и портом.
  const child = spawn(process.execPath, [path.join(__dirname, 'server.js')], {
    env: Object.assign({}, process.env, { WB_DB_PATH: TEST_DB, PORT }),
    stdio: 'ignore',
  });

  try {
    const up = await waitForServer(8000);
    assert(up, 'backend запустился и отвечает на /api/health');

    // Два парсинга одного товара с разными остатками (через 1 день)
    const now = Date.now();
    const day = 86400000;
    const p1 = {
      nmId: 777001, name: 'Тестовый товар', price: 1000, priceBefore: 1200,
      rating: 4.7, reviewsCount: 42, seller: 'Тест-селлер', category: 'Тест',
      remaining: 200, parsedAt: now - day,
    };
    const p2 = Object.assign({}, p1, { remaining: 170, parsedAt: now });

    // POST первого парсинга
    let r = await fetch(BASE + '/api/product', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(p1),
    });
    let j = await r.json();
    assert(r.status === 200 && j.ok === true, 'POST /api/product (1-й) вернул ok');

    // POST второго парсинга
    r = await fetch(BASE + '/api/product', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(p2),
    });
    j = await r.json();
    const m = j.metrics || {};
    assert(j.ok === true, 'POST /api/product (2-й) вернул ok');
    assert(Math.abs(m.salesSpeed - 30) < 0.001, 'скорость продаж = 30 шт/день (было 200, стало 170)');
    assert(Math.abs(m.revenuePerDay - 30000) < 1, 'выручка/день = 30000 (1000 * 30)');
    assert(Math.abs(m.revenuePerWeek - 210000) < 1, 'выручка/неделю = 210000');
    assert(Math.abs(m.revenuePerMonth - 900000) < 1, 'выручка/месяц = 900000');
    assert(Array.isArray(m.priceHistory) && m.priceHistory.length === 2, 'история цен содержит 2 точки');

    // GET метрик
    r = await fetch(BASE + '/api/metrics/777001');
    j = await r.json();
    assert(r.status === 200 && j.ok && j.metrics, 'GET /api/metrics/:nmId работает');

    // GET метрик несуществующего товара → 404
    r = await fetch(BASE + '/api/metrics/999999999');
    assert(r.status === 404, 'GET /api/metrics/несуществующий → 404');

    // GET последних
    r = await fetch(BASE + '/api/products?limit=10');
    j = await r.json();
    assert(r.status === 200 && Array.isArray(j.products) && j.products.length >= 1, 'GET /api/products работает');

    // GET топа
    r = await fetch(BASE + '/api/top');
    j = await r.json();
    assert(r.status === 200 && Array.isArray(j.top) && j.top.length >= 1, 'GET /api/top работает');
    assert(j.top[0].nm_id === 777001, 'товар попал в топ');

    // Валидация: POST без nmId → 400
    r = await fetch(BASE + '/api/product', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ price: 100 }),
    });
    assert(r.status === 400, 'POST без nmId → 400');
  } catch (e) {
    failed++;
    console.log('  ✗ исключение: ' + e.message);
  } finally {
    child.kill();
  }

  // Итоги
  console.log('\nРезультат: ' + passed + ' прошло, ' + failed + ' упало');
  // Удаляем временную БД
  for (const suffix of ['', '-wal', '-shm']) {
    try { fs.unlinkSync(TEST_DB + suffix); } catch (e) {}
  }

  process.exit(failed === 0 ? 0 : 1);
}

main();

