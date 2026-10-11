/**
 * Wildberries Analytics — логика всплывающего окна (popup).
 *
 * Показывает:
 *  - список последних спарсенных товаров (GET /api/products через background);
 *  - топ-5 по скорости продаж (GET /api/top через background);
 *  - кнопку «Обновить сейчас», которая перезапрашивает данные.
 *
 * Данные получаем через background service worker, т.к. прямой fetch
 * из popup ограничен CORS, а у воркера с host_permissions — нет.
 */

'use strict';

// Ссылки на элементы DOM
const statusEl = document.getElementById('status');
const topListEl = document.getElementById('top-list');
const recentListEl = document.getElementById('recent-list');
const topEmptyEl = document.getElementById('top-empty');
const recentEmptyEl = document.getElementById('recent-empty');
const refreshBtn = document.getElementById('refresh');

/** ─────────── Утилиты форматирования ─────────── */

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

/** Обрезает длинное название товара. */
function clip(text, max) {
  const s = String(text || '');
  return s.length > max ? s.slice(0, max - 1) + '…' : s;
}

/** ─────────── Запросы через background ─────────── */

/** Универсальная обёртка над chrome.runtime.sendMessage. */
function send(message) {
  return new Promise((resolve) => {
    try {
      chrome.runtime.sendMessage(message, (response) => {
        if (chrome.runtime.lastError) {
          return resolve({ ok: false, error: chrome.runtime.lastError.message });
        }
        resolve(response || { ok: false, error: 'пустой ответ' });
      });
    } catch (e) {
      resolve({ ok: false, error: e.message });
    }
  });
}

/** ─────────── Рендеринг ─────────── */

/** Показывает статус (или ошибку). */
function setStatus(text, isError) {
  statusEl.textContent = text;
  statusEl.classList.toggle('status--error', Boolean(isError));
}

/** Рисует топ-5 по скорости продаж. */
function renderTop(top) {
  topListEl.innerHTML = '';
  if (!top || !top.length) {
    topEmptyEl.hidden = false;
    return;
  }
  topEmptyEl.hidden = true;
  top.forEach((item, i) => {
    const li = document.createElement('li');
    li.innerHTML =
      '<span class="item-title">' + (i + 1) + '. ' + clip(item.name, 32) + '</span>' +
      '<span class="item-meta">' +
        '<span>nm ' + item.nm_id + '</span>' +
        '<span>~' + fmtMoneyShort(item.revenuePerDay) + '/день</span>' +
      '</span>';
    topListEl.appendChild(li);
  });
}

/** Рисует список последних спарсенных товаров. */
function renderRecent(products) {
  recentListEl.innerHTML = '';
  if (!products || !products.length) {
    recentEmptyEl.hidden = false;
    return;
  }
  recentEmptyEl.hidden = true;
  products.forEach((p) => {
    const li = document.createElement('li');
    li.innerHTML =
      '<span class="item-title">' + clip(p.name, 34) + '</span>' +
      '<span class="item-meta">' +
        '<span>' + fmtMoney(p.price) + '</span>' +
        '<span>★ ' + (p.rating ? p.rating : '—') + '</span>' +
        '<span>nm ' + p.nm_id + '</span>' +
      '</span>';
    recentListEl.appendChild(li);
  });
}

/** ─────────── Загрузка данных ─────────── */

/**
 * Запрашивает топ и последние товары через background и перерисовывает UI.
 * Пока идёт загрузка, кнопка «Обновить» заблокирована.
 */
async function loadData() {
  refreshBtn.disabled = true;
  setStatus('Обновляю…');

  const [recentRes, topRes] = await Promise.all([
    send({ type: 'WB_GET_RECENT', limit: 20 }),
    send({ type: 'WB_GET_TOP' }),
  ]);

  if (!recentRes.ok && !topRes.ok) {
    // Оба запроса упали — вероятно, backend не запущен
    setStatus('Backend недоступен: ' + (recentRes.error || topRes.error || 'нет связи'), true);
    renderRecent([]);
    renderTop([]);
  } else {
    setStatus('Обновлено: ' + new Date().toLocaleTimeString('ru-RU'));
    renderRecent(recentRes.ok ? recentRes.products : []);
    renderTop(topRes.ok ? topRes.top : []);
  }

  refreshBtn.disabled = false;
}

// Кнопка «Обновить сейчас»
refreshBtn.addEventListener('click', loadData);

// Кнопка «Обновить отслеживаемые товары» — просит background открыть
// отслеживаемые товары в фоновых вкладках, чтобы данные накопились без визитов.
const refreshTrackedBtn = document.getElementById('refresh-tracked');
refreshTrackedBtn.addEventListener('click', () => {
  refreshTrackedBtn.disabled = true;
  setStatus('Обновляю отслеживаемые товары в фоне…');
  send({ type: 'WB_REFRESH_TRACKED' }).then((res) => {
    refreshTrackedBtn.disabled = false;
    if (res && res.ok) {
      setStatus(
        'Запущено фоновое обновление: ' + (res.opened || 0) + ' товар(ов). Данные придут через ~30–60 сек.'
      );
    } else {
      setStatus('Не удалось запустить: ' + ((res && res.error) || 'нет ответа'), true);
    }
  });
});

// Первичная загрузка при открытии popup
loadData();
