/**
 * Orders Labels Service
 * Работа с этикетками заказов (кэширование PDF/PNG, статус наличия, предзагрузка).
 *
 * Логика перенесена из старого server.js в модульный сервис.
 */

import fs from 'fs';
import { join } from 'path';
import fetch from 'node-fetch';
import crypto from 'crypto';
import { readData } from '../utils/storage.js';
import config from '../config/index.js';
import ordersService from './orders.service.js';
import integrationsService from './integrations.service.js';
import { getYandexBusinessAndCampaigns, normalizeYandexApiKey } from './orders.sync.service.js';
import { getYandexHttpsAgent } from '../utils/yandex-https-agent.js';

// Используем централизованную конфигурацию путей
const DATA_DIR = config.paths.dataDir;

function ensureDir(dir) {
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
}

function getLabelsDir() {
  const dir = join(DATA_DIR, 'labels');
  ensureDir(dir);
  return dir;
}

function normalizeMarketplaceForLabel(marketplace) {
  const m = String(marketplace || '').toLowerCase();
  if (m === 'wb') return 'wildberries';
  if (m === 'ym' || m === 'yandexmarket') return 'yandex';
  return m || 'unknown';
}

/** Имя файла кэша этикетки: для Ozon одна этикетка на постинг (несколько строк в БД с ~suffix). */
function labelCacheFileId(order) {
  const mp = normalizeMarketplaceForLabel(order?.marketplace);
  if (mp === 'ozon') {
    const g = order?.orderGroupId ?? order?.order_group_id;
    if (g != null && String(g).trim() !== '') return String(g).trim();
    const oid = String(order?.orderId ?? order?.order_id ?? '').trim();
    const tilde = oid.indexOf('~');
    return tilde === -1 ? oid : oid.slice(0, tilde);
  }
  if (mp === 'yandex') {
    const g = order?.orderGroupId ?? order?.order_group_id;
    if (g != null && String(g).trim() !== '') return String(g).trim();
    const oid = String(order?.orderId ?? order?.order_id ?? '').trim();
    const colon = oid.indexOf(':');
    return colon === -1 ? oid : oid.slice(0, colon);
  }
  return String(order?.orderId ?? order?.order_id ?? '').trim();
}

function getOrderLabelPath(order) {
  const base = getLabelsDir();
  const mp = normalizeMarketplaceForLabel(order.marketplace);
  const mpDir = join(base, mp);
  ensureDir(mpDir);
  const ext = mp === 'wildberries' ? '.png' : '.pdf';
  const id = labelCacheFileId(order);
  return join(mpDir, `${id}${ext}`);
}

function hasLabelCached(order) {
  const filePath = getOrderLabelPath(order);
  return fs.existsSync(filePath);
}

function logLabelEvent(message) {
  try {
    ensureDir(DATA_DIR);
    const line = `[${new Date().toISOString()}] ${message}\n`;
    fs.appendFileSync(join(DATA_DIR, 'labels.log'), line);
  } catch (e) {
    console.warn('[Labels][log] Failed to write log:', e.message);
  }
}

function orderProfileId(order) {
  const raw = order?.profileId ?? order?.profile_id ?? null;
  if (raw == null || raw === '') return null;
  const n = Number(raw);
  return Number.isFinite(n) ? n : String(raw);
}

function normalizeOrgId(value) {
  if (value == null || value === '') return null;
  const s = String(value).trim();
  if (!s) return null;
  const n = Number(s);
  return Number.isFinite(n) && n > 0 ? String(Math.trunc(n)) : s;
}

function keyFp(raw) {
  try {
    const s = String(raw || '').trim();
    if (!s) return '';
    // md5 удобнее сравнивать с PostgreSQL: md5(config->>'api_key')
    return crypto.createHash('md5').update(s).digest('hex').slice(0, 10);
  } catch {
    return '';
  }
}

class OrdersLabelsService {
  /**
   * Получить путь к этикетке заказа, при необходимости скачав её.
   * Возвращает абсолютный путь к файлу.
   */
  async ensureLabelFile(order, { organizationId = null } = {}) {
    const filePath = getOrderLabelPath(order);

    if (!fs.existsSync(filePath)) {
      try {
        const out = await fetchMarketplaceLabel(order, { organizationId });
        const buf = out && Buffer.isBuffer(out.buffer) ? out.buffer : (Buffer.isBuffer(out) ? out : null);
        const stickerNumber = out && typeof out === 'object' ? (out.stickerNumber ?? out.sticker_id ?? null) : null;
        if (!buf || !Buffer.isBuffer(buf) || buf.length === 0) {
          const error = new Error('Label not found');
          error.statusCode = 404;
          throw error;
        }
        fs.writeFileSync(filePath, buf);
        const writtenSize = fs.statSync(filePath).size;
        if (writtenSize === 0) {
          try { fs.unlinkSync(filePath); } catch (_) {}
          throw new Error('Этикетка от маркетплейса пуста');
        }
        const org = normalizeOrgId(organizationId);
        logLabelEvent(`Cached(on-demand) ${order.marketplace}:${order.orderId}${org ? ` org=${org}` : ''}`);
        // Сохраняем номер стикера (если маркетплейс его возвращает вместе с этикеткой)
        try {
          if (stickerNumber != null && String(stickerNumber).trim() !== '') {
            const profileId = order?.profileId ?? order?.profile_id ?? null;
            await ordersService.setAssemblyStickerNumber(order.marketplace, order.orderId, stickerNumber, profileId);
          }
        } catch {
          /* ignore */
        }
      } catch (e) {
        const err = new Error(e.statusCode ? e.message : `Label fetch failed: ${e.message}`);
        err.statusCode = e.statusCode || 502;
        throw err;
      }
    }

    const size = fs.statSync(filePath).size;
    if (size === 0) {
      try { fs.unlinkSync(filePath); } catch (_) {}
      const err = new Error('Этикетка не загружена');
      err.statusCode = 502;
      throw err;
    }
    return filePath;
  }

  async getLabelStatus(order, { organizationId = null } = {}) {
    const filePath = getOrderLabelPath(order);
    const exists = fs.existsSync(filePath);

    if (!exists) {
      // Качаем в фоне, ответ не ждёт. Для WB возможны 409 (этикетка ещё не готова) и 429 (rate limit).
      // Делаем несколько попыток с бэкоффом, чтобы «На сборке» почти всегда прогревало этикетку.
      setTimeout(async () => {
        const mp = normalizeMarketplaceForLabel(order?.marketplace);
        const isWB = mp === 'wildberries';
        const maxAttempts = isWB ? 4 : 1;
        const org = normalizeOrgId(organizationId);
        for (let attempt = 1; attempt <= maxAttempts; attempt++) {
          try {
            const out = await fetchMarketplaceLabel(order, { organizationId });
            const buf = out && Buffer.isBuffer(out.buffer) ? out.buffer : (Buffer.isBuffer(out) ? out : null);
            const stickerNumber = out && typeof out === 'object' ? (out.stickerNumber ?? out.sticker_id ?? null) : null;
            if (buf && Buffer.isBuffer(buf) && buf.length > 0) {
              fs.writeFileSync(filePath, buf);
              logLabelEvent(`Cached(status) ${order.marketplace}:${order.orderId}${org ? ` org=${org}` : ''} attempt=${attempt}`);
            }
            try {
              if (stickerNumber != null && String(stickerNumber).trim() !== '') {
                const profileId = order?.profileId ?? order?.profile_id ?? null;
                await ordersService.setAssemblyStickerNumber(order.marketplace, order.orderId, stickerNumber, profileId);
              }
            } catch {
              /* ignore */
            }
            return;
          } catch (e) {
            const status = e?.statusCode;
            logLabelEvent(
              `Error(status) ${order.marketplace}:${order.orderId}${org ? ` org=${org}` : ''} attempt=${attempt}/${maxAttempts} status=${status || ''} -> ${e?.message || String(e)}`
            );
            if (!isWB || attempt >= maxAttempts) return;
            // backoff: 5s, 15s, 30s (для 409/429), иначе не ретраим
            if (status !== 409 && status !== 429) return;
            const delayMs = attempt === 1 ? 5000 : attempt === 2 ? 15000 : 30000;
            await new Promise((r) => setTimeout(r, delayMs));
          }
        }
      }, 0);
    }

    return { exists };
  }

  /**
   * Предзагрузка этикеток для массива заказов.
   * По умолчанию: new, in_assembly, assembled (и accepted для совместимости).
   */
  async preloadLabels(orders, statuses = ['new', 'in_assembly', 'assembled', 'accepted'], { organizationId = null } = {}) {
    const toProcess = Array.isArray(orders)
      ? orders.filter(
          o => !hasLabelCached(o) && (!statuses || statuses.includes(o.status))
        )
      : [];

    logLabelEvent(
      `Preload start. total=${orders?.length || 0} toFetch=${toProcess.length}`
    );

    for (const order of toProcess) {
      const filePath = getOrderLabelPath(order);
      if (fs.existsSync(filePath)) continue;
      try {
        logLabelEvent(`Fetching ${order.marketplace}:${order.orderId}`);
        const buf = await fetchMarketplaceLabel(order, { organizationId });
        if (buf && Buffer.isBuffer(buf) && buf.length > 0) {
          fs.writeFileSync(filePath, buf);
          logLabelEvent(`Cached ${order.marketplace}:${order.orderId}`);
        }
      } catch (e) {
        logLabelEvent(`Error ${order.marketplace}:${order.orderId} -> ${e.message}`);
      }
    }

    logLabelEvent('Preload complete');
  }

  /**
   * Утилита: найти заказ по orderId в локальном хранилище.
   */
  async findOrderById(orderId) {
    const order = await ordersService.getByOrderId(orderId);
    if (!order) {
      const error = new Error('Order not found');
      error.statusCode = 404;
      throw error;
    }
    return order;
  }
}

// === Вспомогательные функции для загрузки этикеток с маркетплейсов ===

async function fetchMarketplaceLabel(order) {
  const mp = normalizeMarketplaceForLabel(order.marketplace);
  const ctx = arguments.length >= 2 && arguments[1] && typeof arguments[1] === 'object' ? arguments[1] : {};
  const organizationId = ctx.organizationId ?? null;
  if (mp === 'ozon') return { buffer: await fetchOzonLabel(order, { organizationId }), stickerNumber: null };
  if (mp === 'wildberries') return fetchWBLabel(order, { organizationId });
  if (mp === 'yandex') return { buffer: await fetchYMLabel(order, { organizationId }), stickerNumber: null };
  return null;
}

async function fetchOzonLabel(order, { organizationId = null } = {}) {
  try {
    const profileId = orderProfileId(order);
    let ozon = null;
    try {
      ozon = await integrationsService.getMarketplaceConfig('ozon', { profileId, organizationId });
    } catch (_) {}
    // В мульти-кабинетах нельзя падать обратно на глобальный readData('ozon'):
    // это приводит к "чужому кабинету" и 404 по стикерам.
    if ((!ozon?.client_id || !ozon?.api_key) && profileId == null) ozon = await readData('ozon');
    if (!ozon || !ozon.client_id || !ozon.api_key) {
      const err = new Error(
        'Ozon: не настроены ключи кабинета для запроса этикетки (Client-Id / Api-Key). Проверьте интеграцию Ozon для этого аккаунта.'
      );
      err.statusCode = 400;
      throw err;
    }

    const postingNumber = labelCacheFileId(order);
    if (!postingNumber) {
      logLabelEvent(`[Ozon] empty orderId`);
      throw new Error('Некорректный номер отправления');
    }

    // 1) Проверка постинга (v3/get возвращает result как объект, не массив)
    const check = await fetch('https://api-seller.ozon.ru/v3/posting/fbs/get', {
      method: 'POST',
      headers: {
        'Client-Id': String(ozon.client_id),
        'Api-Key': String(ozon.api_key),
        'Content-Type': 'application/json',
        Accept: 'application/json'
      },
      body: JSON.stringify({
        posting_number: postingNumber,
        with: { analytics_data: false, financial_data: false }
      })
    });
    if (!check.ok) {
      const text = await check.text();
      const org = normalizeOrgId(organizationId);
      const fp = keyFp(ozon.api_key);
      logLabelEvent(
        `[Ozon] get posting failed ${check.status}${org ? ` org=${org}` : ''}${fp ? ` key_fp=${fp}` : ''}: ${text.substring(0, 300)}`
      );
      const err =
        check.status === 403
          ? new Error(
              'Ozon: доступ запрещён (403) при запросе этикетки. Проверьте Client-Id/Api-Key в «Интеграции → Ozon» для этого аккаунта и права ключа.'
            )
          : new Error(`Ozon get failed ${check.status}`);
      err.statusCode = check.status;
      throw err;
    }
    const checkData = await check.json();
    const postingResult = checkData?.result;
    const found = postingResult && (Array.isArray(postingResult) ? postingResult.length > 0 : typeof postingResult === 'object');
    if (!found) {
      logLabelEvent(`[Ozon] posting not found: ${order.orderId}`);
      const err = new Error('Ozon posting not found');
      err.statusCode = 404;
      throw err;
    }

    const ozonHeaders = {
      'Client-Id': String(ozon.client_id),
      'Api-Key': String(ozon.api_key),
      'Content-Type': 'application/json',
      Accept: 'application/json'
    };

    // 2) Поток create → get (для awaiting_deliver и др.): v2/create → v1/get
    const createResp = await fetch('https://api-seller.ozon.ru/v2/posting/fbs/package-label/create', {
      method: 'POST',
      headers: ozonHeaders,
      body: JSON.stringify({ posting_number: [postingNumber] })
    });
    const createBody = await createResp.text();
    if (createResp.ok) {
      try {
        const createData = JSON.parse(createBody);
        const tasks = createData?.result?.tasks;
        if (Array.isArray(tasks) && tasks.length > 0) {
          const task = tasks.find(t => t.task_type === 'small_label') || tasks[0];
          const taskId = task?.task_id;
          if (taskId != null) {
            for (let attempt = 0; attempt < 20; attempt++) {
              if (attempt > 0) await new Promise(r => setTimeout(r, 1500));
              const getResp = await fetch('https://api-seller.ozon.ru/v1/posting/fbs/package-label/get', {
                method: 'POST',
                headers: ozonHeaders,
                body: JSON.stringify({ task_id: taskId })
              });
              const getBody = await getResp.text();
              if (!getResp.ok) {
                logLabelEvent(`[Ozon] package-label/get error ${getResp.status}: ${getBody.substring(0, 200)}`);
                break;
              }
              const getData = JSON.parse(getBody);
              const status = getData?.result?.status;
              const fileUrl = getData?.result?.file_url;
              if (status === 'completed' && fileUrl) {
                const fileResp = await fetch(fileUrl);
                if (fileResp.ok) {
                  const arr = await fileResp.arrayBuffer();
                  return Buffer.from(arr);
                }
                logLabelEvent(`[Ozon] create/get file_url download error ${fileResp.status}`);
                break;
              }
              if (status === 'failed' || status === 'error') {
                logLabelEvent(`[Ozon] create/get task failed: ${getData?.result?.error || status}`);
                break;
              }
            }
          }
        }
      } catch (e) {
        logLabelEvent(`[Ozon] create/get parse error: ${e.message}`);
      }
    } else {
      logLabelEvent(`[Ozon] package-label/create ${createResp.status}: ${createBody.substring(0, 300)}`);
      const detail = createBody.replace(/\s+/g, ' ').trim().substring(0, 300);
      const err = new Error(
        `Ozon: не удалось создать задание на этикетку (${createResp.status}). ${detail || 'Заказ должен быть в статусе «Ожидает отгрузки».'}`
      );
      err.statusCode = createResp.status;
      throw err;
    }

    const err = new Error(
      'Ozon: этикетка недоступна. Задание создано, но файл не получен в течение 30 сек. Попробуйте запросить этикетку через минуту или создайте в ЛК Ozon.'
    );
    // Это не "Bad Gateway": Ozon ещё не отдал файл, чаще всего это временно.
    err.statusCode = 409;
    throw err;
  } catch (e) {
    throw e;
  }
}

async function fetchWBLabel(order, { organizationId = null } = {}) {
  try {
    let wb = null;
    const profileIdRaw = order?.profileId ?? order?.profile_id ?? null;
    const profileId =
      profileIdRaw == null || profileIdRaw === ''
        ? null
        : (Number.isFinite(Number(profileIdRaw)) ? Number(profileIdRaw) : String(profileIdRaw));
    try {
      wb = await integrationsService.getMarketplaceConfig('wildberries', { profileId, organizationId });
    } catch (_) {}
    if (!wb?.api_key) wb = await readData('wildberries');
    if (!wb || !wb.api_key) return null;
    // WB: для большинства v3 методов корректный формат — Authorization: Bearer <token>
    // (в т.ч. /ping и часть marketplace-api). Оставляем совместимость: если уже передан Bearer — не дублируем.
    const rawToken = String(wb.api_key || '').trim();
    const tokenClean =
      typeof integrationsService?._normalizeWbToken === 'function'
        ? integrationsService._normalizeWbToken(rawToken)
        : rawToken.replace(/\s+/g, '').replace(/\uFEFF/g, '').trim();
    const authHeader = tokenClean.toLowerCase().startsWith('bearer ')
      ? tokenClean
      : `Bearer ${tokenClean}`;
    // Не фильтруем по статусу — пробуем запросить этикетку; при недоступности WB API вернёт ошибку.

    async function fetchStickersJson(url) {
      const resp = await fetch(url, {
        method: 'POST',
        headers: {
          Authorization: authHeader,
          'Content-Type': 'application/json',
          Accept: 'application/json'
        },
        body: JSON.stringify({ orders: [orderIdNum] })
      });
      const text = await resp.text();
      return { resp, text };
    }

    function extractStickerNumber(sticker) {
      if (!sticker || typeof sticker !== 'object') return null;
      const cand =
        sticker.stickerId ??
        sticker.sticker_id ??
        sticker.stickerNumber ??
        sticker.sticker_number ??
        sticker.sticker ??
        sticker.id ??
        null;
      if (cand == null) return null;
      const s = String(cand).trim();
      return s ? s : null;
    }

    // WB: по документации есть несколько контуров/моделей заказов.
    // "Классический" FBS: /api/v3/orders/stickers
    // DBW (Delivery by Wildberries courier): /api/v3/dbw/orders/stickers
    const urlFbs = 'https://marketplace-api.wildberries.ru/api/v3/orders/stickers?type=png&width=58&height=40';
    const urlDbw = 'https://marketplace-api.wildberries.ru/api/v3/dbw/orders/stickers?type=png&width=58&height=40';
    const orderIdNum = Number(order.orderId);
    if (Number.isNaN(orderIdNum)) {
      logLabelEvent(`[WB] Invalid orderId for sticker: ${order.orderId}`);
      throw new Error('Некорректный номер заказа');
    }
    let resp;
    let text;
    ({ resp, text } = await fetchStickersJson(urlFbs));

    // WB может отвечать 429 при массовых синхронизациях/ночных задачах.
    // В этом случае важно прокинуть статус, чтобы клиент не видел "502 Bad Gateway".
    if (resp.status === 429) {
      const retryAfter = resp.headers?.get?.('retry-after') || resp.headers?.get?.('Retry-After') || null;
      const hint = retryAfter ? ` Попробуйте через ${retryAfter} сек.` : ' Подождите и повторите попытку.';
      logLabelEvent(`[WB] rate limited 429${retryAfter ? ` retry-after=${retryAfter}` : ''}: ${text.substring(0, 300)}`);
      const err = new Error(`WB: слишком много запросов (429).${hint}`);
      err.statusCode = 429;
      throw err;
    }

    if (!resp.ok) {
      const org = normalizeOrgId(organizationId);
      const fp = keyFp(wb.api_key);
      logLabelEvent(
        `[WB] label error ${resp.status}${org ? ` org=${org}` : ''}${fp ? ` key_fp=${fp}` : ''}: ${text.substring(0, 300)}`
      );
      throw new Error(`WB label error ${resp.status}: ${text.substring(0, 200)}`);
    }

    let json;
    try {
      json = JSON.parse(text);
    } catch (_) {
      logLabelEvent(`[WB] stickers response not JSON: ${text.substring(0, 200)}`);
      throw new Error('WB API вернул не JSON');
    }

    const stickers = json?.stickers;
    if (!Array.isArray(stickers) || stickers.length === 0) {
      // fallback: DBW stickers endpoint
      try {
        const r2 = await fetchStickersJson(urlDbw);
        if (r2.resp.status === 429) {
          const retryAfter = r2.resp.headers?.get?.('retry-after') || r2.resp.headers?.get?.('Retry-After') || null;
          const hint = retryAfter ? ` Попробуйте через ${retryAfter} сек.` : ' Подождите и повторите попытку.';
          logLabelEvent(`[WB][DBW] rate limited 429${retryAfter ? ` retry-after=${retryAfter}` : ''}: ${r2.text.substring(0, 300)}`);
          const err = new Error(`WB: слишком много запросов (429).${hint}`);
          err.statusCode = 429;
          throw err;
        }
        if (r2.resp.ok) {
          let j2 = {};
          try { j2 = r2.text ? JSON.parse(r2.text) : {}; } catch { j2 = {}; }
          const st2 = j2?.stickers;
          if (Array.isArray(st2) && st2.length > 0) {
            const first2 = st2[0];
            const base64_2 = first2?.file;
            if (base64_2 && typeof base64_2 === 'string') {
              return { buffer: Buffer.from(base64_2, 'base64'), stickerNumber: extractStickerNumber(first2) };
            }
            logLabelEvent('[WB][DBW] sticker has no file field');
          } else {
            logLabelEvent(`[WB][DBW] no stickers: ${(j2?.message || j2?.error || '').toString().substring(0, 150)}`);
          }
        }
      } catch (e2) {
        if (e2?.statusCode === 429) throw e2;
        // ignore — ниже вернём общую 409
      }

      const msg = json?.message || json?.error || 'Нет этикеток в ответе';
      // Диагностика: часто WB возвращает пустой список, если заказ не в confirm/complete (по документации).
      // Попробуем один раз запросить статус заказа, чтобы понять supplierStatus/wbStatus.
      let statusDiag = '';
      try {
        const stResp = await fetch('https://marketplace-api.wildberries.ru/api/v3/orders/status', {
          method: 'POST',
          headers: {
            Authorization: authHeader,
            'Content-Type': 'application/json',
            Accept: 'application/json'
          },
          body: JSON.stringify({ orders: [orderIdNum] })
        });
        const stText = await stResp.text();
        if (stResp.ok) {
          let stJson = {};
          try { stJson = stText ? JSON.parse(stText) : {}; } catch { stJson = {}; }
          const list = Array.isArray(stJson?.orders) ? stJson.orders : (Array.isArray(stJson?.data) ? stJson.data : []);
          const item = Array.isArray(list) ? list.find((x) => Number(x?.id ?? x?.orderId ?? x?.order_id) === orderIdNum) : null;
          const supplierStatus = item?.supplierStatus ?? item?.supplier_status ?? item?.supplier_status_name ?? null;
          const wbStatus = item?.wbStatus ?? item?.wb_status ?? null;
          const codes = Array.isArray(item?.statuses) ? item.statuses.map((s) => s?.code).filter(Boolean) : [];
          statusDiag = ` status: supplierStatus=${supplierStatus ?? ''} wbStatus=${wbStatus ?? ''} codes=${codes.join(',')}`;
        } else {
          statusDiag = ` statusApi=${stResp.status}`;
        }
      } catch {
        /* ignore */
      }
      const diag = (() => {
        try {
          const snippet = JSON.stringify(json).substring(0, 500);
          return snippet ? ` response=${snippet}` : '';
        } catch {
          return text ? ` responseText=${String(text).substring(0, 300)}` : '';
        }
      })();
      logLabelEvent(`[WB] no stickers for order=${orderIdNum}: ${msg}${statusDiag}${diag}`);
      const err = new Error(`WB: ${msg}`);
      // 200 OK, но без stickers — это обычно "этикетка недоступна" (не 502 от нашего API).
      err.statusCode = 409;
      throw err;
    }

    const first = stickers[0];
    const base64 = first?.file;
    if (!base64 || typeof base64 !== 'string') {
      logLabelEvent(`[WB] sticker has no file field`);
      throw new Error('WB: в ответе нет поля file');
    }

    return { buffer: Buffer.from(base64, 'base64'), stickerNumber: extractStickerNumber(first) };
  } catch (e) {
    throw e;
  }
}

/**
 * PDF этикетки Яндекс Маркет (FBS/DBS/Express): GET v2/campaigns/{campaignId}/orders/{orderId}/delivery/labels
 * @see https://yandex.ru/dev/market/partner-api/doc/en/reference/orders/generateOrderLabels
 */
async function fetchYMLabel(order, { organizationId = null } = {}) {
  let ym = null;
  try {
    const profileId = orderProfileId(order);
    ym = await integrationsService.getMarketplaceConfig('yandex', { profileId, organizationId });
  } catch (_) {
    /* use file fallback */
  }
  if (!ym?.api_key && !ym?.apiKey) {
    // В мульти-кабинетах не используем глобальный fallback, чтобы не брать ключи "чужой" кампании.
    const profileId = orderProfileId(order);
    if (profileId == null) ym = await readData('yandex');
  }
  const api_key = normalizeYandexApiKey(ym?.api_key ?? ym?.apiKey);
  if (!api_key) {
    logLabelEvent('[YM] нет Api-Key в интеграции');
    const err = new Error('Яндекс.Маркет: не настроен API-ключ для этого аккаунта');
    err.statusCode = 400;
    throw err;
  }

  const rawOid =
    order.orderGroupId ?? order.order_group_id ?? order.orderId ?? order.order_id ?? '';
  const baseId = String(rawOid).split(':')[0].trim();
  const orderIdNum = parseInt(baseId, 10);
  if (Number.isNaN(orderIdNum) || orderIdNum < 1) {
    logLabelEvent(`[YM] некорректный order id: ${rawOid}`);
    throw new Error('Некорректный номер заказа Яндекс.Маркета');
  }

  const { orderGroups, campaignIds } = await getYandexBusinessAndCampaigns(ym || {});
  const campaignsFlat = [];
  if (Array.isArray(orderGroups) && orderGroups.length > 0) {
    for (const g of orderGroups) {
      for (const c of g.campaignIds || []) campaignsFlat.push(Number(c));
    }
  } else if (Array.isArray(campaignIds)) {
    for (const c of campaignIds) campaignsFlat.push(Number(c));
  }
  // Если в интеграции указан campaign_id — используем его приоритетно, чтобы не попадать в "чужую" кампанию.
  const configuredCampaignIdRaw = ym?.campaign_id ?? ym?.campaignId ?? null;
  const configuredCampaignId = configuredCampaignIdRaw != null && String(configuredCampaignIdRaw).trim() !== ''
    ? Number(configuredCampaignIdRaw)
    : null;
  const uniqSet = new Set(campaignsFlat.filter(n => !Number.isNaN(n) && n > 0));
  const unique = [];
  if (configuredCampaignId && Number.isFinite(configuredCampaignId) && configuredCampaignId > 0) {
    unique.push(configuredCampaignId);
    uniqSet.delete(configuredCampaignId);
  }
  for (const cid of uniqSet) unique.push(cid);
  if (unique.length === 0) {
    logLabelEvent('[YM] нет campaign_id (настройте интеграцию / GET v2/campaigns)');
    throw new Error('Яндекс.Маркет: не удалось определить кампанию (campaign_id)');
  }

  const agent = getYandexHttpsAgent();
  /** Близко к 58×40 мм, как стикеры WB */
  const format = 'A9_HORIZONTALLY';

  let lastErr = '';
  for (const campaignId of unique) {
    const bases = [
      `https://api.partner.market.yandex.ru/v2/campaigns/${campaignId}/orders/${orderIdNum}/delivery/labels?format=${encodeURIComponent(format)}`,
      `https://api.partner.market.yandex.ru/v2/campaigns/${campaignId}/orders/${orderIdNum}/delivery/labels`
    ];
    let campaignFailed404 = false;
    for (const url of bases) {
      const response = await fetch(url, {
        method: 'GET',
        headers: {
          'Api-Key': api_key,
          Accept: 'application/pdf, application/json;q=0.9,*/*;q=0.8'
        },
        ...(agent && { agent })
      });

      const ct = (response.headers.get('content-type') || '').toLowerCase();

      if (response.ok) {
        const buf = Buffer.from(await response.arrayBuffer());
        if (buf.length >= 4 && buf.slice(0, 4).toString('ascii') === '%PDF') {
          return buf;
        }
        if (ct.includes('pdf') && buf.length > 100) {
          return buf;
        }
        lastErr = 'пустой или не-PDF ответ';
        continue;
      }

      const text = await response.text();
      lastErr = `${response.status}: ${text.substring(0, 280)}`;
      const org = normalizeOrgId(organizationId);
      const fp = keyFp(api_key);
      logLabelEvent(
        `[YM] labels ${campaignId}/${orderIdNum}${org ? ` org=${org}` : ''}${fp ? ` key_fp=${fp}` : ''} -> ${lastErr}`
      );
      if (response.status === 403) {
        const err = new Error(
          'Яндекс.Маркет: доступ запрещён (403) при запросе этикетки. Проверьте Api-Key и права (FBS/DBS/communication) в «Интеграции → Яндекс.Маркет», а также campaign_id.'
        );
        err.statusCode = 403;
        throw err;
      }
      if (response.status === 404) {
        campaignFailed404 = true;
        break;
      }
      if (response.status === 400) {
        // Чаще всего это "кампания не поддерживает генерацию этикеток" (FBY и пр.).
        // Важно прокинуть 501/понятное сообщение вместо 502.
        try {
          const parsed = JSON.parse(text);
          const code = parsed?.errors?.[0]?.code || parsed?.code || '';
          if (String(code).toUpperCase() === 'CAMPAIGN_TYPE_NOT_SUPPORTED') {
            const err = new Error(
              'Яндекс.Маркет: тип кампании не поддерживает генерацию этикеток. Разрешены только FBS/DBS/EXPRESS.'
            );
            err.statusCode = 501;
            throw err;
          }
        } catch (e) {
          if (e?.statusCode) throw e;
        }
        continue;
      }
      throw new Error(`Яндекс.Маркет: этикетка (${response.status})`);
    }
    if (campaignFailed404) continue;
  }

  const err = new Error(
    `Яндекс.Маркет: этикетка не получена (заказ ${orderIdNum}). ${lastErr || 'Проверьте статус заказа и привязку кампании.'}`
  );
  // 404 → этикетки нет; иначе считаем временной недоступностью/условиями Маркета.
  err.statusCode = String(lastErr || '').trim().startsWith('404:') ? 404 : 409;
  throw err;
}

const ordersLabelsService = new OrdersLabelsService();

export default ordersLabelsService;


