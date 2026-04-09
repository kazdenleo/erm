/**
 * Orders Labels Service
 * Работа с этикетками заказов (кэширование PDF/PNG, статус наличия, предзагрузка).
 *
 * Логика перенесена из старого server.js в модульный сервис.
 */

import fs from 'fs';
import { join } from 'path';
import fetch from 'node-fetch';
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

class OrdersLabelsService {
  /**
   * Получить путь к этикетке заказа, при необходимости скачав её.
   * Возвращает абсолютный путь к файлу.
   */
  async ensureLabelFile(order) {
    const filePath = getOrderLabelPath(order);

    if (!fs.existsSync(filePath)) {
      try {
        const buf = await fetchMarketplaceLabel(order);
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
        logLabelEvent(`Cached(on-demand) ${order.marketplace}:${order.orderId}`);
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

  async getLabelStatus(order) {
    const filePath = getOrderLabelPath(order);
    const exists = fs.existsSync(filePath);

    if (!exists) {
      // качаем в фоне, ответ не ждёт
      setTimeout(async () => {
        try {
          const buf = await fetchMarketplaceLabel(order);
          if (buf && Buffer.isBuffer(buf) && buf.length > 0) {
            fs.writeFileSync(filePath, buf);
            logLabelEvent(`Cached(status) ${order.marketplace}:${order.orderId}`);
          }
        } catch (e) {
          logLabelEvent(`Error(status) ${order.marketplace}:${order.orderId} -> ${e.message}`);
        }
      }, 0);
    }

    return { exists };
  }

  /**
   * Предзагрузка этикеток для массива заказов.
   * По умолчанию: new, in_assembly, assembled (и accepted для совместимости).
   */
  async preloadLabels(orders, statuses = ['new', 'in_assembly', 'assembled', 'accepted']) {
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
        const buf = await fetchMarketplaceLabel(order);
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
  if (mp === 'ozon') return fetchOzonLabel(order);
  if (mp === 'wildberries') return fetchWBLabel(order);
  if (mp === 'yandex') return fetchYMLabel(order);
  return null;
}

async function fetchOzonLabel(order) {
  try {
    let ozon = null;
    try {
      ozon = await integrationsService.getMarketplaceConfig('ozon');
    } catch (_) {}
    if (!ozon?.client_id || !ozon?.api_key) ozon = await readData('ozon');
    if (!ozon || !ozon.client_id || !ozon.api_key) return null;

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
      logLabelEvent(`[Ozon] get posting failed ${check.status}: ${text.substring(0, 300)}`);
      throw new Error(`Ozon get failed ${check.status}`);
    }
    const checkData = await check.json();
    const postingResult = checkData?.result;
    const found = postingResult && (Array.isArray(postingResult) ? postingResult.length > 0 : typeof postingResult === 'object');
    if (!found) {
      logLabelEvent(`[Ozon] posting not found: ${order.orderId}`);
      throw new Error('Ozon posting not found');
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
      throw new Error(
        `Ozon: не удалось создать задание на этикетку (${createResp.status}). ${detail || 'Заказ должен быть в статусе «Ожидает отгрузки».'}`
      );
    }

    throw new Error(
      'Ozon: этикетка недоступна. Задание создано, но файл не получен в течение 30 сек. Попробуйте запросить этикетку через минуту или создайте в ЛК Ozon.'
    );
  } catch (e) {
    throw e;
  }
}

async function fetchWBLabel(order) {
  try {
    let wb = null;
    try {
      wb = await integrationsService.getMarketplaceConfig('wildberries');
    } catch (_) {}
    if (!wb?.api_key) wb = await readData('wildberries');
    if (!wb || !wb.api_key) return null;
    // Не фильтруем по статусу — пробуем запросить этикетку; при недоступности WB API вернёт ошибку.

    const url =
      'https://marketplace-api.wildberries.ru/api/v3/orders/stickers?type=png&width=58&height=40';
    const orderIdNum = Number(order.orderId);
    if (Number.isNaN(orderIdNum)) {
      logLabelEvent(`[WB] Invalid orderId for sticker: ${order.orderId}`);
      throw new Error('Некорректный номер заказа');
    }
    const resp = await fetch(url, {
      method: 'POST',
      headers: {
        Authorization: String(wb.api_key),
        'Content-Type': 'application/json',
        Accept: 'application/json'
      },
      body: JSON.stringify({ orders: [orderIdNum] })
    });

    const text = await resp.text();

    if (!resp.ok) {
      logLabelEvent(`[WB] label error ${resp.status}: ${text.substring(0, 300)}`);
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
      const msg = json?.message || json?.error || 'Нет этикеток в ответе';
      logLabelEvent(`[WB] no stickers: ${msg}`);
      throw new Error(`WB: ${msg}`);
    }

    const first = stickers[0];
    const base64 = first?.file;
    if (!base64 || typeof base64 !== 'string') {
      logLabelEvent(`[WB] sticker has no file field`);
      throw new Error('WB: в ответе нет поля file');
    }

    return Buffer.from(base64, 'base64');
  } catch (e) {
    throw e;
  }
}

/**
 * PDF этикетки Яндекс Маркет (FBS/DBS/Express): GET v2/campaigns/{campaignId}/orders/{orderId}/delivery/labels
 * @see https://yandex.ru/dev/market/partner-api/doc/en/reference/orders/generateOrderLabels
 */
async function fetchYMLabel(order) {
  let ym = null;
  try {
    ym = await integrationsService.getMarketplaceConfig('yandex');
  } catch (_) {
    /* use file fallback */
  }
  if (!ym?.api_key && !ym?.apiKey) {
    ym = await readData('yandex');
  }
  const api_key = normalizeYandexApiKey(ym?.api_key ?? ym?.apiKey);
  if (!api_key) {
    logLabelEvent('[YM] нет Api-Key в интеграции');
    throw new Error('Яндекс.Маркет: не настроен API-ключ');
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
  const unique = [...new Set(campaignsFlat.filter(n => !Number.isNaN(n) && n > 0))];
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
      logLabelEvent(`[YM] labels ${campaignId}/${orderIdNum} -> ${lastErr}`);
      if (response.status === 404) {
        campaignFailed404 = true;
        break;
      }
      if (response.status === 400) {
        continue;
      }
      throw new Error(`Яндекс.Маркет: этикетка (${response.status})`);
    }
    if (campaignFailed404) continue;
  }

  throw new Error(
    `Яндекс.Маркет: этикетка не получена (заказ ${orderIdNum}). ${lastErr || 'Проверьте статус заказа и привязку кампании.'}`
  );
}

const ordersLabelsService = new OrdersLabelsService();

export default ordersLabelsService;


