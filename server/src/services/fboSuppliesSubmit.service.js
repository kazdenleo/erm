/**
 * Отправка состава упакованных грузомест на маркетплейс (FBO).
 */

import { query } from '../config/database.js';
import integrationsService from './integrations.service.js';
import fboSuppliesService from './fboSupplies.service.js';
import fboSuppliesPackingService from './fboSuppliesPacking.service.js';
import {
  assertPackingReadyForMarketplaceSubmit,
  evaluateSupplyPacking,
} from '../utils/fboSupplyPackingCheck.js';

function normalizeMp(marketplace) {
  const m = String(marketplace || 'ozon').trim().toLowerCase();
  if (m === 'wb' || m === 'wildberries') return 'wb';
  if (m === 'ym' || m === 'yandex') return 'ym';
  return 'ozon';
}

function mpLabelRu(mp) {
  if (mp === 'wb') return 'Wildberries';
  if (mp === 'ym') return 'Яндекс Маркет';
  return 'Ozon';
}

async function markSupplyReadyForShipment(supplyId, { profileId } = {}) {
  await query(
    `UPDATE fbo_supplies
     SET status = 'ready_for_supply', updated_at = CURRENT_TIMESTAMP
     WHERE id = $1`,
    [supplyId]
  );
  return fboSuppliesService.getById(supplyId, { profileId });
}

function formatOzonExpiry(value) {
  if (value == null || value === '') return null;
  const s = String(value);
  if (/^\d{4}-\d{2}-\d{2}/.test(s)) return s.slice(0, 10);
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) return null;
  return d.toISOString().slice(0, 10);
}

function ozonCargoType(cargoKind) {
  return cargoKind === 'pallet' ? 'PALLET' : 'BOX';
}

function extractOzonOperationId(data) {
  const root = data?.result ?? data ?? {};
  return (
    root.operation_id ??
    root.operationId ??
    root.id ??
    data?.operation_id ??
    data?.operationId ??
    null
  );
}

function extractOzonCreateInfoStatus(data) {
  const root = data?.result ?? data ?? {};
  const status = String(root.status ?? root.state ?? '').toUpperCase();
  const errors = root.errors ?? root.error ?? null;
  return { status, errors, raw: root };
}

async function pollOzonCargoesCreateInfo(operationId, ozonApiOpts, { maxAttempts = 12 } = {}) {
  for (let i = 0; i < maxAttempts; i++) {
    if (i > 0) {
      await new Promise((r) => setTimeout(r, 1500));
    }
    const data = await integrationsService._ozonApiPost(
      '/v2/cargoes/create/info',
      { operation_id: operationId },
      ozonApiOpts
    );
    const info = extractOzonCreateInfoStatus(data);
    if (info.status === 'SUCCESS' || info.status === 'COMPLETED' || info.status === 'DONE') {
      return { ok: true, status: info.status, data: info.raw };
    }
    if (info.status === 'FAILED' || info.status === 'ERROR') {
      const err = new Error(
        typeof info.errors === 'string'
          ? info.errors
          : info.errors?.message || 'Ozon отклонил установку грузомест'
      );
      err.statusCode = 400;
      err.details = info.raw;
      throw err;
    }
  }
  return { ok: true, status: 'PENDING', message: 'Запрос принят, проверьте статус в личном кабинете Ozon' };
}

function resolveOzonCargoItemBarcode(line) {
  const fromProduct =
    line?.productBarcode != null ? String(line.productBarcode).trim() : '';
  if (fromProduct) return fromProduct;
  const fromItem = line?.barcode != null ? String(line.barcode).trim() : '';
  return fromItem;
}

/** ID грузомест Ozon (cargo_id) для поставки — из /v1/cargoes/get. */
export function parseOzonSupplyCargoIds(data, ozonSupplyId) {
  const supplies = data?.result?.supply ?? data?.supply ?? [];
  const list = Array.isArray(supplies) ? supplies : [];
  const match =
    list.find((s) => String(s?.supply_id ?? '') === String(ozonSupplyId)) ?? list[0];
  const cargoes = match?.cargoes ?? [];
  return cargoes
    .map((c) => c?.cargo_id)
    .filter((id) => id != null && String(id).trim() !== '')
    .map((id) => String(id).trim());
}

export function extractOzonCargoIdMapping(pollData) {
  const root = pollData?.data ?? pollData?.raw ?? pollData ?? {};
  const cargoes = root?.cargoes ?? root?.result?.cargoes ?? [];
  const mapping = new Map();
  for (const entry of cargoes || []) {
    const key = entry?.key != null ? String(entry.key).trim() : '';
    const cargoId = entry?.value?.cargo_id ?? entry?.cargo_id;
    if (key && cargoId != null && String(cargoId).trim() !== '') {
      mapping.set(key, String(cargoId).trim());
    }
  }
  return mapping;
}

function resolveOzonCargoKey(ermBarcode, ozonCargoIds) {
  const code = ermBarcode != null ? String(ermBarcode).trim() : '';
  if (!code) return code;
  if (!ozonCargoIds?.length) return code;
  const ozonSet = new Set(ozonCargoIds.map((id) => String(id).trim()));
  if (ozonSet.has(code)) return code;
  return null;
}

function buildCargoKeyMismatchError(ermBarcodes, ozonCargoIds) {
  const err = new Error(
    `Штрихкоды грузомест в сборке не совпадают с Ozon. В Ozon: ${ozonCargoIds.join(', ')}. В сборке: ${ermBarcodes.join(', ')}. Укажите в сборке те же номера, что в личном кабинете Ozon (колонка «ID грузоместа»).`
  );
  err.statusCode = 400;
  err.code = 'OZON_CARGO_BARCODE_MISMATCH';
  err.details = { ozonCargoIds, ermBarcodes };
  return err;
}

async function fetchOzonSupplyCargoIds(ozonSupplyId, ozonApiOpts) {
  try {
    const data = await integrationsService._ozonApiPost(
      '/v1/cargoes/get',
      { supply_ids: [String(ozonSupplyId)] },
      ozonApiOpts
    );
    return parseOzonSupplyCargoIds(data, ozonSupplyId);
  } catch {
    return [];
  }
}

async function syncCargoBarcodesFromOzon(supplyId, mapping) {
  for (const [localKey, ozonCargoId] of mapping) {
    if (!localKey || !ozonCargoId || localKey === ozonCargoId) continue;
    await query(
      `UPDATE fbo_supply_cargo_units
       SET barcode = $1, updated_at = CURRENT_TIMESTAMP
       WHERE fbo_supply_id = $2 AND TRIM(barcode) = $3`,
      [ozonCargoId, supplyId, localKey]
    );
  }
}

export function buildOzonCargoesBody(supply, packing, { ozonCargoIds = null } = {}) {
  const ozonSupplyId = supply.externalSupplyId;
  if (!ozonSupplyId) {
    const err = new Error('У поставки не указан ID поставки на маркетплейсе (поле «ID поставки»)');
    err.statusCode = 400;
    throw err;
  }

  const cargoUnits = packing?.cargoUnits || [];
  if (!cargoUnits.length) {
    const err = new Error('Нет грузомест — сначала выполните сборку');
    err.statusCode = 400;
    throw err;
  }

  const packedUnits = cargoUnits.filter((c) => (c.contents || []).length > 0);
  const ermBarcodes = packedUnits
    .map((c) => (c.barcode != null ? String(c.barcode).trim() : ''))
    .filter(Boolean);
  const ozonIds = Array.isArray(ozonCargoIds)
    ? ozonCargoIds.map((id) => String(id).trim()).filter(Boolean)
    : null;

  if (ozonIds?.length) {
    const unresolved = ermBarcodes.filter((code) => !ozonIds.includes(code));
    if (unresolved.length) {
      throw buildCargoKeyMismatchError(ermBarcodes, ozonIds);
    }
    if (ermBarcodes.length !== ozonIds.length) {
      const err = new Error(
        `Количество грузомест в сборке (${ermBarcodes.length}) не совпадает с Ozon (${ozonIds.length}). Проверьте состав в личном кабинете Ozon.`
      );
      err.statusCode = 400;
      throw err;
    }
  }

  const cargoes = [];
  for (const cargo of packedUnits) {
    const lines = cargo.contents || [];
    if (!lines.length) continue;

    const items = [];
    for (const line of lines) {
      const productBarcode = resolveOzonCargoItemBarcode(line);
      if (!productBarcode) {
        const err = new Error(
          `У товара «${line.productName || line.sku || 'без названия'}» не указан штрихкод — Ozon принимает состав грузомест только по ШК товара`
        );
        err.statusCode = 400;
        throw err;
      }
      const item = {
        barcode: productBarcode,
        quantity: Number(line.quantity) || 0,
      };
      const expiry = formatOzonExpiry(line.expiresAt);
      if (expiry) item.expires_at = expiry;
      if (item.quantity > 0) items.push(item);
    }

    if (!items.length) continue;

    const barcode = cargo.barcode != null ? String(cargo.barcode).trim() : '';
    if (!barcode) {
      const err = new Error('У грузоместа не указан штрихкод (ШК ГМ)');
      err.statusCode = 400;
      throw err;
    }

    const cargoKey = resolveOzonCargoKey(barcode, ozonIds) ?? barcode;
    if (ozonIds?.length && !ozonIds.includes(cargoKey)) {
      throw buildCargoKeyMismatchError(ermBarcodes, ozonIds);
    }

    cargoes.push({
      key: cargoKey,
      value: {
        type: ozonCargoType(cargo.cargoKind),
        items,
      },
    });
  }

  if (!cargoes.length) {
    const err = new Error('Нет упакованных товаров в грузоместах');
    err.statusCode = 400;
    throw err;
  }

  const supplyIdNum = Number(ozonSupplyId);
  return {
    supply_id: Number.isFinite(supplyIdNum) ? supplyIdNum : ozonSupplyId,
    cargoes,
  };
}

class FboSuppliesSubmitService {
  async submitPackingToMarketplace(supplyId, { profileId } = {}) {
    const supply = await fboSuppliesService.getById(supplyId, { profileId });
    const mp = normalizeMp(supply.marketplace);
    const mpLabel = mpLabelRu(mp);

    if (supply.status !== 'packed') {
      const err = new Error(
        'Отправить состав грузомест на маркетплейс можно только в статусе «Упакован»'
      );
      err.statusCode = 400;
      throw err;
    }

    assertPackingReadyForMarketplaceSubmit(await evaluateSupplyPacking(supplyId));

    const packing = await fboSuppliesPackingService.getPackingState(supplyId, { profileId });
    const cargoCount = (packing?.cargoUnits || []).filter((c) => (c.contents || []).length > 0).length;

    if (mp === 'wb') {
      const updatedSupply = await markSupplyReadyForShipment(supplyId, { profileId });
      return {
        marketplace: 'wb',
        cargoCount,
        supply: updatedSupply,
        supplyStatus: updatedSupply.status,
        message: `Сборка зафиксирована (${cargoCount} грузомест). Статус: «Готов к отгрузке». Выгрузите Excel грузомест и загрузите файл в личном кабинете ${mpLabel}.`,
      };
    }

    if (mp === 'ym') {
      const updatedSupply = await markSupplyReadyForShipment(supplyId, { profileId });
      return {
        marketplace: 'ym',
        cargoCount,
        supply: updatedSupply,
        supplyStatus: updatedSupply.status,
        message: `Сборка зафиксирована (${cargoCount} грузомест). Статус: «Готов к отгрузке». Укажите состав грузомест в личном кабинете ${mpLabel}.`,
      };
    }

    const ozonCfg = await integrationsService.getMarketplaceConfig('ozon', {
      profileId,
      organizationId: supply.organizationId ?? null,
    });
    const clientId = ozonCfg?.client_id ?? ozonCfg?.clientId;
    const apiKey = ozonCfg?.api_key ?? ozonCfg?.apiKey;
    if (!clientId || !apiKey) {
      const err = new Error(
        'Не настроены Client ID и API Key Ozon для организации поставки. Укажите их в «Интеграции».'
      );
      err.statusCode = 400;
      throw err;
    }

    const ozonApiOpts = {
      profileId,
      organizationId: supply.organizationId ?? null,
      ozonOverride: ozonCfg,
    };

    const ozonSupplyId = supply.externalSupplyId;
    const ozonCargoIds = await fetchOzonSupplyCargoIds(ozonSupplyId, ozonApiOpts);
    const body = buildOzonCargoesBody(supply, packing, { ozonCargoIds });

    const createData = await integrationsService._ozonApiPost('/v1/cargoes/create', body, ozonApiOpts);
    const operationId = extractOzonOperationId(createData);

    let pollResult = null;
    if (operationId) {
      pollResult = await pollOzonCargoesCreateInfo(operationId, ozonApiOpts);
    }

    const cargoIdMapping = extractOzonCargoIdMapping(pollResult);
    if (cargoIdMapping.size) {
      await syncCargoBarcodesFromOzon(supplyId, cargoIdMapping);
    }

    const updatedSupply = await markSupplyReadyForShipment(supplyId, { profileId });

    return {
      marketplace: 'ozon',
      operationId,
      cargoCount: body.cargoes.length,
      poll: pollResult,
      supply: updatedSupply,
      supplyStatus: updatedSupply.status,
      message:
        pollResult?.message ||
        (pollResult?.ok
          ? `Грузоместа отправлены в ${mpLabel} (${body.cargoes.length} шт.). Статус: «Готов к отгрузке».`
          : `Запрос на установку грузомест отправлен в ${mpLabel}. Статус: «Готов к отгрузке».`),
    };
  }
}

export default new FboSuppliesSubmitService();
