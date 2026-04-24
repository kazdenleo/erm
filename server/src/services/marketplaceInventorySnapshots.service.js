import logger from '../utils/logger.js';
import integrationsService from './integrations.service.js';
import repositoryFactory from '../config/repository-factory.js';
import { findAll as findAllMarketplaceCabinets } from '../repositories/marketplace_cabinets.repository.pg.js';

/**
 * Ежедневный импорт:
 * - остатки на складах маркетплейсов
 * - товары "в пути" к клиенту
 * - товары, которые возвращаются
 *
 * Примечание: конкретные адаптеры по API МП будут добавляться по мере подключения.
 * Сейчас сервис создаёт снапшот и готов к наполнению lines.
 */

function normMp(mp) {
  const m = String(mp || '').toLowerCase();
  if (m === 'wb') return 'wildberries';
  if (m === 'ym' || m === 'yandexmarket') return 'yandex';
  return m;
}

function normDbMp(mp) {
  const m = String(mp || '').toLowerCase();
  if (m === 'wildberries') return 'wb';
  if (m === 'yandex') return 'ym';
  return m;
}

function toInt(v) {
  const n = Number(v);
  if (!Number.isFinite(n)) return 0;
  return Math.trunc(n);
}

async function fetchWbWarehousesInventory(apiKey) {
  const token = String(apiKey || '').trim();
  if (!token) return [];

  const hosts = [
    'https://seller-analytics-api.wildberries.ru',
    'https://statistics-api.wildberries.ru',
  ];

  const body = { nmIds: [], chrtIds: [], limit: 250000, offset: 0 };
  let lastErr = '';

  for (const base of hosts) {
    try {
      const r = await fetch(`${base}/api/analytics/v1/stocks-report/wb-warehouses`, {
        method: 'POST',
        headers: {
          Authorization: token,
          'Content-Type': 'application/json',
          Accept: 'application/json',
        },
        body: JSON.stringify(body),
      });
      if (!r.ok) {
        lastErr = `${r.status}: ${await r.text().catch(() => '')}`;
        continue;
      }
      const data = await r.json();
      const items = data?.data?.items;
      if (Array.isArray(items)) return items;
      return [];
    } catch (e) {
      lastErr = e?.message || String(e);
    }
  }

  throw new Error(`WB inventory fetch failed: ${lastErr || 'unknown error'}`);
}

async function fetchYandexStocks({ apiKey, campaignId }) {
  // В проекте YM исторически использует заголовок Api-Key (не OAuth).
  // Также чистим BOM/переносы, т.к. ключи часто копируют с пробелами.
  const token = String(apiKey || '')
    .replace(/^\uFEFF/, '')
    .replace(/[\r\n\t]+/g, '')
    .trim();
  const cid = String(campaignId || '').trim();
  if (!token || !cid) return [];

  const r = await fetch(`https://api.partner.market.yandex.ru/v2/campaigns/${encodeURIComponent(cid)}/offers/stocks`, {
    method: 'POST',
    headers: {
      'Api-Key': token,
      'Content-Type': 'application/json',
      Accept: 'application/json',
    },
    body: JSON.stringify({}),
  });
  if (!r.ok) {
    const t = await r.text().catch(() => '');
    throw new Error(`YM stocks fetch failed: ${r.status} ${t.substring(0, 300)}`);
  }
  const data = await r.json();
  const warehouses = data?.result?.warehouses;
  return Array.isArray(warehouses) ? warehouses : [];
}

/**
 * Все product_id (SKU в терминах Ozon) для кабинета — нужны для POST /v1/analytics/stocks.
 */
async function fetchOzonProductIdSkus({ clientId, apiKey }) {
  const cid = String(clientId || '').trim();
  const key = String(apiKey || '').trim();
  if (!cid || !key) return [];

  const acc = [];
  let lastId = '';
  for (let safety = 0; safety < 500; safety++) {
    const body = {
      filter: { visibility: 'ALL' },
      limit: 1000,
    };
    if (lastId) body.last_id = lastId;

    const r = await fetch('https://api-seller.ozon.ru/v3/product/list', {
      method: 'POST',
      headers: {
        'Client-Id': cid,
        'Api-Key': key,
        'Content-Type': 'application/json',
        Accept: 'application/json',
      },
      body: JSON.stringify(body),
    });
    if (!r.ok) {
      const t = await r.text().catch(() => '');
      throw new Error(`Ozon v3/product/list failed: ${r.status} ${t.substring(0, 300)}`);
    }
    const data = await r.json();
    const items = Array.isArray(data?.result?.items) ? data.result.items : [];
    for (const it of items) {
      const id = it?.product_id ?? it?.productId;
      if (id != null && String(id).trim() !== '') acc.push(String(id).trim());
    }
    const next = data?.result?.last_id ?? data?.result?.lastId;
    if (next != null && String(next).trim() !== '') {
      lastId = String(next).trim();
    } else if (items.length > 0) {
      const last = items[items.length - 1];
      const lid = last?.product_id ?? last?.productId;
      lastId = lid != null ? String(lid).trim() : '';
    } else {
      lastId = '';
    }
    if (items.length < 1000 || !lastId) break;
  }
  return [...new Set(acc)];
}

/**
 * Аналитика остатков (актуальный метод; заменяет v2/analytics/stock_on_warehouses).
 * @see https://api-seller.ozon.ru/v1/analytics/stocks — до 100 SKU за запрос.
 */
async function fetchOzonV1AnalyticsStocksAll({ clientId, apiKey, skus }) {
  const cid = String(clientId || '').trim();
  const key = String(apiKey || '').trim();
  const list = Array.isArray(skus) ? skus.map((s) => String(s).trim()).filter(Boolean) : [];
  if (!cid || !key || list.length === 0) return [];

  const allItems = [];
  const chunk = 100;
  for (let i = 0; i < list.length; i += chunk) {
    const part = list.slice(i, i + chunk);
    const r = await fetch('https://api-seller.ozon.ru/v1/analytics/stocks', {
      method: 'POST',
      headers: {
        'Client-Id': cid,
        'Api-Key': key,
        'Content-Type': 'application/json',
        Accept: 'application/json',
      },
      body: JSON.stringify({ skus: part }),
    });
    if (!r.ok) {
      const t = await r.text().catch(() => '');
      throw new Error(`Ozon v1/analytics/stocks failed: ${r.status} ${t.substring(0, 300)}`);
    }
    const data = await r.json();
    const items = Array.isArray(data?.result?.items)
      ? data.result.items
      : Array.isArray(data?.items)
        ? data.items
        : [];
    allItems.push(...items);
    /* eslint-disable no-await-in-loop */
    if (i + chunk < list.length) await new Promise((res) => setTimeout(res, 150));
    /* eslint-enable no-await-in-loop */
  }
  return allItems;
}

/** Fallback: старый отчёт (может не совпадать с аналитикой ЛК) */
async function fetchOzonStockOnWarehouses({ clientId, apiKey }) {
  const cid = String(clientId || '').trim();
  const key = String(apiKey || '').trim();
  if (!cid || !key) return [];

  const acc = [];
  const limit = 1000;
  let offset = 0;
  for (let safety = 0; safety < 200; safety++) {
    const r = await fetch('https://api-seller.ozon.ru/v2/analytics/stock_on_warehouses', {
      method: 'POST',
      headers: {
        'Client-Id': cid,
        'Api-Key': key,
        'Content-Type': 'application/json',
        Accept: 'application/json',
      },
      body: JSON.stringify({
        limit,
        offset,
        warehouse_type: 'ALL',
      }),
    });
    if (!r.ok) {
      const t = await r.text().catch(() => '');
      throw new Error(`Ozon stock_on_warehouses failed: ${r.status} ${t.substring(0, 300)}`);
    }
    const data = await r.json();
    const rows = data?.result?.rows;
    const list = Array.isArray(rows) ? rows : [];
    acc.push(...list);
    if (list.length < limit) break;
    offset += limit;
  }
  return acc;
}

async function fetchOzonReturnsList({ clientId, apiKey, status }) {
  const cid = String(clientId || '').trim();
  const key = String(apiKey || '').trim();
  const st = String(status || '').trim();
  if (!cid || !key || !st) return [];

  const limit = 1000;
  let offset = 0;
  const acc = [];
  for (let safety = 0; safety < 200; safety++) {
    const r = await fetch('https://api-seller.ozon.ru/v1/returns/list', {
      method: 'POST',
      headers: {
        'Client-Id': cid,
        'Api-Key': key,
        'Content-Type': 'application/json',
        Accept: 'application/json',
      },
      body: JSON.stringify({
        filter: { status: st },
        limit,
        offset,
      }),
    });
    if (!r.ok) {
      const t = await r.text().catch(() => '');
      throw new Error(`Ozon returns/list failed: ${r.status} ${t.substring(0, 300)}`);
    }
    const data = await r.json();
    const rows = Array.isArray(data?.returns) ? data.returns : [];
    acc.push(...rows);
    if (rows.length < limit) break;
    offset += limit;
  }
  return acc;
}

/**
 * Ключ товара для снапшота: offer_id (артикул), иначе Ozon product_id из поля sku в постинге —
 * так лучше совпадает с product_skus (sku и/или marketplace_product_id).
 */
function ozonPostingProductKey(p) {
  const offer = String(p?.offer_id ?? p?.offerId ?? '').trim();
  const sku = p?.sku != null && String(p.sku).trim() !== '' ? String(p.sku).trim() : '';
  return offer || sku;
}

/**
 * FBS-постинги «в пути к клиенту»: v3/posting/fbs/list по статусам и по чанкам дат.
 * Окно 90 дней отрезало старые, но ещё не доставленные отправления — берём до ~400 дней чанками (как синк заказов).
 */
async function fetchOzonFbsPostingsByStatuses({ clientId, apiKey, statuses, daysBack = 400, chunkDays = 30 }) {
  const cid = String(clientId || '').trim();
  const key = String(apiKey || '').trim();
  const stList = Array.isArray(statuses) ? statuses.map((s) => String(s || '').trim()).filter(Boolean) : [];
  if (!cid || !key || stList.length === 0) return [];

  const now = new Date();
  const windowStart = new Date(now.getTime() - daysBack * 24 * 60 * 60 * 1000);
  const chunkMs = chunkDays * 24 * 60 * 60 * 1000;

  const byPosting = new Map();
  for (let t = windowStart.getTime(); t < now.getTime(); t += chunkMs) {
    const since = new Date(t);
    const to = new Date(Math.min(t + chunkMs, now.getTime()));

    for (const st of stList) {
      let offset = 0;
      const limit = 1000;
      for (let safety = 0; safety < 200; safety++) {
        const r = await fetch('https://api-seller.ozon.ru/v3/posting/fbs/list', {
          method: 'POST',
          headers: {
            'Client-Id': cid,
            'Api-Key': key,
            'Content-Type': 'application/json',
            Accept: 'application/json',
          },
          body: JSON.stringify({
            dir: 'ASC',
            filter: {
              since: since.toISOString(),
              to: to.toISOString(),
              status: st,
            },
            limit,
            offset,
            with: {
              analytics_data: false,
              financial_data: false,
              transliteration: false,
            },
          }),
        });
        if (!r.ok) {
          const errText = await r.text().catch(() => '');
          throw new Error(`Ozon posting/fbs/list failed: ${r.status} ${errText.substring(0, 300)}`);
        }
        const data = await r.json();
        const rows = Array.isArray(data?.result?.postings) ? data.result.postings : [];
        for (const p of rows) {
          const pn = p?.posting_number;
          if (pn) byPosting.set(String(pn), p);
        }
        if (rows.length < limit) break;
        offset += limit;
      }
      /* eslint-disable no-await-in-loop */
      await new Promise((res) => setTimeout(res, 80));
      /* eslint-enable no-await-in-loop */
    }
  }
  return [...byPosting.values()];
}

async function resolveMarketplaceConfigsForSnapshot({ profileId, organizationId }) {
  // Если есть контекст организации — берём ключи из marketplace_cabinets (самый приоритетный/первый активный кабинет).
  if (organizationId != null && String(organizationId).trim() !== '') {
    const orgIdNum = Number(organizationId);
    if (Number.isFinite(orgIdNum) && orgIdNum > 0) {
      const cabinets = await findAllMarketplaceCabinets(orgIdNum).catch(() => []);
      const pickFirstActive = (type) =>
        (cabinets || []).find((c) => String(c?.marketplace_type).toLowerCase() === type && c?.is_active) || null;
      const oz = pickFirstActive('ozon');
      const wb = pickFirstActive('wildberries');
      const ym = pickFirstActive('yandex');
      return {
        marketplaces: {
          ozon: oz?.config || null,
          wildberries: wb?.config || null,
          yandex: ym?.config || null,
        },
      };
    }
  }

  // Фоллбек: общие интеграции профиля
  return await integrationsService.getAllConfigs(profileId ? { profileId } : {});
}

export async function runMarketplaceInventoryDailySnapshot({ profileId = null, organizationId = null } = {}) {
  if (!repositoryFactory.isUsingPostgreSQL()) {
    logger.info('[MP Inventory] Skipped: PostgreSQL disabled');
    return { ok: false, skipped: true, reason: 'postgres_disabled' };
  }

  const repo = repositoryFactory.getMarketplaceInventorySnapshotsRepository();
  const { marketplaces } = await resolveMarketplaceConfigsForSnapshot({ profileId, organizationId });

  const enabled = [
    marketplaces?.ozon && Object.keys(marketplaces.ozon || {}).length ? 'ozon' : null,
    marketplaces?.wildberries && Object.keys(marketplaces.wildberries || {}).length ? 'wildberries' : null,
    marketplaces?.yandex && Object.keys(marketplaces.yandex || {}).length ? 'yandex' : null,
  ].filter(Boolean);

  const created = [];

  for (const mp of enabled) {
    const marketplace = normMp(mp);
    const snap = await repo.createSnapshot({
      profileId,
      organizationId,
      marketplace,
      source: 'daily-sync',
      notes: 'auto snapshot (stocks + in transit + returns)'
    });

    const lines = [];
    /** Срез ответа МП для сравнения с отчётами ЛК (без секретов). */
    let mpDiagnostics = null;
    try {
      if (marketplace === 'wildberries') {
        const items = await fetchWbWarehousesInventory(marketplaces?.wildberries?.api_key);
        const list = Array.isArray(items) ? items : [];
        const sumField = (field) => list.reduce((acc, it) => acc + toInt(it?.[field]), 0);
        const nmIdsForVendor = [
          ...new Set(
            list
              .map((row) => {
                const n = row?.nmId ?? row?.nmID;
                return n != null && String(n).trim() !== '' ? String(n).trim() : null;
              })
              .filter(Boolean)
          ),
        ];
        let vendorByNm = new Map();
        if (nmIdsForVendor.length > 0) {
          try {
            vendorByNm = await integrationsService.getWildberriesVendorCodeMapByNmIds(nmIdsForVendor, profileId);
          } catch (e) {
            logger.warn(`[MP Inventory] WB vendorCode map: ${e?.message || e}`);
          }
        }
        mpDiagnostics = {
          endpoint: 'POST /api/analytics/v1/stocks-report/wb-warehouses',
          hint:
            'Поле inWayToClient — остатки «к клиенту» по строкам склада×размер (не число заказов). Отчёт заказов в ЛК WB — другая выборка.',
          rowCount: list.length,
          sums: {
            quantity: sumField('quantity'),
            inWayToClient: sumField('inWayToClient'),
            inWayFromClient: sumField('inWayFromClient'),
          },
          vendorCodesResolved: vendorByNm.size,
          sampleItems: list.slice(0, 8).map((it) => {
            const nmKey =
              it?.nmId != null && String(it.nmId ?? it.nmID).trim() !== ''
                ? String(it.nmId ?? it.nmID).trim()
                : '';
            return {
              nmId: it?.nmId ?? it?.nmID,
              chrtId: it?.chrtId ?? it?.chrtID,
              wbVendorCode: nmKey ? vendorByNm.get(nmKey) ?? null : null,
              warehouseId: it?.warehouseId ?? it?.warehouseID,
              warehouseName: it?.warehouseName,
              quantity: it?.quantity,
              inWayToClient: it?.inWayToClient,
              inWayFromClient: it?.inWayFromClient,
            };
          }),
        };
        for (const it of list) {
          // WB /wb-warehouses: одна строка = размер (chrtId) в складе. В карточках и заказах в БД
          // часто в product_skus.sku лежит chrtId или nmId; для себестоимости храним оба, если есть.
          const nmRaw = it?.nmId ?? it?.nmID;
          const chrtRaw = it?.chrtId ?? it?.chrtID;
          const nmStr = nmRaw != null && String(nmRaw).trim() !== '' ? String(nmRaw).trim() : '';
          const chrtStr = chrtRaw != null && String(chrtRaw).trim() !== '' ? String(chrtRaw).trim() : '';
          const chrtNum = chrtStr ? Number(chrtStr) : NaN;
          let externalSku = '';
          if (nmStr && chrtStr && Number.isFinite(chrtNum) && chrtNum > 0) {
            externalSku = `${nmStr}:${chrtStr}`;
          } else if (nmStr) {
            externalSku = nmStr;
          } else {
            externalSku = chrtStr;
          }
          if (!externalSku) continue;
          const rawVc = nmStr ? vendorByNm.get(nmStr) : null;
          const wbVendorCode =
            rawVc != null && String(rawVc).trim() !== '' ? String(rawVc).trim() : null;
          const wid = it?.warehouseId ?? it?.warehouseID;
          const wname = String(it?.warehouseName || '').trim();
          const wh = wid != null && String(wid).trim() !== ''
            ? (wname ? `${String(wid).trim()} — ${wname}` : String(wid).trim())
            : (wname || null);

          const qty = toInt(it?.quantity);
          const toClient = toInt(it?.inWayToClient);
          const fromClient = toInt(it?.inWayFromClient);
          const wbLine = { externalSku, warehouseName: wh, wbVendorCode };
          if (qty) lines.push({ state: 'mp_warehouse', ...wbLine, quantity: qty });
          if (toClient) lines.push({ state: 'to_customer', ...wbLine, quantity: toClient });
          if (fromClient) lines.push({ state: 'returning', ...wbLine, quantity: fromClient });
        }
      } else if (marketplace === 'yandex') {
        const ycfg = marketplaces?.yandex || {};
        const warehouses = await fetchYandexStocks({ apiKey: ycfg.api_key, campaignId: ycfg.campaign_id ?? ycfg.campaignId });
        for (const w of warehouses || []) {
          const whId = w?.warehouseId ?? w?.warehouseID;
          const wh = whId != null ? `warehouseId:${String(whId)}` : null;
          const offers = Array.isArray(w?.offers) ? w.offers : [];
          for (const o of offers) {
            const externalSku = String(o?.offerId ?? '').trim();
            if (!externalSku) continue;
            const stocks = Array.isArray(o?.stocks) ? o.stocks : [];
            // YM даёт типы FIT/DEFECT/etc. Для суммы себестоимости берём FIT как основной "на складе".
            const fit = stocks.find((s) => String(s?.type || '').toUpperCase() === 'FIT');
            // Чтобы не раздувать цифры (DEFECT/EXPIRED/etc), берём только FIT.
            const qty = fit ? toInt(fit.count) : 0;
            if (qty) lines.push({ state: 'mp_warehouse', externalSku, warehouseName: wh, quantity: qty });
          }
        }
        const whList = Array.isArray(warehouses) ? warehouses : [];
        let offerRows = 0;
        for (const w of whList) {
          const offers = Array.isArray(w?.offers) ? w.offers : [];
          offerRows += offers.length;
        }
        mpDiagnostics = {
          endpoint: 'POST .../campaigns/{id}/offers/stocks',
          hint: 'Яндекс Маркет в этом методе не отдаёт «в пути к клиенту»; в таблице только склад FIT.',
          warehouses: whList.length,
          offerRows,
        };
      } else if (marketplace === 'ozon') {
        const ocfg = marketplaces?.ozon || {};
        const clientId = ocfg.client_id ?? ocfg.clientId;
        const apiKey = ocfg.api_key ?? ocfg.apiKey;

        // 1) Остатки и «от клиента» — POST /v1/analytics/stocks (как в разделе аналитики ЛК).
        let usedV1 = false;
        try {
          const idSkus = await fetchOzonProductIdSkus({ clientId, apiKey });
          if (idSkus.length > 0) {
            const analyticsItems = await fetchOzonV1AnalyticsStocksAll({ clientId, apiKey, skus: idSkus });
            usedV1 = true;
            for (const row of analyticsItems || []) {
              const externalSku = String(row?.offer_id ?? row?.offerId ?? '').trim();
              if (!externalSku) continue;
              const whName = String(row?.warehouse_name ?? row?.warehouseName ?? '').trim();
              const clName = String(row?.cluster_name ?? row?.clusterName ?? '').trim();
              const wh =
                [whName, clName].filter(Boolean).join(' · ') || String(row?.warehouse_id ?? row?.cluster_id ?? '').trim() || 'ozon';

              const available = toInt(row?.available_stock_count ?? row?.availableStockCount);
              const fromClient = toInt(
                row?.return_from_customer_stock_count ?? row?.returnFromCustomerStockCount
              );
              if (available) {
                lines.push({ state: 'mp_warehouse', externalSku, warehouseName: wh, quantity: available });
              }
              if (fromClient) {
                lines.push({ state: 'returning', externalSku, warehouseName: wh, quantity: fromClient });
              }
            }
            logger.info(`[MP Inventory] Ozon v1/analytics/stocks: product_ids=${idSkus.length} rows=${analyticsItems.length}`);
          }
        } catch (e) {
          logger.warn(`[MP Inventory] Ozon v1 analytics stocks: ${e?.message || e}`);
        }

        if (!usedV1) {
          // Фоллбек: старый v2-отчёт (может расходиться с «Отчётом» в ЛК)
          const rows = await fetchOzonStockOnWarehouses({ clientId, apiKey });
          for (const row of rows || []) {
            const externalSku = String(row?.offer_id ?? row?.offerId ?? row?.item_code ?? row?.itemCode ?? '').trim();
            if (!externalSku) continue;
            const wh = String(row?.warehouse_name ?? row?.warehouseName ?? '').trim() || null;
            const free = toInt(row?.free_to_sell_amount ?? row?.freeToSellAmount);
            const reserved = toInt(row?.reserved_amount ?? row?.reservedAmount);
            const onMp = free + reserved;
            if (onMp) lines.push({ state: 'mp_warehouse', externalSku, warehouseName: wh, quantity: onMp });
          }
          const returns = await fetchOzonReturnsList({ clientId, apiKey, status: 'returned_to_ozon' }).catch(() => []);
          for (const ret of returns || []) {
            const prods = Array.isArray(ret?.products) ? ret.products : [];
            for (const p of prods) {
              const externalSku = String(p?.offer_id ?? p?.offerId ?? '').trim();
              if (!externalSku) continue;
              const qty = toInt(p?.quantity ?? 1);
              if (qty) lines.push({ state: 'returning', externalSku, warehouseName: 'returns', quantity: qty });
            }
          }
        }

        // 2) В пути к клиенту (Ozon FBS): считаем по posting/fbs/list статусам доставки.
        // API остатков stock_on_warehouses часто отдаёт in_transit=0 или другую семантику, поэтому берём из постингов.
        const toCustomerPostings = await fetchOzonFbsPostingsByStatuses({
          clientId,
          apiKey,
          statuses: [
            // Набор статусов Ozon, которые в нашем маппинге = "в доставке"
            'sent_by_seller',
            'driver_pickup',
            'delivering',
            'at_last_mile',
            'driving_to_pickup_point',
            'arrived_to_pickup_point',
            'delivery',
          ],
        }).catch(() => []);
        const postingList = Array.isArray(toCustomerPostings) ? toCustomerPostings : [];
        let unitsInTransitFromPostings = 0;
        for (const post of postingList) {
          const prods = Array.isArray(post?.products) ? post.products : [];
          for (const p of prods) {
            const externalSku = ozonPostingProductKey(p);
            if (!externalSku) continue;
            const qty = toInt(p?.quantity ?? 0);
            unitsInTransitFromPostings += qty;
            if (qty) lines.push({ state: 'to_customer', externalSku, warehouseName: 'fbs', quantity: qty });
          }
        }
        mpDiagnostics = {
          endpoint: 'POST https://api-seller.ozon.ru/v3/posting/fbs/list (несколько статусов «в доставке», окно дат)',
          hint:
            'Здесь — сумма quantity по товарам в FBS-постингах с логистическими статусами. Число заказов в ERM (in_transit) может отличаться: другой момент синка, FBO, частичные отмены, статус в ЛК.',
          postingsDistinct: postingList.length,
          productUnitsSum: unitsInTransitFromPostings,
          samplePostings: postingList.slice(0, 6).map((post) => ({
            posting_number: post?.posting_number ?? post?.postingNumber,
            status: post?.status,
            substatus: post?.substatus ?? post?.subStatus,
            products: (Array.isArray(post?.products) ? post.products : []).map((p) => ({
              offer_id: p?.offer_id ?? p?.offerId,
              sku: p?.sku,
              quantity: p?.quantity,
            })),
          })),
        };
      }
    } catch (e) {
      logger.warn(`[MP Inventory] ${marketplace} snapshot fetch failed: ${e?.message || e}`);
    }

    const inserted = await repo.insertLines(snap.id, lines);
    created.push({
      marketplace,
      snapshotId: snap.id,
      linesInserted: inserted,
      diagnostics: mpDiagnostics,
    });
    logger.info(`[MP Inventory] snapshot created: mp=${marketplace} id=${snap.id} lines=${inserted}`);
  }

  return { ok: true, created };
}

export async function getLatestMarketplaceInventorySummary({ marketplace, profileId = null, organizationId = null }) {
  if (!repositoryFactory.isUsingPostgreSQL()) {
    return { snapshot: null, totals: [], costs: [] };
  }
  const repo = repositoryFactory.getMarketplaceInventorySnapshotsRepository();
  const snap = await repo.getLatestSnapshotByMarketplace(marketplace, { profileId, organizationId });
  if (!snap) return { snapshot: null, totals: [], costs: [] };
  const totals = await repo.getTotalsBySnapshotId(snap.id);
  const costs = await repo.getCostSumsBySnapshotId(snap.id, marketplace);
  return { snapshot: snap, totals, costs };
}

