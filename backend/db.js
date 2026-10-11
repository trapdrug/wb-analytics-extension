/**
 * Wildberries Analytics — слой работы с SQLite.
 *
 * Используется ВСТРОЕННЫЙ модуль Node.js `node:sqlite` (DatabaseSync),
 * доступен начиная с Node 22.5+. Это позволяет обойтись БЕЗ `npm install`
 * и без сборки нативного better-sqlite3, который на Windows часто ломается.
 *
 * Данные хранятся в файле backend/wb.sqlite (путь можно переопределить
 * переменной окружения WB_DB_PATH).
 */

'use strict';

const path = require('path');
const { DatabaseSync } = require('node:sqlite');

/** Путь к файлу БД. */
const DB_PATH =
  process.env.WB_DB_PATH || path.join(__dirname, 'wb.sqlite');

/** Подключение к БД (создаётся лениво в initDb). */
let db = null;

/** ─────────── Инициализация схемы ─────────── */

/**
 * Открывает БД и создаёт таблицы, если их ещё нет.
 * Таблицы:
 *  - products — одна строка на артикул (UPSERT при повторном парсинге);
 *  - snapshots — история каждого парсинга (для истории цен и скорости продаж).
 */
function initDb() {
  db = new DatabaseSync(DB_PATH);

  // WAL ускоряет чтение/запись и снижает блокировки
  db.exec('PRAGMA journal_mode = WAL;');

  db.exec(`
    CREATE TABLE IF NOT EXISTS products (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      nm_id INTEGER UNIQUE NOT NULL,
      name TEXT,
      price REAL,
      price_before REAL,
      rating REAL,
      reviews_count INTEGER,
      seller TEXT,
      category TEXT,
      parsed_at INTEGER
    );

    CREATE TABLE IF NOT EXISTS snapshots (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      nm_id INTEGER NOT NULL,
      price REAL,
      remaining INTEGER,
      reviews_count INTEGER DEFAULT 0,
      parsed_at INTEGER
    );

    CREATE INDEX IF NOT EXISTS idx_snapshots_nm ON snapshots(nm_id, parsed_at);
  `);

  // Миграция: если таблица snapshots уже была без reviews_count — добавим.
  try {
    db.exec('ALTER TABLE snapshots ADD COLUMN reviews_count INTEGER DEFAULT 0;');
  } catch (e) {
    // Колонка уже существует — игнорируем.
  }
}

/** ─────────── Подготовленные запросы ─────────── */

/** Собираем prepared statements один раз (быстрее при частых вызовах). */
let stmts = null;

function prepareStmts() {
  stmts = {
    upsertProduct: db.prepare(`
      INSERT INTO products (nm_id, name, price, price_before, rating, reviews_count, seller, category, parsed_at)
      VALUES ($nm_id, $name, $price, $price_before, $rating, $reviews_count, $seller, $category, $parsed_at)
      ON CONFLICT(nm_id) DO UPDATE SET
        name = excluded.name,
        price = excluded.price,
        price_before = excluded.price_before,
        rating = excluded.rating,
        reviews_count = excluded.reviews_count,
        seller = excluded.seller,
        category = excluded.category,
        parsed_at = excluded.parsed_at
    `),
    insertSnapshot: db.prepare(`
      INSERT INTO snapshots (nm_id, price, remaining, reviews_count, parsed_at)
      VALUES ($nm_id, $price, $remaining, $reviews_count, $parsed_at)
    `),
    getProduct: db.prepare(`SELECT * FROM products WHERE nm_id = $nm_id`),
    getSnapshots: db.prepare(`
      SELECT price, remaining, reviews_count, parsed_at FROM snapshots
      WHERE nm_id = $nm_id ORDER BY parsed_at ASC
    `),
    getRecent: db.prepare(`
      SELECT * FROM products ORDER BY parsed_at DESC LIMIT $limit
    `),
  };
}

// ─────────── Инициализация при импорте ───────────
initDb();
prepareStmts();

/** ─────────── Сохранение данных ─────────── */

/**
 * Сохраняет спарсенный товар: обновляет/вставляет запись в products
 * и добавляет снапшот в snapshots. Затем пересчитывает метрики.
 *
 * @param {object} product — нормализованный товар из content script
 * @returns {object} пересчитанные метрики (см. getMetrics)
 */
function saveProduct(product) {
  const now = product.parsedAt ? Number(product.parsedAt) : Date.now();

  stmts.upsertProduct.run({
    $nm_id: product.nmId,
    $name: product.name || '',
    $price: product.price || 0,
    $price_before: product.priceBefore || 0,
    $rating: product.rating || 0,
    $reviews_count: product.reviewsCount || 0,
    $seller: product.seller || '',
    $category: product.category || '',
    $parsed_at: now,
  });

  stmts.insertSnapshot.run({
    $nm_id: product.nmId,
    $price: product.price || 0,
    $remaining: product.remaining || 0,
    $reviews_count: product.reviewsCount || 0,
    $parsed_at: now,
  });

  return getMetrics(product.nmId);
}

/** ─────────── Метрики ─────────── */

/**
 * Считает производные метрики по артикулу на основе истории снапшотов.
 *
 * Скорость продаж (salesSpeed, шт/день). WB НЕ показывает остаток на
 * карточке, поэтому считать по уменьшению остатка нельзя. Вместо этого
 * оцениваем продажи по ПРИРОСТУ ОТЗЫВОВ между визитами:
 *   новые отзывы за период ≈ заказы за период.
 * На WB в среднем ~1 отзыв на REVIEWS_PER_ORDER заказов (коэффициент
 * можно подстроить). salesSpeed = (Δотзывы / REVIEWS_PER_ORDER) / Δдней.
 *
 * Если вдруг появятся остатки (remaining>0) — используем их как более
 * точный источник.
 *
 * Выручка:
 *   revenuePerDay   = текущая цена * salesSpeed;
 *   revenuePerWeek  = revenuePerDay * 7;
 *   revenuePerMonth = revenuePerDay * 30.
 *
 * @param {number} nmId
 * @returns {object|null} метрики или null, если товара нет.
 */

/** Среднее число заказов на 1 отзыв на WB (эмпирика ~15). */
const REVIEWS_PER_ORDER = 15;

/** Минимальная разница во времени между снимками для расчёта (часы). */
const MIN_HOURS = 0.5;

function getMetrics(nmId) {
  const product = stmts.getProduct.get({ $nm_id: nmId });
  if (!product) return null;

  const snapshots = stmts.getSnapshots.all({ $nm_id: nmId });
  const priceHistory = snapshots.map((s) => ({
    price: s.price,
    parsed_at: s.parsed_at,
  }));

  let salesSpeed = 0;
  let method = 'none';

  // Приоритет 1: по остаткам (если WB когда-нибудь начнёт их отдавать).
  const withStock = snapshots.filter((s) => s.remaining > 0);
  if (withStock.length >= 2) {
    const prev = withStock[withStock.length - 2];
    const curr = withStock[withStock.length - 1];
    const dRemaining = prev.remaining - curr.remaining;
    const dDays = (curr.parsed_at - prev.parsed_at) / (1000 * 60 * 60 * 24);
    if (dDays > 0 && dRemaining > 0) {
      salesSpeed = dRemaining / dDays;
      method = 'stock';
    }
  }

  // Приоритет 2: по приросту отзывов между визитами.
  if (method === 'none') {
    const withReviews = snapshots.filter((s) => (s.reviews_count || 0) > 0);
    if (withReviews.length >= 2) {
      // Берём первую и последнюю точки с отзывами — период длиннее = точнее.
      const prev = withReviews[0];
      const curr = withReviews[withReviews.length - 1];
      const dReviews = (curr.reviews_count || 0) - (prev.reviews_count || 0);
      const dHours = (curr.parsed_at - prev.parsed_at) / (1000 * 60 * 60);
      if (dHours >= MIN_HOURS && dReviews > 0) {
        const dDays = dHours / 24;
        // Новые отзывы -> оценка заказов -> в день.
        salesSpeed = dReviews / REVIEWS_PER_ORDER / dDays;
        method = 'reviews';
      }
    }
  }

  const price = product.price || 0;
  const revenuePerDay = price * salesSpeed;

  return {
    nmId,
    salesSpeed,
    method,
    revenuePerDay,
    revenuePerWeek: revenuePerDay * 7,
    revenuePerMonth: revenuePerDay * 30,
    priceHistory,
  };
}

/** ─────────── Чтение списков ─────────── */

/** Последние спарсенные товары (для popup). */
function getRecentProducts(limit) {
  return stmts.getRecent.all({ $limit: limit || 50 });
}

/**
 * Топ товаров по выручке в день (скорость продаж * цена).
 * Для MVP объём данных небольшой, перебор всех товаров допустим.
 */
function getTopProducts(limit) {
  const rows = stmts.getRecent.all({ $limit: 1000 }); // все товары
  const enriched = rows
    .map((row) => {
      const m = getMetrics(row.nm_id);
      return {
        nm_id: row.nm_id,
        name: row.name,
        price: row.price,
        salesSpeed: m ? m.salesSpeed : 0,
        revenuePerDay: m ? m.revenuePerDay : 0,
      };
    })
    .sort((a, b) => b.revenuePerDay - a.revenuePerDay);
  return enriched.slice(0, limit || 5);
}

// ─────────── Экспорт ───────────

module.exports = {
  db,
  DB_PATH,
  initDb,
  saveProduct,
  getMetrics,
  getRecentProducts,
  getTopProducts,
};

