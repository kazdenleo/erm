/**
 * Отправка состава упакованных грузомест на маркетплейс (FBO).
 */

import { query } from '../config/database.js';
import integrationsService from './integrations.service.js';
import fboSuppliesService from './fboSupplies.service.js';
import fboSuppliesPackingService from './fboSuppliesPacking.service.js';
import fboSuppliesImportService from './fboSuppliesImport.service.js';
import {
  assertPackingReadyForMarketplaceSubmit,
  evaluateSupplyPacking,
} from '../utils/fboSupplyPackingCheck.js';
import logger from '../utils/logger.js';

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
  const cargoes = root.cargoes ?? root.result?.cargoes ?? [];
  return { status, errors, raw: root, cargoes };
}

async function pollOzonCargoesCreateInfo(operationId, ozonApiOpts, { maxAttempts = 20 } = {}) {
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
      return { ok: true, status: info.status, data: info.raw, cargoes: info.cargoes };
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

async function verifyOzonCargoesSubmitResult(submitPlan, ermBarcodes, ozonSupplyId, ozonApiOpts, pollResult) {
  assertOzonCargoesCreateCompleted(pollResult);
  const cargoIdMapping = extractOzonCargoIdMapping(pollResult);
  assertOzonPollCargoIdsMatchPlan(submitPlan, cargoIdMapping);
  const ozonCargoesAfter = await fetchOzonSupplyCargoes(ozonSupplyId, ozonApiOpts);
  assertPlanCargoIdsStillPresent(submitPlan, ozonCargoesAfter);
  assertNoExtraOzonCargoesAfterSubmit(ermBarcodes, ozonCargoesAfter);
  return ozonCargoesAfter;
}

function resolveOzonCargoItemBarcode(line) {
  const fromProduct =
    line?.productBarcode != null ? String(line.productBarcode).trim() : '';
  if (fromProduct) return fromProduct;
  const fromItem = line?.barcode != null ? String(line.barcode).trim() : '';
  return fromItem;
}

/** Штрихкод грузоместа из сборки ERM. */
export function ozonCargoKeyFromUnit(cargo) {
  return cargo?.barcode != null ? String(cargo.barcode).trim() : '';
}

function parseOzonSupplyList(data, ozonSupplyId) {
  const supplies = data?.result?.supply ?? data?.supply ?? [];
  const list = Array.isArray(supplies) ? supplies : [];
  return list.find((s) => String(s?.supply_id ?? '') === String(ozonSupplyId)) ?? list[0] ?? null;
}

export function parseOzonSupplyCargoes(data, ozonSupplyId) {
  const match = parseOzonSupplyList(data, ozonSupplyId);
  const cargoes = match?.cargoes ?? [];
  return (Array.isArray(cargoes) ? cargoes : [])
    .map((c) => ({
      cargoId: c?.cargo_id != null ? String(c.cargo_id).trim() : '',
      contentType: c?.content_type != null ? String(c.content_type).trim().toUpperCase() : '',
      bundleId: c?.bundle_id != null ? String(c.bundle_id).trim() : '',
      type: c?.type != null ? String(c.type).trim().toUpperCase() : '',
    }))
    .filter((c) => c.cargoId);
}

export function parseOzonSupplyCargoIds(data, ozonSupplyId) {
  return parseOzonSupplyCargoes(data, ozonSupplyId).map((c) => c.cargoId);
}

export async function fetchOzonSupplyCargoes(ozonSupplyId, ozonApiOpts) {
  const data = await integrationsService._ozonApiPost(
    '/v1/cargoes/get',
    { supply_ids: [String(ozonSupplyId)] },
    ozonApiOpts
  );
  return parseOzonSupplyCargoes(data, ozonSupplyId);
}

export async function fetchOzonSupplyCargoIds(ozonSupplyId, ozonApiOpts) {
  const cargoes = await fetchOzonSupplyCargoes(ozonSupplyId, ozonApiOpts);
  return cargoes.map((c) => c.cargoId);
}

export function isOzonCargoFilled(cargo) {
  return (
    cargo?.contentType === 'MONO' ||
    cargo?.contentType === 'MIX' ||
    Boolean(cargo?.bundleId)
  );
}

/** Грузоместа Ozon, сопоставленные со ШК из сборки ERM (пустые и уже заполненные). */
export function resolveOzonCargoesForSubmit(ozonCargoes, ermBarcodes) {
  const erm = (ermBarcodes || []).map((id) => String(id).trim()).filter(Boolean);
  const ozonById = new Map(
    (ozonCargoes || [])
      .filter((c) => c?.cargoId)
      .map((c) => [c.cargoId, c])
  );
  const matched = erm.map((barcode) => ozonById.get(barcode)).filter(Boolean);
  if (matched.length !== erm.length) {
    const found = new Set(matched.map((c) => c.cargoId));
    const missing = erm.filter((code) => !found.has(code));
    const err = new Error(
      `Штрихкоды грузомест в сборке не найдены в Ozon: ${missing.join(', ')}. Отсканируйте актуальные этикетки из личного кабинета Ozon.`
    );
    err.statusCode = 400;
    err.code = 'OZON_CARGO_BARCODE_MISMATCH';
    throw err;
  }
  return matched.sort((a, b) =>
    a.cargoId.localeCompare(b.cargoId, undefined, { numeric: true })
  );
}

export function detectOzonCargoSubmitMode(ozonCargoesForSubmit) {
  const filled = (ozonCargoesForSubmit || []).some(isOzonCargoFilled);
  return filled ? 'update' : 'create';
}

export function findExtraOzonCargoes(ozonCargoes, ermBarcodes) {
  const ermSet = new Set((ermBarcodes || []).map((id) => String(id).trim()).filter(Boolean));
  return (ozonCargoes || [])
    .map((c) => c.cargoId)
    .filter((id) => id && !ermSet.has(id));
}

export function resolveOzonDeleteCurrentVersion(ozonCargoes) {
  // false — Ozon ДОБАВЛЯЕТ грузоместа к существующим; true — заменяет весь состав поставки.
  return (ozonCargoes || []).length > 0;
}

export function assertOzonCargoesCreateCompleted(pollResult) {
  if (!pollResult?.ok) {
    const err = new Error('Ozon не принял установку грузомест');
    err.statusCode = 400;
    throw err;
  }
  if (pollResult.status === 'PENDING') {
    const err = new Error(
      'Ozon не подтвердил установку грузомест вовремя. Проверьте личный кабинет — состав мог не сохраниться.'
    );
    err.statusCode = 400;
    err.code = 'OZON_CARGO_CREATE_PENDING';
    throw err;
  }
}

export function assertNoExtraOzonCargoesAfterSubmit(ermBarcodes, ozonCargoesAfter) {
  const ermSet = new Set((ermBarcodes || []).map((id) => String(id).trim()).filter(Boolean));
  const extra = (ozonCargoesAfter || [])
    .map((c) => c.cargoId)
    .filter((id) => id && !ermSet.has(id));
  if (!extra.length) return;
  const err = new Error(
    `Ozon создал дополнительные грузоместа: ${extra.join(', ')}. Состав мог задвоиться — удалите лишние грузоместа в личном кабинете Ozon.`
  );
  err.statusCode = 400;
  err.code = 'OZON_EXTRA_CARGOES_CREATED';
  err.details = { extraOzonCargoIds: extra, ermBarcodes: [...ermSet] };
  throw err;
}

export function extractOzonCargoIdMapping(pollData) {
  const cargoes =
    pollData?.cargoes ??
    pollData?.data?.cargoes ??
    pollData?.raw?.cargoes ??
    pollData?.result?.cargoes ??
    [];
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

function packedCargoUnits(packing) {
  return (packing?.cargoUnits || [])
    .filter((c) => (c.contents || []).length > 0)
    .sort((a, b) => Number(a.id) - Number(b.id));
}

function packedCargoBarcodes(packing) {
  return packedCargoUnits(packing).map((c) => ozonCargoKeyFromUnit(c)).filter(Boolean);
}

/**
 * Сопоставляем ШК ERM с cargo_id Ozon; в API key = cargo_id (номер на этикетке).
 */
export function buildOzonCargoSubmitPlan(packing, ozonCargoesForSubmit) {
  const packedUnits = packedCargoUnits(packing);
  const ermBarcodes = packedUnits.map((u) => ozonCargoKeyFromUnit(u)).filter(Boolean);

  assertOzonCargoBarcodesMatchExisting(
    ermBarcodes,
    (ozonCargoesForSubmit || []).map((c) => c.cargoId)
  );

  const ozonSorted = resolveOzonCargoesForSubmit(ozonCargoesForSubmit, ermBarcodes);

  const ozonById = new Map(ozonSorted.map((c) => [c.cargoId, c]));
  const pairs = packedUnits.map((unit) => {
    const barcode = ozonCargoKeyFromUnit(unit);
    const ozonCargo = ozonById.get(barcode);
    if (!ozonCargo) {
      const err = new Error(`Не удалось сопоставить грузоместо ERM «${barcode}» с Ozon`);
      err.statusCode = 400;
      throw err;
    }
    return { unit, ozonCargo };
  });

  pairs.sort((a, b) =>
    a.ozonCargo.cargoId.localeCompare(b.ozonCargo.cargoId, undefined, { numeric: true })
  );

  const mode = detectOzonCargoSubmitMode(ozonSorted);

  return pairs.map((pair) => ({
    requestKey: pair.ozonCargo.cargoId,
    ozonCargoId: pair.ozonCargo.cargoId,
    ermBarcode: ozonCargoKeyFromUnit(pair.unit),
    unit: pair.unit,
    mode,
  }));
}

/**
 * Проверяем, что ШК в сборке ERM совпадают с cargo_id в Ozon.
 */
export function assertOzonCargoBarcodesMatchExisting(ermBarcodes, ozonCargoIds) {
  const ozonIds = (ozonCargoIds || []).map((id) => String(id).trim()).filter(Boolean);
  if (!ozonIds.length) {
    const err = new Error(
      'В Ozon ещё нет грузомест для этой поставки. Сначала создайте их в личном кабинете Ozon (вкладка «Грузоместа»), распечатайте этикетки и отсканируйте штрихкоды в сборку ERM.'
    );
    err.statusCode = 400;
    err.code = 'OZON_CARGO_NOT_CREATED';
    throw err;
  }

  const erm = [...ermBarcodes];
  if (erm.length !== ozonIds.length) {
    const err = new Error(
      `Количество грузомест в сборке (${erm.length}) не совпадает с Ozon (${ozonIds.length}). Проверьте грузоместа в личном кабинете Ozon.`
    );
    err.statusCode = 400;
    throw err;
  }

  const ozonSet = new Set(ozonIds);
  const unknown = erm.filter((code) => !ozonSet.has(code));
  if (unknown.length) {
    const err = new Error(
      `Штрихкоды грузомест в сборке не найдены в Ozon. В Ozon: ${ozonIds.join(', ')}. В сборке: ${erm.join(', ')}. Отсканируйте в сборку актуальные этикетки из личного кабинета Ozon.`
    );
    err.statusCode = 400;
    err.code = 'OZON_CARGO_BARCODE_MISMATCH';
    err.details = { ozonCargoIds: ozonIds, ermBarcodes: erm };
    throw err;
  }
}

export function assertOzonPollCargoIdsMatchPlan(plan, mapping) {
  const mismatches = [];
  for (const entry of plan) {
    const assigned = mapping.get(entry.requestKey);
    if (!assigned) continue;
    if (assigned !== entry.ozonCargoId) {
      mismatches.push(`${entry.ermBarcode} (key ${entry.requestKey}) → ${assigned}`);
    }
  }
  if (!mismatches.length) return;
  const err = new Error(
    `Ozon присвоил другие ID грузомест: ${mismatches.join(', ')}. Состав не сохранён — проверьте личный кабинет Ozon.`
  );
  err.statusCode = 400;
  err.code = 'OZON_CARGO_ID_CHANGED';
  err.details = { mismatches, plan, mapping: Object.fromEntries(mapping) };
  throw err;
}

export function assertPlanCargoIdsStillPresent(plan, ozonCargoesAfter) {
  const afterSet = new Set(
    (ozonCargoesAfter || [])
      .map((c) => (typeof c === 'string' ? c : c?.cargoId))
      .filter(Boolean)
      .map(String)
  );
  const missing = (plan || []).filter((entry) => !afterSet.has(String(entry.ozonCargoId)));
  if (!missing.length) return;
  const err = new Error(
    `Ozon изменил номера грузомест после отправки. Не найдены: ${missing.map((m) => m.ozonCargoId).join(', ')}. Состав мог не сохраниться — проверьте личный кабинет.`
  );
  err.statusCode = 400;
  err.code = 'OZON_CARGO_ID_CHANGED';
  err.details = { missing: missing.map((m) => m.ozonCargoId), after: [...afterSet] };
  throw err;
}

export function buildOzonCargoesBody(supply, packing, { ozonSupplyId, submitPlan, deleteCurrentVersion = false } = {}) {
  const supplyIdRaw = ozonSupplyId ?? supply.externalSupplyId;
  if (!supplyIdRaw) {
    const err = new Error('У поставки не указан ID поставки на маркетплейсе (поле «ID поставки»)');
    err.statusCode = 400;
    throw err;
  }

  const plan = submitPlan ?? buildOzonCargoSubmitPlan(packing, []);
  if (!plan.length) {
    const err = new Error('Нет грузомест — сначала выполните сборку');
    err.statusCode = 400;
    throw err;
  }

  const cargoes = [];
  for (const entry of plan) {
    const lines = entry.unit.contents || [];
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

    cargoes.push({
      key: entry.requestKey,
      value: {
        type: ozonCargoType(entry.unit.cargoKind),
        items,
      },
    });
  }

  if (!cargoes.length) {
    const err = new Error('Нет упакованных товаров в грузоместах');
    err.statusCode = 400;
    throw err;
  }

  const supplyIdNum = Number(supplyIdRaw);
  return {
    supply_id: Number.isFinite(supplyIdNum) ? supplyIdNum : supplyIdRaw,
    // true — заменить весь состав (иначе Ozon добавляет новые ГМ); key = cargo_id
    delete_current_version: Boolean(deleteCurrentVersion),
    cargoes,
  };
}

class FboSuppliesSubmitService {
  async submitPackingToMarketplace(supplyId, { profileId } = {}) {
    const supply = await fboSuppliesService.getById(supplyId, { profileId });
    const mp = normalizeMp(supply.marketplace);
    const mpLabel = mpLabelRu(mp);

    const canSubmitOzonPacking =
      supply.status === 'packed' || supply.status === 'ready_for_supply';
    if (mp === 'ozon' ? !canSubmitOzonPacking : supply.status !== 'packed') {
      const err = new Error(
        mp === 'ozon'
          ? 'Отправить или обновить состав грузомест на Ozon можно в статусе «Упакован» или «Готов к отгрузке»'
          : 'Отправить состав грузомест на маркетплейс можно только в статусе «Упакован»'
      );
      err.statusCode = 400;
      throw err;
    }

    assertPackingReadyForMarketplaceSubmit(await evaluateSupplyPacking(supplyId));

    const packing = await fboSuppliesPackingService.getPackingState(supplyId, { profileId });
    const cargoCount = packedCargoUnits(packing).length;

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

    const { supplyId: ozonSupplyId } = await fboSuppliesImportService.resolveOzonSupplyApiIds(
      supplyId,
      { profileId }
    );

    const ozonCargoes = await fetchOzonSupplyCargoes(ozonSupplyId, ozonApiOpts);
    const submitPlan = buildOzonCargoSubmitPlan(packing, ozonCargoes);
    const submitMode = submitPlan[0]?.mode ?? 'create';
    const ermBarcodes = submitPlan.map((p) => p.ermBarcode);
    const cargoIdsBefore = submitPlan.map((p) => p.ozonCargoId);

    const deleteCurrentVersion = resolveOzonDeleteCurrentVersion(ozonCargoes);
    const extraOzonCargoIds = findExtraOzonCargoes(ozonCargoes, ermBarcodes);

    const body = buildOzonCargoesBody(supply, packing, {
      ozonSupplyId,
      submitPlan,
      deleteCurrentVersion,
    });
    logger.info('[FBO Ozon] cargoes/create request', {
      supplyId,
      ozonSupplyId,
      submitMode,
      deleteCurrentVersion,
      extraOzonCargoIds,
      cargoIdsBefore,
      ermBarcodes: submitPlan.map((p) => p.ermBarcode),
      requestKeys: body.cargoes.map((c) => c.key),
    });

    const createData = await integrationsService._ozonApiPost('/v1/cargoes/create', body, ozonApiOpts);
    const operationId = extractOzonOperationId(createData);

    let pollResult = null;
    if (operationId) {
      pollResult = await pollOzonCargoesCreateInfo(operationId, ozonApiOpts);
      await verifyOzonCargoesSubmitResult(
        submitPlan,
        ermBarcodes,
        ozonSupplyId,
        ozonApiOpts,
        pollResult
      );
    } else {
      const err = new Error('Ozon не вернул идентификатор операции установки грузомест');
      err.statusCode = 400;
      throw err;
    }

    const updatedSupply = await markSupplyReadyForShipment(supplyId, { profileId });

    return {
      marketplace: 'ozon',
      operationId,
      cargoCount: body.cargoes.length,
      sentCargoKeys: ermBarcodes,
      ozonSupplyId,
      poll: pollResult,
      supply: updatedSupply,
      supplyStatus: updatedSupply.status,
      message:
        pollResult?.message ||
        (pollResult?.ok
          ? submitMode === 'update'
            ? `Состав грузомест обновлён в ${mpLabel} (${body.cargoes.length} шт.): ${ermBarcodes.join(', ')}. Номера грузомест сохранены.`
            : `Грузоместа отправлены в ${mpLabel} (${body.cargoes.length} шт.): ${ermBarcodes.join(', ')}. Статус: «Готов к отгрузке».`
          : `Запрос на установку грузомест отправлен в ${mpLabel}. Статус: «Готов к отгрузке».`),
    };
  }
}

export default new FboSuppliesSubmitService();
