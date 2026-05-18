/**
 * Shipments Service (FBS)
 * Ozon, Яндекс — только локальные поставки (создаём в приложении).
 * Wildberries — создаём поставку на маркетплейсе (POST /api/v3/supplies) и добавляем в неё заказы (PATCH).
 * При закрытии WB-поставки: передача в доставку (PATCH deliver), запрос QR-стикера (GET barcode), сохранение в приложение.
 */

import fs from 'fs';
import { join } from 'path';
import { readData, writeData, DATA_DIR } from '../utils/storage.js';
import integrationsService from './integrations.service.js';
import logger from '../utils/logger.js';
import { getFetchProxyAgent } from '../utils/fetchAgent.js';
import { ozonPostingNumberFromOrderId } from '../utils/ozonPosting.js';

const SHIPMENT_STICKERS_DIR = join(DATA_DIR, 'shipment-stickers');

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function retryAfterMsFromResponse(response, fallbackMs) {
  try {
    const ra = response?.headers?.get?.('retry-after');
    if (!ra) return fallbackMs;
    const sec = parseInt(String(ra).trim(), 10);
    if (Number.isFinite(sec) && sec > 0) return sec * 1000;
  } catch {
    /* ignore */
  }
  return fallbackMs;
}

const MARKETPLACES = [
  { code: 'ozon', name: 'Ozon', icon: '🟠', localOnly: true },
  { code: 'wildberries', name: 'Wildberries', icon: '🟣', localOnly: false },
  { code: 'yandex', name: 'Яндекс.Маркет', icon: '🔴', localOnly: true }
];

/** Локальные поставки в JSON: без profileId не показываем пользователям с привязкой к аккаунту (мультитенант). */
function shipmentVisibleForProfile(s, profileId) {
  if (profileId == null || profileId === '') return true;
  const n = typeof profileId === 'string' ? parseInt(profileId, 10) : Number(profileId);
  if (!Number.isFinite(n) || n <= 0) return true;
  const sp = s.profileId;
  if (sp == null || sp === '') return false;
  const sn = typeof sp === 'string' ? parseInt(sp, 10) : Number(sp);
  return Number.isFinite(sn) && sn === n;
}

function normalizeOrgId(value) {
  if (value == null || value === '') return null;
  const s = String(value).trim();
  if (!s) return null;
  const n = Number(s);
  return Number.isFinite(n) && n > 0 ? String(Math.trunc(n)) : s;
}

/** Локальные поставки не должны смешиваться между организациями в рамках одного профиля. */
function shipmentVisibleForScope(s, profileId, organizationId) {
  if (!shipmentVisibleForProfile(s, profileId)) return false;
  const org = normalizeOrgId(organizationId);
  if (org == null) return true;
  const so = normalizeOrgId(s?.organizationId ?? s?.organization_id ?? null);
  return so != null && String(so) === String(org);
}

async function getWildberriesConfigForScope(profileId, { organizationId = null } = {}) {
  if (profileId != null && profileId !== '') {
    const cfg = await integrationsService.getMarketplaceConfig('wildberries', { profileId, organizationId });
    return cfg && cfg.api_key ? cfg : null;
  }
  const { marketplaces } = await integrationsService.getAllConfigs();
  return marketplaces?.wildberries?.api_key ? marketplaces.wildberries : null;
}

function wbAuthHeaderFromConfig(cfg) {
  const raw = String(cfg?.api_key || '').trim();
  if (!raw) return '';
  const tokenClean =
    typeof integrationsService?._normalizeWbToken === 'function'
      ? integrationsService._normalizeWbToken(raw)
      : raw.replace(/\s+/g, '').replace(/\uFEFF/g, '').trim();
  return tokenClean.toLowerCase().startsWith('bearer ')
    ? tokenClean
    : `Bearer ${tokenClean}`;
}

async function confirmWBOrdersForAssembly(config, orderIds) {
  // FBS: прямого "confirm" эндпоинта нет. Статус supplierStatus=confirm выставляется при добавлении заказа в поставку.
  // Оставляем функцию как no-op для совместимости вызовов.
  return;
}

function generateId() {
  return `ship-${Date.now()}-${Math.random().toString(36).slice(2, 9)}`;
}

async function getLocalShipments() {
  const data = await readData('shipments');
  return Array.isArray(data?.shipments) ? data.shipments : [];
}

async function saveLocalShipments(shipments) {
  await writeData('shipments', { shipments, updatedAt: new Date().toISOString() });
}

/** Минимальная запись только для печати сохранённого QR после «подчистки» списка перед новой поставкой. */
function buildStickerArchiveStub(s) {
  const org = normalizeOrgId(s.organizationId ?? s.organization_id ?? null);
  const m = s.marketplace === 'wb' ? 'wildberries' : s.marketplace;
  return {
    id: s.id,
    marketplace: m,
    closed: true,
    stickerArchiveOnly: true,
    qrStickerPath: s.qrStickerPath,
    orderIds: [],
    createdAt: s.createdAt || new Date().toISOString(),
    ...(s.profileId != null && s.profileId !== '' ? { profileId: s.profileId } : {}),
    ...(org ? { organizationId: org } : {})
  };
}

/**
 * Перед созданием новой поставки: в ERM храним только открытые и закрытые до следующего создания.
 * Закрытые поставки того же МП и scope убираем из «списка»: при наличии QR оставляем компактную запись
 * stickerArchiveOnly (файл на диске не трогаем), чтобы этикетку можно было напечатать по ссылке позже.
 */
async function pruneClosedLocalShipmentsForNewCreate(marketplaceCode, { profileId = null, organizationId = null } = {}) {
  const org = normalizeOrgId(organizationId);
  const all = await getLocalShipments();
  const next = [];
  for (const s of all) {
    const isLocal = s?.id && String(s.id).startsWith('ship-');
    const m = s.marketplace === 'wb' ? 'wildberries' : s.marketplace;
    const drop =
      isLocal &&
      m === marketplaceCode &&
      s.closed === true &&
      shipmentVisibleForScope(s, profileId, org) &&
      !s.stickerArchiveOnly;
    if (drop) {
      if (s.qrStickerPath) {
        next.push(buildStickerArchiveStub(s));
      }
      continue;
    }
    next.push(s);
  }
  if (next.length !== all.length) {
    await saveLocalShipments(next);
    logger.info(
      `[Shipments] Pruned ${all.length - next.length} closed local shipment(s) for ${marketplaceCode} before new create`
    );
  }
  return next;
}

/**
 * Список поставок: Ozon/Яндекс — из локального хранилища; WB — с маркетплейса + локальные (созданные через нас).
 */
async function getShipments({ profileId, organizationId } = {}) {
  const localAll = await getLocalShipments();
  const local = localAll.filter((s) => shipmentVisibleForScope(s, profileId, organizationId));
  const byMarketplace = { ozon: [], wildberries: [], yandex: [] };

  for (const s of local) {
    if (s.stickerArchiveOnly) continue;
    const code = s.marketplace === 'wb' ? 'wildberries' : s.marketplace;
    if (byMarketplace[code]) {
      byMarketplace[code].push(normalizeShipment(s));
    }
  }

  try {
    const wbConfig = await getWildberriesConfigForScope(profileId, { organizationId });
    if (wbConfig?.api_key) {
      const wbList = await fetchWBSupplies(wbConfig);
      const localWbIds = new Set(byMarketplace.wildberries.map(s => s.externalId).filter(Boolean));
      for (const s of wbList) {
        if (!localWbIds.has(s.id)) byMarketplace.wildberries.push(s);
      }
      byMarketplace.wildberries.sort((a, b) => (b.createdAt || '').localeCompare(a.createdAt || ''));
    }
  } catch (e) {
    logger.warn('[Shipments] WB fetch:', e.message);
  }

  return { marketplaces: MARKETPLACES, list: byMarketplace };
}

function normalizeShipment(s) {
  const closed = s.closed === true;
  return {
    id: s.id,
    marketplace: s.marketplace,
    name: s.name || s.id,
    status: closed ? 'closed' : (s.status || 'draft'),
    closed,
    externalId: s.externalId,
    orderIds: s.orderIds || [],
    productsCount: (s.orderIds || []).length,
    createdAt: s.createdAt,
    shipmentDate: s.shipmentDate,
    qrStickerPath: s.qrStickerPath || null,
    /** true, если поставка WB заведена только в ERM без API-ключа (без поставки в ЛК) */
    localWbOnly: s.localWbOnly === true,
  };
}

async function fetchWBSupplies(config) {
  const { api_key } = config;
  const agent = getFetchProxyAgent();
  const url = 'https://marketplace-api.wildberries.ru/api/v3/supplies?next=0';
  let response;
  for (let attempt = 0; attempt < 4; attempt++) {
    response = await fetch(url, {
      method: 'GET',
      headers: { Authorization: wbAuthHeaderFromConfig({ api_key }), Accept: 'application/json' },
      ...(agent && { agent })
    });
    if (response.ok) break;
    if (response.status === 429 && attempt < 3) {
      const waitMs = retryAfterMsFromResponse(response, 4000 * (attempt + 1));
      logger.warn(`[Shipments WB] rate limited 429 (supplies list), retry in ${Math.round(waitMs / 1000)}s...`);
      await sleep(waitMs);
      continue;
    }
    break;
  }
  if (!response?.ok) return [];
  const data = await response.json().catch(() => ({}));
  const supplies = Array.isArray(data?.supplies) ? data.supplies : [];
  return supplies.map(s => ({
    id: s.id ?? s.supplyId,
    marketplace: 'wildberries',
    name: s.name ?? s.supplyId ?? String(s.id),
    status: s.status ?? (s.done ? 'done' : 'active'),
    externalId: String(s.id ?? s.supplyId),
    orderIds: [],
    productsCount: s.ordersCount ?? s.quantity ?? 0,
    createdAt: s.createdAt ?? s.date,
    shipmentDate: s.closedAt ?? s.shipmentDate
  }));
}

/**
 * Создать поставку. Ozon/Яндекс — только локально. WB — создать на маркетплейсе и сохранить у себя.
 */
async function createShipment({ marketplace, name, profileId = null, organizationId = null }) {
  const code = marketplace === 'wb' ? 'wildberries' : marketplace;
  if (!['ozon', 'wildberries', 'yandex'].includes(code)) {
    const err = new Error('Неизвестный маркетплейс');
    err.statusCode = 400;
    throw err;
  }

  await pruneClosedLocalShipmentsForNewCreate(code, { profileId, organizationId });
  const shipments = await getLocalShipments();
  const id = generateId();
  const now = new Date().toISOString();
  const org = normalizeOrgId(organizationId);

  if (code === 'wildberries') {
    const wbConfig = await getWildberriesConfigForScope(profileId, { organizationId });
    if (wbConfig?.api_key) {
      const supplyId = await createWBSupply(wbConfig);
      const local = {
        id,
        marketplace: code,
        name: name || supplyId,
        status: 'active',
        closed: false,
        externalId: supplyId,
        orderIds: [],
        createdAt: now,
        ...(profileId != null && profileId !== '' ? { profileId } : {}),
        ...(org ? { organizationId: org } : {}),
      };
      shipments.push(local);
      await saveLocalShipments(shipments);
      return normalizeShipment(local);
    }
    logger.warn(
      '[Shipments] Wildberries: нет API-ключа для этого аккаунта — поставка только в ERM, без ЛК WB. ' +
        'Добавьте ключ в «Интеграции» и повторно отправьте на сборку или оформите поставки в кабинете WB.'
    );
    const local = {
      id,
      marketplace: code,
      name: name || `Сборка ${new Date().toLocaleDateString('ru-RU')}`,
      status: 'active',
      closed: false,
      orderIds: [],
      createdAt: now,
      localWbOnly: true,
      ...(profileId != null && profileId !== '' ? { profileId } : {}),
      ...(org ? { organizationId: org } : {}),
    };
    shipments.push(local);
    await saveLocalShipments(shipments);
    return normalizeShipment(local);
  }

  const local = {
    id,
    marketplace: code,
    name: name || `Поставка ${id.slice(-6)}`,
    status: 'draft',
    closed: false,
    orderIds: [],
    createdAt: now,
    ...(profileId != null && profileId !== '' ? { profileId } : {}),
    ...(org ? { organizationId: org } : {}),
  };
  shipments.push(local);
  await saveLocalShipments(shipments);
  return normalizeShipment(local);
}

/**
 * Получить текущую открытую поставку по маркетплейсу или создать новую.
 * Используется при «Отправить на сборку»: все заказы до закрытия идут в одну поставку.
 */
async function getOrCreateOpenShipment(marketplace, { profileId = null, organizationId = null } = {}) {
  const code = marketplace === 'wb' ? 'wildberries' : marketplace;
  if (!['ozon', 'wildberries', 'yandex'].includes(code)) {
    const err = new Error('Неизвестный маркетплейс');
    err.statusCode = 400;
    throw err;
  }
  const shipments = await getLocalShipments();
  const org = normalizeOrgId(organizationId);
  const open = shipments.find(s => {
    const m = s.marketplace === 'wb' ? 'wildberries' : s.marketplace;
    if (m !== code || s.closed === true) return false;
    return shipmentVisibleForScope(s, profileId, org);
  });
  if (open) return normalizeShipment(open);
  return createShipment({
    marketplace: code,
    name: `Сборка ${new Date().toLocaleDateString('ru-RU')}`,
    profileId,
    organizationId
  });
}

const ASSEMBLED_CLOSE_STATUSES = new Set(['assembled', 'shipped']);

function orderStatusLabel(status) {
  const s = String(status || '').toLowerCase();
  const map = {
    new: 'Новый',
    in_procurement: 'В закупке',
    in_assembly: 'На сборке',
    assembled: 'Собран',
    shipped: 'Отгружен',
    cancelled: 'Отменён',
    not_found: 'Не найден в ERP'
  };
  return map[s] || s || '—';
}

function isOrderCancelledForClose(status) {
  return String(status || '').toLowerCase() === 'cancelled';
}

function isOrderReadyForShipmentClose(status) {
  return ASSEMBLED_CLOSE_STATUSES.has(String(status || '').toLowerCase());
}

/**
 * Проверка заказов в поставке перед закрытием.
 */
async function inspectShipmentOrdersForClose(ship, profileId) {
  const { default: ordersService } = await import('./orders.service.js');
  const mp = ship.marketplace;
  const notAssembled = [];
  const cancelled = [];
  const ready = [];

  for (const rawOid of ship.orderIds || []) {
    const orderId = String(rawOid).trim();
    if (!orderId) continue;
    const order = await ordersService.getByMarketplaceAndOrderId(mp, orderId, { profileId });
    const st = order ? String(order.status || '').toLowerCase() : 'not_found';
    const item = {
      orderId,
      status: st,
      statusLabel: orderStatusLabel(st),
      productName: order?.productName || order?.product_name || null
    };
    if (!order || st === 'not_found') {
      notAssembled.push(item);
    } else if (isOrderCancelledForClose(st)) {
      cancelled.push(item);
    } else if (!isOrderReadyForShipmentClose(st)) {
      notAssembled.push(item);
    } else {
      ready.push(item);
    }
  }

  return { notAssembled, cancelled, ready };
}

async function getShipmentClosePreview(shipmentId, { profileId = null, organizationId = null } = {}) {
  const ship = await getShipmentById(shipmentId, { profileId, organizationId });
  if (!ship) {
    const err = new Error('Поставка не найдена');
    err.statusCode = 404;
    throw err;
  }
  if (ship.closed) {
    const err = new Error('Поставка уже закрыта');
    err.statusCode = 400;
    throw err;
  }
  const issues = await inspectShipmentOrdersForClose(ship, profileId);
  return {
    shipmentId: ship.id,
    canCloseImmediately: !issues.notAssembled.length && !issues.cancelled.length,
    ...issues
  };
}

function shipmentCloseConfirmError(preview) {
  const err = new Error(
    'Перед закрытием поставки нужно решить, что делать с несобранными и отменёнными заказами'
  );
  err.statusCode = 409;
  err.details = {
    code: 'SHIPMENT_CLOSE_CONFIRM_REQUIRED',
    notAssembled: preview.notAssembled,
    cancelled: preview.cancelled,
    ready: preview.ready
  };
  return err;
}

/**
 * Закрыть поставку. После закрытия новые заказы «на сборку» пойдут в новую поставку.
 * @param {{ notAssembled?: 'assemble'|'remove', cancelled?: 'remove'|'keep' }} [closeOptions]
 */
async function closeShipment(
  shipmentId,
  { profileId = null, organizationId = null, closeOptions = null } = {}
) {
  const shipments = await getLocalShipments();
  let ship = shipments.find(s => s.id === shipmentId);
  if (!ship) {
    const err = new Error('Поставка не найдена');
    err.statusCode = 404;
    throw err;
  }
  if (!shipmentVisibleForScope(ship, profileId, organizationId)) {
    const err = new Error('Поставка не найдена');
    err.statusCode = 404;
    throw err;
  }
  if (ship.closed) {
    const err = new Error('Поставка уже закрыта');
    err.statusCode = 400;
    throw err;
  }

  const preview = await inspectShipmentOrdersForClose(ship, profileId);
  const hasNotAssembled = preview.notAssembled.length > 0;
  const hasCancelled = preview.cancelled.length > 0;

  if (hasNotAssembled || hasCancelled) {
    const opts = closeOptions && typeof closeOptions === 'object' ? closeOptions : null;
    const notAssembledAction = opts?.notAssembled != null ? String(opts.notAssembled) : null;
    const cancelledAction = opts?.cancelled != null ? String(opts.cancelled) : null;

    if (hasNotAssembled && notAssembledAction !== 'assemble' && notAssembledAction !== 'remove') {
      throw shipmentCloseConfirmError(preview);
    }
    if (hasCancelled && cancelledAction !== 'remove' && cancelledAction !== 'keep') {
      throw shipmentCloseConfirmError(preview);
    }

    const { default: ordersService } = await import('./orders.service.js');
    const mp = ship.marketplace;

    if (hasNotAssembled && notAssembledAction === 'assemble') {
      for (const item of preview.notAssembled) {
        if (item.status === 'not_found') continue;
        try {
          await ordersService.markOrderAsAssembled(mp, item.orderId, null, profileId, null);
        } catch (e) {
          logger.warn(`[Shipments] mark assembled ${item.orderId}: ${e?.message || e}`);
        }
      }
    }

    const toRemove = [];
    if (hasNotAssembled && notAssembledAction === 'remove') {
      toRemove.push(...preview.notAssembled.map((i) => i.orderId));
    }
    if (hasCancelled && cancelledAction === 'remove') {
      toRemove.push(...preview.cancelled.map((i) => i.orderId));
    }
    if (toRemove.length) {
      await removeOrdersFromShipment(shipmentId, [...new Set(toRemove)], {
        profileId,
        organizationId
      });
      ship = (await getLocalShipments()).find((s) => s.id === shipmentId) || ship;
    }
  }

  ship.closed = true;
  ship.status = 'closed';
  ship.closedAt = new Date().toISOString();

  if (ship.marketplace === 'wildberries' && ship.externalId) {
    try {
      const wbConfig = await getWildberriesConfigForScope(ship.profileId, { organizationId });
      if (wbConfig?.api_key) {
        await wbDeliverSupply(wbConfig, ship.externalId);
        let barcodeBase64 = null;
        for (let attempt = 0; attempt < 8; attempt++) {
          if (attempt > 0) await sleep(600);
          barcodeBase64 = await wbGetSupplyBarcode(wbConfig, ship.externalId, 'png');
          if (barcodeBase64) break;
        }
        if (barcodeBase64) {
          if (!fs.existsSync(SHIPMENT_STICKERS_DIR)) fs.mkdirSync(SHIPMENT_STICKERS_DIR, { recursive: true });
          const safeName = `${(ship.id || ship.externalId).replace(/[^a-zA-Z0-9-_]/g, '_')}.png`;
          const filePath = join(SHIPMENT_STICKERS_DIR, safeName);
          fs.writeFileSync(filePath, Buffer.from(barcodeBase64, 'base64'));
          ship.qrStickerPath = `shipment-stickers/${safeName}`;
        } else {
          logger.warn('[Shipments] WB supply barcode empty after deliver (retries exhausted)', ship.externalId);
        }
      }
    } catch (e) {
      logger.warn('[Shipments] WB deliver/barcode:', e.message);
    }
  }

  await saveLocalShipments(shipments);

  const orderIds = Array.isArray(ship.orderIds) ? ship.orderIds : [];
  if (orderIds.length > 0 && ship.marketplace) {
    try {
      const { default: ordersService } = await import('./orders.service.js');
      const fin = await ordersService.applyAssemblyStockForShipmentOrders(
        ship.marketplace,
        orderIds,
        profileId
      );
      logger.info(
        `[Shipments] Закрытие ${shipmentId}: резерв и списание по заказам — собрано ${fin?.processed ?? 0}, ` +
          `только движения ${fin?.stockOnly ?? 0}, пропущено (отмена) ${fin?.skipped ?? 0}, не найдено в БД ${fin?.notFound ?? 0}`
      );
    } catch (e) {
      logger.warn('[Shipments] Закрытие поставки: не удалось списать остатки по заказам:', e?.message || e);
    }
  } else if (orderIds.length === 0) {
    logger.warn(`[Shipments] Закрытие ${shipmentId}: в поставке нет orderIds — движения остатков не созданы`);
  }

  return normalizeShipment(ship);
}

/**
 * Повторно списать остатки по заказам закрытой поставки (если при первом закрытии движения не создались).
 */
async function reapplyStockForShipment(shipmentId, { profileId = null, organizationId = null } = {}) {
  const shipments = await getLocalShipments();
  const ship = shipments.find((s) => s.id === shipmentId);
  if (!ship) {
    const err = new Error('Поставка не найдена');
    err.statusCode = 404;
    throw err;
  }
  if (!shipmentVisibleForScope(ship, profileId, organizationId)) {
    const err = new Error('Поставка не найдена');
    err.statusCode = 404;
    throw err;
  }
  const orderIds = Array.isArray(ship.orderIds) ? ship.orderIds : [];
  if (orderIds.length === 0 || !ship.marketplace) {
    return { processed: 0, stockOnly: 0 };
  }
  const { default: ordersService } = await import('./orders.service.js');
  return ordersService.applyAssemblyStockForShipmentOrders(ship.marketplace, orderIds, profileId);
}

/** Передать поставку WB в доставку (обязательно перед запросом QR). */
async function wbDeliverSupply(config, supplyId) {
  const { api_key } = config;
  const agent = getFetchProxyAgent();
  const url = `https://marketplace-api.wildberries.ru/api/v3/supplies/${encodeURIComponent(supplyId)}/deliver`;
  const response = await fetch(url, {
    method: 'PATCH',
    headers: { Authorization: wbAuthHeaderFromConfig({ api_key }), 'Content-Type': 'application/json', Accept: 'application/json' },
    body: JSON.stringify({}),
    ...(agent && { agent })
  });
  if (!response.ok) {
    const text = await response.text();
    throw new Error(`WB deliver ${response.status}: ${text.slice(0, 150)}`);
  }
}

/** Получить QR-код поставки WB (svg, zplv, zplh, png). Доступен только после transfer to delivery. */
async function wbGetSupplyBarcode(config, supplyId, type = 'png') {
  const { api_key } = config;
  const agent = getFetchProxyAgent();
  const url = `https://marketplace-api.wildberries.ru/api/v3/supplies/${encodeURIComponent(supplyId)}/barcode?type=${encodeURIComponent(type)}`;
  const response = await fetch(url, {
    method: 'GET',
    headers: { Authorization: wbAuthHeaderFromConfig({ api_key }), Accept: 'application/json' },
    ...(agent && { agent })
  });
  if (!response.ok) return null;
  const data = await response.json().catch(() => ({}));
  return data?.file || null;
}

async function createWBSupply(config) {
  const { api_key } = config;
  const agent = getFetchProxyAgent();
  const url = 'https://marketplace-api.wildberries.ru/api/v3/supplies';
  let response;
  for (let attempt = 0; attempt < 4; attempt++) {
    response = await fetch(url, {
      method: 'POST',
      headers: {
        Authorization: wbAuthHeaderFromConfig({ api_key }),
        'Content-Type': 'application/json',
        Accept: 'application/json'
      },
      body: JSON.stringify({}),
      ...(agent && { agent })
    });
    if (response.ok) break;
    if (response.status === 429 && attempt < 3) {
      const waitMs = retryAfterMsFromResponse(response, 5000 * (attempt + 1));
      logger.warn(`[Shipments WB] rate limited 429 (create supply), retry in ${Math.round(waitMs / 1000)}s...`);
      await sleep(waitMs);
      continue;
    }
    break;
  }
  if (!response.ok) {
    const text = await response.text();
    if (response.status === 429) {
      const waitMs = retryAfterMsFromResponse(response, 30000);
      const err = new Error(`WB временно ограничил запросы (429). Попробуйте ещё раз через ${Math.max(1, Math.round(waitMs / 1000))} сек.`);
      err.statusCode = 429;
      err.retryAfterMs = waitMs;
      throw err;
    }
    const err = new Error(`WB API ${response.status}: ${text.slice(0, 200)}`);
    err.statusCode = response.status >= 400 ? response.status : 502;
    throw err;
  }
  const data = await response.json().catch(() => ({}));
  const supplyId = data?.id ?? data?.supplyId ?? data?.supply_id;
  if (!supplyId) throw new Error('WB не вернул ID поставки');
  return String(supplyId);
}

const OZON_HEADERS = (client_id, api_key) => ({
  'Client-Id': String(client_id),
  'Api-Key': String(api_key),
  'Content-Type': 'application/json',
  Accept: 'application/json'
});

function ozonIsAlreadyShippedErrorText(text) {
  const t = String(text || '');
  return t.includes('POSTING_ALREADY_SHIPPED');
}

/**
 * Перевести отправление Ozon в «Ожидает отгрузки» через ship (v4): получаем постинг, формируем packages, POST ship.
 * Нужно для заказов в статусе «Ожидает сборки» (awaiting_packaging).
 */
async function ozonShipWithPackages(config, postingNumber) {
  const pn = ozonPostingNumberFromOrderId(postingNumber) || String(postingNumber).trim();
  const { client_id, api_key } = config;
  const headers = OZON_HEADERS(client_id, api_key);
  const getResp = await fetch('https://api-seller.ozon.ru/v3/posting/fbs/get', {
    method: 'POST',
    headers,
    body: JSON.stringify({
      posting_number: String(pn),
      with: { analytics_data: false, financial_data: false }
    })
  });
  if (!getResp.ok) {
    const text = await getResp.text();
    throw new Error(`Ozon get posting ${getResp.status}: ${text.substring(0, 150)}`);
  }
  const getData = await getResp.json();
  const posting = getData?.result;
  if (!posting || !Array.isArray(posting.products) || posting.products.length === 0) {
    throw new Error(`Ozon: постинг ${pn} без товаров`);
  }
  const products = posting.products.map((p) => {
    const id = Number(p.product_id) || Number(p.sku) || 0;
    const qty = Number(p.quantity) || 1;
    return { product_id: id, quantity: qty };
  }).filter((p) => p.product_id > 0);
  if (products.length === 0) {
    throw new Error(`Ozon: не удалось получить product_id для постинга ${pn}`);
  }
  const shipResp = await fetch('https://api-seller.ozon.ru/v4/posting/fbs/ship', {
    method: 'POST',
    headers,
    body: JSON.stringify({
      posting_number: String(pn),
      packages: [{ products }]
    })
  });
  if (!shipResp.ok) {
    const text = await shipResp.text();
    // Идемпотентность: если Ozon уже считает постинг отгруженным — не ломаем процесс
    if (ozonIsAlreadyShippedErrorText(text)) return true;
    throw new Error(`Ozon ship ${shipResp.status}: ${text.substring(0, 250)}`);
  }
  return true;
}

/**
 * Перевести отправление Ozon в статус «Ожидает отгрузки» (awaiting_deliver).
 * Сначала пробуем POST /v2/posting/fbs/awaiting-delivery (для заказов уже «В сборке»/«Собран»).
 * Если Ozon вернул result: false (заказ в «Ожидает сборки»), вызываем ship (v4) с packages.
 */
async function ozonPassToAwaitingDeliver(config, postingNumber) {
  const pn = ozonPostingNumberFromOrderId(postingNumber) || String(postingNumber).trim();
  const { client_id, api_key } = config;
  const headers = OZON_HEADERS(client_id, api_key);
  const resp = await fetch('https://api-seller.ozon.ru/v2/posting/fbs/awaiting-delivery', {
    method: 'POST',
    headers,
    body: JSON.stringify({ posting_number: [String(pn)] })
  });
  const text = await resp.text();
  if (!resp.ok) {
    // Идемпотентность: часть постингов уже отгружена — считаем это успешным состоянием
    if (ozonIsAlreadyShippedErrorText(text)) return true;
    throw new Error(`Ozon awaiting-delivery ${resp.status}: ${text.substring(0, 250)}`);
  }
  let data;
  try {
    data = JSON.parse(text);
  } catch {
    throw new Error(`Ozon awaiting-delivery: неверный JSON ответ`);
  }
  if (data?.result === true) {
    return true;
  }
  // result: false — заказ, скорее всего, в «Ожидает сборки»; переводим через ship с packages
  logger.info(`[Ozon] awaiting-delivery result: false для ${pn}, пробуем ship с packages`);
  return ozonShipWithPackages(config, pn);
}

/**
 * Добавить заказы в поставку. WB — вызов PATCH на маркетплейсе; Ozon — добавить локально и перевести в «Ожидает отгрузки» на маркетплейсе.
 */
async function addOrdersToShipment(shipmentId, orderIds, { profileId = null, organizationId = null } = {}) {
  if (!Array.isArray(orderIds) || orderIds.length === 0) {
    const err = new Error('Передайте массив orderIds');
    err.statusCode = 400;
    throw err;
  }

  const shipments = await getLocalShipments();
  const ship = shipments.find(s => s.id === shipmentId);
  if (!ship) {
    const err = new Error('Поставка не найдена');
    err.statusCode = 404;
    throw err;
  }
  if (!shipmentVisibleForScope(ship, profileId, organizationId)) {
    const err = new Error('Поставка не найдена');
    err.statusCode = 404;
    throw err;
  }

  // Идемпотентность: если часть/все заказы уже есть в поставке локально — не добавляем повторно в МП.
  const existing = new Set((ship.orderIds || []).map(String));
  const uniqueRequested = Array.from(new Set(orderIds.map((o) => String(o))));
  const toAdd = uniqueRequested.filter((id) => !existing.has(String(id)));

  const code = ship.marketplace === 'wb' ? 'wildberries' : ship.marketplace;

  if (code === 'ozon') {
    let ozonConfig;
    try {
      ozonConfig = await integrationsService.getMarketplaceConfig('ozon', {
        profileId: ship.profileId ?? null,
        organizationId
      });
    } catch (_) {
      ozonConfig = null;
    }
    if (ozonConfig?.client_id && ozonConfig?.api_key) {
      const ozonErrors = [];
      // Даже если заказ уже числится в локальной поставке, повторная «На сборку» должна
      // попытаться перевести его на Ozon в «Ожидает отгрузки», иначе этикетка может быть недоступна (409).
      for (const postingNumber of uniqueRequested) {
        try {
          await ozonPassToAwaitingDeliver(ozonConfig, String(postingNumber));
          logger.info(`[Shipments Ozon] Постинг ${postingNumber} переведён в «Ожидает отгрузки»`);
        } catch (e) {
          logger.warn(`[Shipments Ozon] ship для ${postingNumber}: ${e.message}`);
          ozonErrors.push({ postingNumber: String(postingNumber), error: e.message });
        }
      }
      if (ozonErrors.length > 0) {
        const err = new Error(
          'Ozon: не удалось перевести заказы в «Ожидает отгрузки»: ' +
          ozonErrors.map((e) => `${e.postingNumber}: ${e.error}`).join('; ')
        );
        err.statusCode = 502;
        err.ozonErrors = ozonErrors;
        throw err;
      }
    }
  }

  if (code === 'wildberries') {
    const wbConfig = await getWildberriesConfigForScope(ship.profileId, { organizationId });
    if (wbConfig?.api_key) {
      // WB: всегда пытаемся назначить заказ в поставку на МП при «На сборку».
      // Даже если он уже числится в локальной поставке (toAdd пустой), на WB он мог не попасть из‑за
      // предыдущего сбоя/отсутствия ключа/ошибки сети. Повторная операция должна быть "дожимающей".
      // Если WB вернёт 409 (уже в другой поставке/статус) — это уйдёт в предупреждение на уровне контроллера.
      const toSync = uniqueRequested;

      // Для WB этикетки появляются через stickers API только когда сборочное задание в статусе confirm/complete.
      // Поэтому перед добавлением в поставку переводим заказы в confirm на стороне WB.
      if (toSync.length > 0) {
        try {
          await confirmWBOrdersForAssembly(wbConfig, toSync);
        } catch (e) {
          // Новые методы WB могут быть недоступны для части заказов (404) — не блокируем перевод в "На сборке" в ERM.
          // Дальше всё равно попробуем добавить в поставку: это зачастую и переводит заказы в нужный статус на WB.
          logger.warn(`[Shipments WB] confirm skipped: ${e?.message || String(e)}`);
        }
      }
      let supplyId = ship.externalId;
      if (!supplyId) {
        supplyId = await createWBSupply(wbConfig);
        ship.externalId = supplyId;
        ship.name = ship.name || supplyId;
        await saveLocalShipments(shipments);
        logger.info(`[Shipments WB] Created new supply ${supplyId} for shipment ${ship.id}`);
      }
      try {
        if (toSync.length > 0) {
          await addOrdersToWBSupplyBatch(wbConfig, supplyId, toSync);
        }
      } catch (e) {
        if (e.message && e.message.includes('404') && supplyId) {
          logger.warn(`[Shipments WB] Supply ${supplyId} not found (404), creating new supply and retrying`);
          const newSupplyId = await createWBSupply(wbConfig);
          ship.externalId = newSupplyId;
          ship.name = ship.name || newSupplyId;
          await saveLocalShipments(shipments);
          if (toSync.length > 0) {
            await addOrdersToWBSupplyBatch(wbConfig, newSupplyId, toSync);
          }
        } else {
          throw e;
        }
      }

      // Если мы дошли до этого места без исключения — синк с ЛК WB был выполнен (или попытка была успешной).
      // Снимаем флаг "только локально", чтобы UI не вводил в заблуждение.
      if (ship.localWbOnly === true) {
        ship.localWbOnly = false;
        await saveLocalShipments(shipments);
      }
    } else {
      logger.warn(
        '[Shipments] Wildberries: API не настроен — заказы только в локальной поставке, статус в ERM «на сборке»; ЛК WB не обновлён.'
      );
    }
  }

  // Всегда фиксируем, что заказ "привязан" к поставке локально, даже если повторно не добавляли в МП.
  uniqueRequested.forEach((o) => existing.add(String(o)));
  ship.orderIds = Array.from(existing);
  await saveLocalShipments(shipments);
  return normalizeShipment(ship);
}

/**
 * Найти локальную поставку, в которой уже есть orderId (чтобы не пытаться добавлять повторно).
 * @returns {Promise<object|null>} normalizeShipment(row) или null
 */
async function findLocalShipmentContainingOrder(marketplace, orderId, { profileId = null, organizationId = null } = {}) {
  const code = marketplace === 'wb' ? 'wildberries' : marketplace;
  const oid = String(orderId || '').trim();
  if (!oid) return null;
  const shipments = await getLocalShipments();
  const found = shipments.find((s) => {
    const m = s.marketplace === 'wb' ? 'wildberries' : s.marketplace;
    if (m !== code) return false;
    if (!shipmentVisibleForScope(s, profileId, organizationId)) return false;
    return Array.isArray(s.orderIds) && s.orderIds.some((x) => String(x) === oid);
  });
  return found ? normalizeShipment(found) : null;
}

/**
 * Добавить заказы в поставку WB (batch до 100).
 * WB API принимает только числовые assembly order id (поле id из списка заказов), не orderUid.
 * PATCH /api/marketplace/v3/supplies/{supplyId}/orders, body: { "orders": [ id1, id2, ... ] }.
 */
async function addOrdersToWBSupplyBatch(config, supplyId, orderIds) {
  const { api_key } = config;
  const agent = getFetchProxyAgent();
  const auth = wbAuthHeaderFromConfig({ api_key });
  const ids = orderIds
    .map((id) => {
      if (typeof id === 'number' && Number.isInteger(id)) return id;
      const s = String(id).trim();
      if (!/^\d+$/.test(s)) return null;
      return parseInt(s, 10);
    })
    .filter((n) => n != null);
  if (ids.length === 0) {
    const err = new Error(
      'Для Wildberries нужны числовые ID заказов (assembly order id). У заказов WB в системе должен быть сохранён числовой id из маркетплейса, а не orderUid. Запустите синхронизацию заказов WB заново.'
    );
    err.statusCode = 400;
    throw err;
  }
  const pathSuffix = `/${encodeURIComponent(supplyId)}/orders`;
  const urlsToTry = [
    // По документации FBS: добавление заказов в поставку делается через /api/marketplace/v3/supplies/{supplyId}/orders
    'https://marketplace-api.wildberries.ru/api/marketplace/v3/supplies' + pathSuffix,
    // fallback на старый путь (в некоторых окружениях встречался)
    'https://marketplace-api.wildberries.ru/api/v3/supplies' + pathSuffix
  ];
  logger.info(`[Shipments WB] Adding ${ids.length} orders to supply ${supplyId}: ${ids.slice(0, 5).join(', ')}${ids.length > 5 ? '...' : ''}`);
  for (let i = 0; i < ids.length; i += 100) {
    const chunk = ids.slice(i, i + 100);
    const body = JSON.stringify({ orders: chunk });
    let lastError;
    for (const url of urlsToTry) {
      try {
        let response;
        let text = '';
        for (let attempt = 0; attempt < 4; attempt++) {
          response = await fetch(url, {
            method: 'PATCH',
            headers: {
              Authorization: auth,
              'Content-Type': 'application/json',
              Accept: 'application/json'
            },
            body,
            ...(agent && { agent })
          });
          if (response.ok) break;
          if (response.status === 429 && attempt < 3) {
            const waitMs = retryAfterMsFromResponse(response, 5000 * (attempt + 1));
            logger.warn(
              `[Shipments WB] rate limited 429 (add orders), retry in ${Math.round(waitMs / 1000)}s... supply=${supplyId}`
            );
            await sleep(waitMs);
            continue;
          }
          break;
        }

        text = await response.text();
        if (response.ok) {
          if (text) {
            try {
              const data = JSON.parse(text);
              if (data?.errors?.length) {
                logger.warn(`[Shipments WB] Partial errors from WB: ${JSON.stringify(data.errors)}`);
              }
            } catch (_) {}
          }
          lastError = null;
          break;
        }
        // WB часто возвращает JSON с деталями по конкретным заказам; сохраняем по возможности.
        let parsed = null;
        try {
          parsed = text ? JSON.parse(text) : null;
        } catch (_) {}
        lastError = { status: response.status, text: text.slice(0, 500), parsed };
        if (response.status !== 404) break;
      } catch (networkErr) {
        lastError = { status: 'network', text: (networkErr?.message || String(networkErr)).slice(0, 150) };
        logger.warn(`[Shipments WB] Request failed for ${url.split('/').slice(0, 3).join('/')}: ${lastError.text}`);
      }
    }
    if (lastError) {
      logger.error(
        `[Shipments WB] PATCH supplies/orders failed: ${lastError.status} ${lastError.text}`
      );

      if (lastError.status === 429) {
        const err = new Error('WB временно ограничил запросы (429). Подождите 30–60 секунд и нажмите «Собрать» ещё раз.');
        err.statusCode = 429;
        throw err;
      }

      // 409: заказы не удалось назначить поставке (часто — уже в другой поставке или статус не подходит).
      if (lastError.status === 409) {
        const errors = Array.isArray(lastError.parsed) ? lastError.parsed : (lastError.parsed?.errors || null);
        const failedIds =
          Array.isArray(errors)
            ? errors.flatMap((e) => (Array.isArray(e?.data) ? e.data : [])).map((x) => String(x)).filter(Boolean)
            : [];
        const sample = failedIds.slice(0, 12).join(', ');
        const err = new Error(
          `WB: не удалось добавить заказы в поставку (409). Обычно это значит, что часть заказов уже привязана к другой поставке WB или находится в неподходящем статусе. ` +
          (failedIds.length ? `Проблемные заказы: ${sample}${failedIds.length > 12 ? '…' : ''}. ` : '') +
          `Откройте ЛК WB → Поставки и проверьте, не назначены ли эти заказы другой поставке, затем попробуйте ещё раз.`
        );
        err.statusCode = 409;
        err.wbErrors = errors;
        err.failedOrderIds = failedIds;
        throw err;
      }

      const err = new Error(`WB: не удалось добавить заказы в поставку. ${lastError.status}: ${lastError.text}`);
      err.statusCode =
        lastError.status === 400 ? 400 : (lastError.status === 404 ? 404 : 502);
      throw err;
    }
  }
}

/**
 * Удалить заказы из поставки WB.
 * DELETE /api/v3/supplies/{supplyId}/orders/{orderId}
 */
async function removeOrdersFromWBSupply(config, supplyId, orderIds) {
  const { api_key } = config;
  const agent = getFetchProxyAgent();
  const auth = wbAuthHeaderFromConfig({ api_key });
  const ids = (Array.isArray(orderIds) ? orderIds : [])
    .map((id) => {
      if (typeof id === 'number' && Number.isInteger(id)) return id;
      const s = String(id).trim();
      if (!/^\d+$/.test(s)) return null;
      return parseInt(s, 10);
    })
    .filter((n) => n != null);
  if (ids.length === 0) return;

  for (const oid of ids) {
    const url = `https://marketplace-api.wildberries.ru/api/v3/supplies/${encodeURIComponent(supplyId)}/orders/${encodeURIComponent(String(oid))}`;
    const response = await fetch(url, {
      method: 'DELETE',
      headers: {
        Authorization: auth,
        Accept: 'application/json'
      },
      ...(agent && { agent })
    });
    const text = await response.text();
    if (!response.ok && response.status !== 404) {
      logger.error(`[Shipments WB] DELETE supply order failed: ${response.status} ${text.slice(0, 300)}`);
      const err = new Error(`WB: не удалось удалить заказ ${oid} из поставки. ${response.status}: ${text.slice(0, 300)}`);
      err.statusCode = response.status === 400 ? 400 : (response.status === 403 ? 403 : 502);
      throw err;
    }
  }
}

/**
 * Вернуть абсолютный путь к файлу QR-стикера поставки (для отдачи в HTTP). Если нет — null.
 */
async function getQrStickerFilePath(shipmentId, { profileId = null, organizationId = null } = {}) {
  const shipments = await getLocalShipments();
  const ship = shipments.find(s => s.id === shipmentId);
  if (!ship?.qrStickerPath) return null;
  if (!shipmentVisibleForScope(ship, profileId, organizationId)) return null;
  const abs = join(DATA_DIR, ship.qrStickerPath);
  return fs.existsSync(abs) ? abs : null;
}

/**
 * Получить поставку по id (только локальные поставки из нашего хранилища).
 * Для просмотра заказов и удаления заказов из поставки.
 */
async function getShipmentById(shipmentId, { profileId = null, organizationId = null } = {}) {
  const shipments = await getLocalShipments();
  const ship = shipments.find(s => s.id === shipmentId);
  if (!ship) return null;
  if (!shipmentVisibleForScope(ship, profileId, organizationId)) return null;
  return normalizeShipment(ship);
}

/**
 * Удалить заказы из поставки (только локальная запись; для WB заказ на маркетплейсе остаётся в поставке).
 * Только для локальных поставок (id вида ship-*). Не закрытые поставки можно редактировать.
 */
async function removeOrdersFromShipment(shipmentId, orderIdsToRemove, { profileId = null, organizationId = null } = {}) {
  if (!Array.isArray(orderIdsToRemove) || orderIdsToRemove.length === 0) {
    const err = new Error('Передайте массив orderIds для удаления');
    err.statusCode = 400;
    throw err;
  }
  const shipments = await getLocalShipments();
  const ship = shipments.find(s => s.id === shipmentId);
  if (!ship) {
    const err = new Error('Поставка не найдена');
    err.statusCode = 404;
    throw err;
  }
  if (!shipmentVisibleForScope(ship, profileId, organizationId)) {
    const err = new Error('Поставка не найдена');
    err.statusCode = 404;
    throw err;
  }
  if (ship.closed) {
    const err = new Error('Нельзя удалить заказ из закрытой поставки');
    err.statusCode = 400;
    throw err;
  }

  // Если это WB и поставка уже создана на WB — удаляем и на маркетплейсе тоже.
  if (ship.marketplace === 'wildberries' && ship.externalId) {
    const wbConfig = await getWildberriesConfigForScope(ship.profileId, { organizationId });
    if (!wbConfig?.api_key) {
      const err = new Error('Wildberries API не настроен');
      err.statusCode = 400;
      throw err;
    }
    await removeOrdersFromWBSupply(wbConfig, ship.externalId, orderIdsToRemove);
  }

  const toRemove = new Set(orderIdsToRemove.map(id => String(id)));
  const had = ship.orderIds || [];
  ship.orderIds = had.filter(id => !toRemove.has(String(id)));
  await saveLocalShipments(shipments);
  return normalizeShipment(ship);
}

/**
 * Убрать заказ из всех незакрытых локальных поставок (и с WB-поставки, если привязана).
 * @returns {Promise<string[]>} id поставок, из которых удалили
 */
async function removeOrderFromOpenShipments(marketplace, orderId, { profileId = null, organizationId = null } = {}) {
  const code = marketplace === 'wb' ? 'wildberries' : String(marketplace || '').toLowerCase();
  const oid = String(orderId || '').trim();
  if (!oid || !code) return [];

  const shipments = await getLocalShipments();
  const removedFrom = [];

  for (const ship of shipments) {
    if (ship.closed) continue;
    const m = ship.marketplace === 'wb' ? 'wildberries' : ship.marketplace;
    if (m !== code) continue;
    if (!shipmentVisibleForScope(ship, profileId, organizationId)) continue;
    const ids = (ship.orderIds || []).map(String);
    if (!ids.includes(oid)) continue;
    try {
      await removeOrdersFromShipment(ship.id, [oid], { profileId, organizationId });
      removedFrom.push(ship.id);
    } catch (e) {
      logger.warn(`[Shipments] removeOrderFromOpenShipments ${ship.id} / ${oid}: ${e?.message || e}`);
    }
  }

  return removedFrom;
}

const shipmentsService = {
  getShipments,
  getShipmentById,
  createShipment,
  addOrdersToShipment,
  removeOrdersFromShipment,
  removeOrderFromOpenShipments,
  getOrCreateOpenShipment,
  findLocalShipmentContainingOrder,
  getShipmentClosePreview,
  closeShipment,
  reapplyStockForShipment,
  getQrStickerFilePath,
  getMarketplaces: () => MARKETPLACES
};

export default shipmentsService;
