/**
 * Ozon FBO: создание грузомест, этикетки, превью отправки состава.
 */

import fs from 'fs';
import { join } from 'path';
import fetch from 'node-fetch';
import crypto from 'crypto';
import { PDFDocument } from 'pdf-lib';
import { query } from '../config/database.js';
import config from '../config/index.js';
import integrationsService from './integrations.service.js';
import fboSuppliesService from './fboSupplies.service.js';
import fboSuppliesPackingService from './fboSuppliesPacking.service.js';
import fboSuppliesImportService from './fboSuppliesImport.service.js';
import {
  executeOzonCargoesCreate,
  extractOzonCargoIdMapping,
  fetchOzonSupplyCargoes,
  fetchOzonSupplyCargoesDetailed,
  isOzonCargoFilled,
  ozonCargoKeyFromUnit,
} from './fboSuppliesSubmit.service.js';
import { ozonApiPostWithRetry } from '../utils/ozonSellerApi.js';
import { formatOzonCargoErrorReasons } from '../utils/ozonCargoErrors.js';
import logger from '../utils/logger.js';

/** Дедуп параллельных запросов одних и тех же этикеток (создание + печать сразу). */
const pendingCargoLabelFetches = new Map();

function packedCargoUnits(packing) {
  return (packing?.cargoUnits || []).sort((a, b) => Number(a.id) - Number(b.id));
}

function ozonCargoType(cargoKind) {
  return cargoKind === 'pallet' ? 'PALLET' : 'BOX';
}

/** Тип грузоместа Ozon (PALLET/BOX) → cargo_kind в ERM. */
export function ozonCargoKindFromOzonType(type) {
  return String(type || '').trim().toUpperCase() === 'PALLET' ? 'pallet' : 'box';
}

/** Тело запроса Ozon POST /v1/cargoes-label/create (у каждого ГМ нужен type). */
export function buildOzonCargoLabelsCreateBody(ozonSupplyId, cargoEntries) {
  const supplyIdNum = Number(ozonSupplyId);
  return {
    supply_id: Number.isFinite(supplyIdNum) ? supplyIdNum : ozonSupplyId,
    cargoes: (cargoEntries || []).map((entry) => {
      const cargoId = entry?.cargoId ?? entry?.cargo_id ?? entry;
      const type =
        entry?.type === 'PALLET' || entry?.cargoKind === 'pallet' ? 'PALLET' : 'BOX';
      return {
        cargo_id: Number(cargoId) || cargoId,
        type,
      };
    }),
  };
}

async function resolveOzonApiContext(supplyId, { profileId } = {}) {
  const supply = await fboSuppliesService.getById(supplyId, { profileId });
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
  return { supply, ozonSupplyId, ozonApiOpts, ozonCfg: { clientId, apiKey } };
}

/** Превью: можно ли отправить состав через API или нужен Excel. */
export function buildOzonPackingSubmitPreview(packing, ozonCargoes) {
  const units = packedCargoUnits(packing);
  const ermBarcodes = units.map((u) => ozonCargoKeyFromUnit(u)).filter(Boolean);
  const ozonById = new Map((ozonCargoes || []).map((c) => [c.cargoId, c]));

  const filledInSubmitPlan = [];
  for (const unit of units) {
    const barcode = ozonCargoKeyFromUnit(unit);
    const ozon = ozonById.get(barcode);
    if (ozon && isOzonCargoFilled(ozon)) {
      filledInSubmitPlan.push(barcode);
    }
  }

  const filledOzonCargoIds = (ozonCargoes || [])
    .filter(isOzonCargoFilled)
    .map((c) => c.cargoId);

  const canSubmitCompositionViaApi =
    ermBarcodes.length > 0 && filledInSubmitPlan.length === 0;

  const filledCargoWarning = filledInSubmitPlan.length
    ? `Состав уже заполнен в Ozon (${filledInSubmitPlan.join(', ')}). Отправка из ERM не изменит его — выгрузите Excel по грузоместам и загрузите файл в личном кабинете Ozon (вкладка «Грузоместа»).`
    : null;

  return {
    ermCargoCount: ermBarcodes.length,
    ozonCargoCount: (ozonCargoes || []).length,
    ermBarcodes,
    filledOzonCargoIds,
    filledInSubmitPlan,
    ermBarcodesNotInOzon: ermBarcodes.filter((b) => !ozonById.has(b)),
    ozonCargoIdsNotInErm: (ozonCargoes || [])
      .map((c) => c.cargoId)
      .filter((id) => !ermBarcodes.includes(id)),
    canSubmitCompositionViaApi,
    filledCargoWarning,
    submitBlockedReason: filledCargoWarning,
  };
}

export function buildOzonEmptyCargoesBody(ozonSupplyId, slots, { includeEmptyItems = false } = {}) {
  const supplyIdNum = Number(ozonSupplyId);
  return {
    supply_id: Number.isFinite(supplyIdNum) ? supplyIdNum : ozonSupplyId,
    delete_current_version: false,
    cargoes: (slots || []).map((slot) => {
      const value = { type: ozonCargoType(slot.cargoKind) };
      if (includeEmptyItems) value.items = [];
      return { key: slot.key, value };
    }),
  };
}

function formatOzonCreateError(err, pollResult) {
  const fromPoll =
    pollResult?.data?.errors ??
    pollResult?.raw?.errors ??
    pollResult?.errors ??
    err?.details?.errors ??
    err?.details ??
    null;
  return (
    formatOzonCargoErrorReasons(fromPoll) ||
    err?.message ||
    'Ozon отклонил создание грузомест'
  );
}

async function waitForNewOzonCargoIds(ozonSupplyId, beforeIds, ozonApiOpts, { maxAttempts = 20, intervalMs = 3000 } = {}) {
  for (let i = 0; i < maxAttempts; i++) {
    if (i > 0) {
      await new Promise((r) => setTimeout(r, intervalMs));
    }
    const ozonAfter = await fetchOzonSupplyCargoes(ozonSupplyId, ozonApiOpts);
    const newIds = ozonAfter
      .map((c) => c.cargoId)
      .filter((id) => id && !beforeIds.has(id));
    if (newIds.length) return { newIds, ozonAfter };
  }
  const ozonAfter = await fetchOzonSupplyCargoes(ozonSupplyId, ozonApiOpts);
  return {
    newIds: ozonAfter.map((c) => c.cargoId).filter((id) => id && !beforeIds.has(id)),
    ozonAfter,
  };
}

async function pollOzonTransportStatus(statusPath, operationId, ozonApiOpts, { maxAttempts = 30, intervalMs = 2000 } = {}) {
  let last = null;
  for (let i = 0; i < maxAttempts; i++) {
    if (i > 0) await new Promise((r) => setTimeout(r, intervalMs));
    last = await ozonApiPostWithRetry(statusPath, { operation_id: operationId }, ozonApiOpts);
    const status = String(last?.status ?? last?.result?.status ?? '').toUpperCase();
    if (status === 'SUCCESS' || status === 'COMPLETED') return last;
    if (status === 'FAILED' || status === 'ERROR') {
      const err = new Error(
        formatOzonCargoErrorReasons(last?.errors || { error_reasons: last?.error_reasons }) ||
          'Ozon отклонил операцию с транспортными грузоместами'
      );
      err.statusCode = 400;
      err.details = last;
      throw err;
    }
  }
  const err = new Error('Ozon не завершил операцию с ТГМ вовремя');
  err.statusCode = 400;
  err.code = 'OZON_TRANSPORT_PENDING';
  err.details = last;
  throw err;
}

async function upsertErmTransportCargoes(supplyId, transportCargoes) {
  const result = [];
  for (const tc of transportCargoes || []) {
    const barcode = String(tc.transportCargoId ?? tc.barcode ?? '').trim();
    if (!barcode) continue;
    const exists = await query(
      `SELECT id FROM fbo_supply_transport_cargoes
       WHERE fbo_supply_id = $1 AND barcode = $2 LIMIT 1`,
      [supplyId, barcode]
    );
    if (exists.rows?.[0]?.id) {
      result.push({ barcode, id: exists.rows[0].id, existed: true });
      continue;
    }
    const ins = await query(
      `INSERT INTO fbo_supply_transport_cargoes (fbo_supply_id, barcode, transport_kind)
       VALUES ($1, $2, 'pallet')
       ON CONFLICT (fbo_supply_id, barcode) DO UPDATE SET barcode = EXCLUDED.barcode
       RETURNING id`,
      [supplyId, barcode]
    );
    result.push({ barcode, id: ins.rows[0]?.id, existed: false });
  }
  return result;
}

async function applyOzonTransportBindings(supplyId, ozonCargoes) {
  const transportRows = await query(
    `SELECT id, barcode FROM fbo_supply_transport_cargoes WHERE fbo_supply_id = $1`,
    [supplyId]
  );
  const transportByBarcode = new Map(
    (transportRows.rows || []).map((r) => [String(r.barcode).trim(), Number(r.id)])
  );

  // Сброс привязок, затем установка по данным Ozon.
  await query(
    `UPDATE fbo_supply_cargo_units SET transport_cargo_id = NULL WHERE fbo_supply_id = $1`,
    [supplyId]
  );

  for (const c of ozonCargoes || []) {
    const cargoId = String(c.cargoId || '').trim();
    const tid = c.transportCargoId != null ? String(c.transportCargoId).trim() : '';
    if (!cargoId || !tid) continue;
    const transportId = transportByBarcode.get(tid);
    if (!transportId) continue;
    await query(
      `UPDATE fbo_supply_cargo_units
       SET transport_cargo_id = $3
       WHERE fbo_supply_id = $1 AND barcode = $2`,
      [supplyId, cargoId, transportId]
    );
  }
}

async function insertErmCargoUnits(supplyId, entries) {
  const list = (entries || []).map((entry) => {
    if (entry && typeof entry === 'object' && entry.cargoId != null) {
      return {
        cargoId: String(entry.cargoId).trim(),
        cargoKind: entry.cargoKind === 'pallet' ? 'pallet' : 'box',
      };
    }
    return {
      cargoId: String(entry).trim(),
      cargoKind: 'box',
    };
  });
  const created = [];
  for (const { cargoId, cargoKind } of list) {
    if (!cargoId) continue;
    const exists = await query(
      `SELECT id, cargo_kind FROM fbo_supply_cargo_units WHERE fbo_supply_id = $1 AND barcode = $2 LIMIT 1`,
      [supplyId, cargoId]
    );
    if (exists.rows?.length) {
      const row = exists.rows[0];
      if (row.cargo_kind !== cargoKind) {
        await query(`UPDATE fbo_supply_cargo_units SET cargo_kind = $2 WHERE id = $1`, [
          row.id,
          cargoKind,
        ]);
      }
      created.push({ cargoId, cargoUnitId: row.id, existed: true, cargoKind });
      continue;
    }
    const ins = await query(
      `INSERT INTO fbo_supply_cargo_units (fbo_supply_id, barcode, cargo_kind)
       VALUES ($1, $2, $3)
       RETURNING id`,
      [supplyId, cargoId, cargoKind]
    );
    created.push({
      cargoId,
      cargoUnitId: ins.rows[0]?.id,
      existed: false,
      cargoKind,
    });
  }
  return created;
}

async function runOzonEmptyCargoCreate(ozonSupplyId, slots, ozonApiOpts) {
  const variants = [
    buildOzonEmptyCargoesBody(ozonSupplyId, slots, { includeEmptyItems: false }),
    buildOzonEmptyCargoesBody(ozonSupplyId, slots, { includeEmptyItems: true }),
  ];
  let lastErr = null;
  for (const body of variants) {
    try {
      const result = await executeOzonCargoesCreate(body, ozonApiOpts);
      return result;
    } catch (err) {
      lastErr = err;
      logger.warn('[FBO Ozon] create empty cargoes variant failed', {
        ozonSupplyId,
        includeEmptyItems: Boolean(body.cargoes?.[0]?.value?.items),
        error: err.message,
      });
    }
  }
  throw lastErr || new Error('Ozon не принял запрос на создание грузомест');
}

function labelsCacheDir() {
  const dir = join(config.paths.dataDir, 'fbo-cargo-labels');
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  return dir;
}

function normalizeCargoEntries(cargoEntries) {
  return (cargoEntries || [])
    .map((e) => {
      if (e && typeof e === 'object') {
        const id = String(e.cargoId ?? e.cargo_id ?? '').trim();
        const type =
          e.type === 'PALLET' || e.cargoKind === 'pallet' || e.type === 'pallet' ? 'PALLET' : 'BOX';
        return id ? { cargoId: id, type } : null;
      }
      const id = String(e || '').trim();
      return id ? { cargoId: id, type: 'BOX' } : null;
    })
    .filter(Boolean)
    .sort((a, b) => a.cargoId.localeCompare(b.cargoId, 'en', { numeric: true }));
}

function labelsCachePath(supplyId, cargoEntries) {
  const parts = normalizeCargoEntries(cargoEntries).map((e) => `${e.cargoId}:${e.type}`);
  const hash = crypto
    .createHash('md5')
    .update([supplyId, ...parts].join(':'))
    .digest('hex');
  return join(labelsCacheDir(), `${supplyId}_${hash}.pdf`);
}

function singleCargoLabelCachePath(supplyId, cargoId, type) {
  const t = type === 'PALLET' ? 'PALLET' : 'BOX';
  return join(labelsCacheDir(), `${supplyId}_${String(cargoId).trim()}_${t}.pdf`);
}

function transportLabelsCachePath(supplyId, transportCargoIds) {
  const ids = [...new Set((transportCargoIds || []).map((id) => String(id).trim()).filter(Boolean))].sort(
    (a, b) => a.localeCompare(b, 'en', { numeric: true })
  );
  const hash = crypto.createHash('md5').update([supplyId, ...ids].join(':')).digest('hex');
  return join(labelsCacheDir(), `tgm_${supplyId}_${hash}.pdf`);
}

async function mergePdfBuffers(buffers) {
  const out = await PDFDocument.create();
  for (const buf of buffers) {
    if (!buf?.length) continue;
    const doc = await PDFDocument.load(buf);
    const pages = await out.copyPages(doc, doc.getPageIndices());
    for (const page of pages) out.addPage(page);
  }
  return Buffer.from(await out.save());
}

/** Если PDF по страницам совпадает с числом ГМ — кэшируем по одному. */
async function cacheSplitCargoPdfPages(supplyId, cargoEntries, buffer) {
  try {
    const entries = normalizeCargoEntries(cargoEntries);
    const doc = await PDFDocument.load(buffer);
    if (doc.getPageCount() !== entries.length) return;
    for (let i = 0; i < entries.length; i++) {
      const one = await PDFDocument.create();
      const [page] = await one.copyPages(doc, [i]);
      one.addPage(page);
      const path = singleCargoLabelCachePath(supplyId, entries[i].cargoId, entries[i].type);
      fs.writeFileSync(path, Buffer.from(await one.save()));
    }
  } catch (e) {
    logger.warn('[FBO Ozon] split cargo label PDF for cache failed', { err: e?.message });
  }
}

/** Скачать PDF по signed URL (ir.ozone.ru) или старому Seller API path. */
async function ozonApiGetBinary(pathOrUrl, { clientId, apiKey } = {}) {
  const isAbsolute = /^https?:\/\//i.test(String(pathOrUrl || ''));
  const url = isAbsolute
    ? String(pathOrUrl)
    : `https://api-seller.ozon.ru${String(pathOrUrl).startsWith('/') ? pathOrUrl : `/${pathOrUrl}`}`;
  const headers = {};
  if (!isAbsolute && clientId && apiKey) {
    headers['Client-Id'] = String(clientId);
    headers['Api-Key'] = String(apiKey);
  }
  const response = await fetch(url, { method: 'GET', headers, timeout: 60000 });
  if (!response.ok) {
    const text = await response.text();
    const err = new Error(`Ozon API ${response.status}: ${text.slice(0, 200)}`);
    err.statusCode = 400;
    throw err;
  }
  return Buffer.from(await response.arrayBuffer());
}

/**
 * Дождаться генерации этикеток.
 * С ~04.2026 GET /v1/cargoes-label/file/{guid} отключён — PDF берём из result.file_url.
 */
function cargoLabelPollDelayMs(attemptIndex) {
  // Быстрее в начале (Ozon часто готов за 1–3 с), потом реже.
  if (attemptIndex <= 0) return 0;
  if (attemptIndex <= 6) return 400;
  if (attemptIndex <= 15) return 800;
  return 1500;
}

async function pollOzonCargoLabels(operationId, ozonApiOpts, { maxAttempts = 40 } = {}) {
  for (let i = 0; i < maxAttempts; i++) {
    const delay = cargoLabelPollDelayMs(i);
    if (delay > 0) {
      await new Promise((r) => setTimeout(r, delay));
    }
    const data = await ozonApiPostWithRetry(
      '/v1/cargoes-label/get',
      { operation_id: operationId },
      ozonApiOpts
    );
    // status на верхнем уровне; file_* — в result
    const status = String(data?.status ?? data?.state ?? data?.result?.status ?? '').toUpperCase();
    const result = data?.result && typeof data.result === 'object' ? data.result : data ?? {};
    const fileGuid =
      result.file_guid ??
      result.fileGuid ??
      data?.file_guid ??
      data?.fileGuid ??
      null;
    const fileUrl =
      result.file_url ??
      result.fileUrl ??
      data?.file_url ??
      data?.fileUrl ??
      null;
    if (status === 'SUCCESS' || status === 'COMPLETED' || status === 'DONE') {
      if (!fileUrl && !fileGuid) {
        const err = new Error('Ozon не вернул ссылку на файл этикеток');
        err.statusCode = 400;
        throw err;
      }
      return {
        fileGuid: fileGuid != null ? String(fileGuid).trim() : null,
        fileUrl: fileUrl != null ? String(fileUrl).trim() : null,
      };
    }
    if ((fileUrl || fileGuid) && status !== 'FAILED' && status !== 'ERROR') {
      return {
        fileGuid: fileGuid != null ? String(fileGuid).trim() : null,
        fileUrl: fileUrl != null ? String(fileUrl).trim() : null,
      };
    }
    if (status === 'FAILED' || status === 'ERROR') {
      const err = new Error(
        formatOzonCargoErrorReasons(data?.errors ?? result?.errors) ||
          'Ozon не смог сформировать этикетки грузомест'
      );
      err.statusCode = 400;
      err.details = data;
      throw err;
    }
  }
  const err = new Error('Ozon не успел сформировать этикетки грузомест');
  err.statusCode = 400;
  err.code = 'OZON_CARGO_LABEL_PENDING';
  throw err;
}

class FboSuppliesOzonCargoesService {
  async getPackingOzonMeta(supplyId, { profileId } = {}) {
    const { ozonSupplyId, ozonApiOpts } = await resolveOzonApiContext(supplyId, { profileId });
    const packing = await fboSuppliesPackingService.getPackingState(supplyId, { profileId });
    const ozonCargoes = await fetchOzonSupplyCargoes(ozonSupplyId, ozonApiOpts);
    const preview = buildOzonPackingSubmitPreview(packing, ozonCargoes);
    return {
      ozonSupplyId,
      ...preview,
      ozonCargoes: ozonCargoes.map((c) => ({
        cargoId: c.cargoId,
        contentType: c.contentType,
        filled: isOzonCargoFilled(c),
      })),
    };
  }

  async createEmptyCargoesOnOzon(supplyId, { count = 1, cargoKind = 'box', profileId } = {}) {
    const qty = Math.min(Math.max(Number(count) || 1, 1), 30);
    const kind = cargoKind === 'pallet' ? 'pallet' : 'box';
    const { ozonSupplyId, ozonApiOpts } = await resolveOzonApiContext(supplyId, { profileId });

    const ozonBefore = await fetchOzonSupplyCargoes(ozonSupplyId, ozonApiOpts);
    const beforeIds = new Set(ozonBefore.map((c) => c.cargoId));

    const slots = Array.from({ length: qty }, (_, i) => ({
      key: `erm-${crypto.randomUUID()}`,
      cargoKind: kind,
    }));
    logger.info('[FBO Ozon] create empty cargoes', { supplyId, ozonSupplyId, qty, kind });

    let operationId = null;
    let pollResult = null;
    try {
      ({ operationId, pollResult } = await runOzonEmptyCargoCreate(ozonSupplyId, slots, ozonApiOpts));
    } catch (err) {
      const waited = await waitForNewOzonCargoIds(ozonSupplyId, beforeIds, ozonApiOpts, {
        maxAttempts: 5,
        intervalMs: 2000,
      });
      if (waited.newIds.length) {
        pollResult = { status: 'SUCCESS', ok: true };
      } else {
        const msg = formatOzonCreateError(err, pollResult);
        const e = new Error(msg);
        e.statusCode = 400;
        e.code = err.code || 'OZON_CARGO_CREATE_FAILED';
        throw e;
      }
    }

    const mapping = extractOzonCargoIdMapping(pollResult);
    let newCargoIds = slots
      .map((slot) => mapping.get(slot.key))
      .filter(Boolean)
      .map(String);

    let ozonAfter = await fetchOzonSupplyCargoes(ozonSupplyId, ozonApiOpts);
    if (newCargoIds.length < qty) {
      newCargoIds = ozonAfter
        .map((c) => c.cargoId)
        .filter((id) => id && !beforeIds.has(id));
    }

    if (!newCargoIds.length) {
      const waited = await waitForNewOzonCargoIds(ozonSupplyId, beforeIds, ozonApiOpts);
      newCargoIds = waited.newIds;
      ozonAfter = waited.ozonAfter;
    }

    if (!newCargoIds.length) {
      const err = new Error(
        pollResult?.status === 'PENDING'
          ? 'Ozon ещё обрабатывает создание грузомест. Подождите минуту, нажмите «Подтянуть из Ozon» или проверьте личный кабинет.'
          : 'Ozon не вернул номера новых грузомест. Создайте коробку в личном кабинете Ozon и нажмите «Подтянуть из Ozon».'
      );
      err.statusCode = 400;
      err.code = 'OZON_CARGO_CREATE_NO_IDS';
      throw err;
    }

    const created = await insertErmCargoUnits(
      supplyId,
      newCargoIds.map((cargoId) => ({ cargoId, cargoKind: kind }))
    );
    const packing = await fboSuppliesPackingService.getPackingState(supplyId, { profileId });
    const ozonMeta = buildOzonPackingSubmitPreview(packing, ozonAfter);

    // Сразу греем кэш этикеток — клиентская «Печать» часто успевает попасть в готовый PDF.
    this.prefetchCargoLabels(supplyId, newCargoIds, { profileId });

    return {
      operationId,
      createdCargoIds: newCargoIds,
      created,
      packing,
      ozonMeta,
      message: `Создано ${newCargoIds.length} грузомест на Ozon: ${newCargoIds.join(', ')}. Распечатайте этикетки и продолжите сборку.`,
    };
  }

  async syncOzonCargoesToErm(supplyId, { profileId } = {}) {
    const { ozonSupplyId, ozonApiOpts } = await resolveOzonApiContext(supplyId, { profileId });
    const detailed = await fetchOzonSupplyCargoesDetailed(ozonSupplyId, ozonApiOpts);
    const ozonCargoes = detailed.cargoes || [];
    const ozonTransport = detailed.transportCargoes || [];
    const ozonIds = ozonCargoes.map((c) => c.cargoId).filter(Boolean);
    if (!ozonIds.length && !ozonTransport.length) {
      const err = new Error(
        'В Ozon пока нет грузомест для этой поставки. Сначала создайте их в личном кабинете или кнопками «Короб на Ozon» / «Паллета на Ozon».'
      );
      err.statusCode = 400;
      throw err;
    }

    const transportUpserted = await upsertErmTransportCargoes(supplyId, ozonTransport);
    const created = await insertErmCargoUnits(
      supplyId,
      ozonCargoes.map((c) => ({
        cargoId: c.cargoId,
        cargoKind: ozonCargoKindFromOzonType(c.type),
      }))
    );
    await applyOzonTransportBindings(supplyId, ozonCargoes);
    const added = created.filter((c) => !c.existed);
    const packing = await fboSuppliesPackingService.getPackingState(supplyId, { profileId });
    const ozonMeta = buildOzonPackingSubmitPreview(packing, ozonCargoes);
    const parts = [];
    if (added.length > 0) {
      parts.push(`коробов +${added.length}`);
    }
    const addedTransport = transportUpserted.filter((t) => !t.existed);
    if (addedTransport.length > 0) {
      parts.push(`ТГМ +${addedTransport.length}`);
    }

    return {
      createdCargoIds: ozonIds,
      created,
      addedCount: added.length,
      transportCargoes: packing.transportCargoes || [],
      packing,
      ozonMeta,
      message:
        parts.length > 0
          ? `Подтянуто из Ozon: ${parts.join(', ')} (всего коробов ${ozonIds.length}, ТГМ ${ozonTransport.length})`
          : `Все грузоместа Ozon уже есть в сборке ERM (коробов ${ozonIds.length}, ТГМ ${ozonTransport.length})`,
    };
  }

  /** Включить режим транспортных грузомест в поставке Ozon. */
  async activateTransportCargoes(supplyId, { enabled = true, profileId } = {}) {
    const { ozonSupplyId, ozonApiOpts } = await resolveOzonApiContext(supplyId, { profileId });
    const createRes = await ozonApiPostWithRetry(
      '/v1/cargoes/transport/activate',
      { supply_id: Number(ozonSupplyId) || ozonSupplyId, is_transport: enabled !== false },
      ozonApiOpts
    );
    const operationId = createRes?.operation_id ?? createRes?.result?.operation_id;
    if (!operationId) {
      const err = new Error('Ozon не вернул operation_id при включении ТГМ');
      err.statusCode = 400;
      throw err;
    }
    await pollOzonTransportStatus(
      '/v1/cargoes/transport/activate/status',
      operationId,
      ozonApiOpts
    );
    return {
      operationId,
      enabled: enabled !== false,
      message: enabled !== false ? 'Транспортные грузоместа включены в поставке Ozon' : 'ТГМ отключены',
    };
  }

  /** Создать транспортные грузоместа (паллеты-ТГМ) на Ozon и в ERM. */
  async createTransportCargoesOnOzon(supplyId, { count = 1, profileId } = {}) {
    const qty = Math.min(Math.max(Number(count) || 1, 1), 40);
    const { ozonSupplyId, ozonApiOpts } = await resolveOzonApiContext(supplyId, { profileId });

    // Без is_transport:true Ozon часто отклоняет create.
    try {
      await this.activateTransportCargoes(supplyId, { enabled: true, profileId });
    } catch (err) {
      logger.warn('[FBO Ozon] transport activate before create', {
        supplyId,
        error: err?.message,
      });
    }

    const before = await fetchOzonSupplyCargoesDetailed(ozonSupplyId, ozonApiOpts);
    const beforeIds = new Set((before.transportCargoes || []).map((t) => t.transportCargoId));

    const createRes = await ozonApiPostWithRetry(
      '/v1/cargoes/transport/create',
      {
        supply_id: Number(ozonSupplyId) || ozonSupplyId,
        transport_cargoes: [{ count: qty, type: 'PALLET' }],
      },
      ozonApiOpts
    );
    const errorReasons = createRes?.error_reasons ?? createRes?.result?.error_reasons;
    if (Array.isArray(errorReasons) && errorReasons.length) {
      const err = new Error(formatOzonCargoErrorReasons({ error_reasons: errorReasons }) || 'Ozon отклонил создание ТГМ');
      err.statusCode = 400;
      throw err;
    }
    const operationId = createRes?.operation_id ?? createRes?.result?.operation_id;
    if (!operationId) {
      const err = new Error('Ozon не вернул operation_id при создании ТГМ');
      err.statusCode = 400;
      throw err;
    }

    const statusData = await pollOzonTransportStatus(
      '/v1/cargoes/transport/create/status',
      operationId,
      ozonApiOpts
    );
    let newIds = (statusData?.result?.transport_cargoes || statusData?.transport_cargoes || [])
      .map((t) => (t?.id != null ? String(t.id).trim() : ''))
      .filter(Boolean);

    if (newIds.length < qty) {
      for (let i = 0; i < 10 && newIds.length < qty; i++) {
        if (i > 0) await new Promise((r) => setTimeout(r, 2000));
        const after = await fetchOzonSupplyCargoesDetailed(ozonSupplyId, ozonApiOpts);
        newIds = (after.transportCargoes || [])
          .map((t) => t.transportCargoId)
          .filter((id) => id && !beforeIds.has(id));
      }
    }

    if (!newIds.length) {
      const err = new Error(
        'Ozon не вернул номера новых ТГМ. Подождите и нажмите «Подтянуть из Ozon».'
      );
      err.statusCode = 400;
      err.code = 'OZON_TRANSPORT_CREATE_NO_IDS';
      throw err;
    }

    await upsertErmTransportCargoes(
      supplyId,
      newIds.map((id) => ({ transportCargoId: id, type: 'PALLET' }))
    );
    const packing = await fboSuppliesPackingService.getPackingState(supplyId, { profileId });
    return {
      operationId,
      createdTransportCargoIds: newIds,
      packing,
      message: `Создано ${newIds.length} транспортных грузомест: ${newIds.join(', ')}`,
    };
  }

  /**
   * Привязать / отвязать короба к ТГМ.
   * @param {{ transportCargoId: string|number, cargoUnitIds?: number[], cargoBarcodes?: string[], unbindCargoBarcodes?: string[] }} opts
   */
  async bindCargoesToTransport(supplyId, opts = {}, { profileId } = {}) {
    const { ozonSupplyId, ozonApiOpts } = await resolveOzonApiContext(supplyId, { profileId });
    const transportBarcode = String(opts.transportCargoId ?? opts.transportBarcode ?? '').trim();
    if (!transportBarcode) {
      const err = new Error('Укажите транспортное грузоместо');
      err.statusCode = 400;
      throw err;
    }

    const packing = await fboSuppliesPackingService.getPackingState(supplyId, { profileId });
    const units = packing?.cargoUnits || [];
    const unitIds = new Set((opts.cargoUnitIds || []).map((id) => Number(id)).filter((n) => n > 0));
    const barcodesFromOpts = (opts.cargoBarcodes || []).map((b) => String(b).trim()).filter(Boolean);
    const bindBarcodes = [
      ...barcodesFromOpts,
      ...units.filter((u) => unitIds.has(Number(u.id))).map((u) => String(u.barcode).trim()),
    ].filter(Boolean);
    const uniqueBind = [...new Set(bindBarcodes)];
    const unbindBarcodes = [
      ...new Set((opts.unbindCargoBarcodes || []).map((b) => String(b).trim()).filter(Boolean)),
    ];

    if (!uniqueBind.length && !unbindBarcodes.length) {
      const err = new Error('Укажите короба для привязки или отвязки');
      err.statusCode = 400;
      throw err;
    }

    const body = {
      supply_id: Number(ozonSupplyId) || ozonSupplyId,
    };
    if (uniqueBind.length) {
      body.transport_cargo_bind = [
        {
          transport_cargo_id: Number(transportBarcode) || transportBarcode,
          cargo_ids: uniqueBind,
        },
      ];
    }
    if (unbindBarcodes.length) {
      body.cargoes_unbind_transport_cargoes = unbindBarcodes;
    }

    const createRes = await ozonApiPostWithRetry('/v1/cargoes/transport/bind', body, ozonApiOpts);
    const errorReasons = createRes?.error_reasons ?? createRes?.result?.error_reasons;
    if (Array.isArray(errorReasons) && errorReasons.length) {
      const err = new Error(
        formatOzonCargoErrorReasons({ error_reasons: errorReasons }) || 'Ozon отклонил привязку к ТГМ'
      );
      err.statusCode = 400;
      throw err;
    }
    const operationId = createRes?.operation_id ?? createRes?.result?.operation_id;
    if (operationId) {
      await pollOzonTransportStatus('/v1/cargoes/transport/bind/status', operationId, ozonApiOpts);
    }

    // Локально синхронизируем привязку по ответу Ozon (полный список).
    const detailed = await fetchOzonSupplyCargoesDetailed(ozonSupplyId, ozonApiOpts);
    await upsertErmTransportCargoes(supplyId, detailed.transportCargoes || []);
    await applyOzonTransportBindings(supplyId, detailed.cargoes || []);

    const nextPacking = await fboSuppliesPackingService.getPackingState(supplyId, { profileId });
    return {
      operationId,
      packing: nextPacking,
      message: uniqueBind.length
        ? `Привязано ${uniqueBind.length} коробов к ТГМ ${transportBarcode}`
        : `Отвязано ${unbindBarcodes.length} коробов от ТГМ`,
    };
  }

  async fetchTransportCargoLabelsPdf(supplyId, transportCargoIds, { profileId, useCache = true } = {}) {
    const ids = [...new Set((transportCargoIds || []).map((id) => String(id).trim()).filter(Boolean))];
    if (!ids.length) {
      const err = new Error('Укажите номера транспортных грузомест');
      err.statusCode = 400;
      throw err;
    }
    const cachePath = transportLabelsCachePath(supplyId, ids);
    if (useCache && fs.existsSync(cachePath)) {
      return { buffer: fs.readFileSync(cachePath), cached: true, cargoIds: ids };
    }

    const { ozonSupplyId, ozonApiOpts, ozonCfg } = await resolveOzonApiContext(supplyId, {
      profileId,
    });
    const createRes = await ozonApiPostWithRetry(
      '/v1/cargoes/label/transport/create',
      {
        supply_id: Number(ozonSupplyId) || ozonSupplyId,
        transport_cargo_ids: ids,
      },
      ozonApiOpts
    );
    const operationId = createRes?.operation_id ?? createRes?.result?.operation_id;
    if (!operationId) {
      const err = new Error('Ozon не начал генерацию этикеток ТГМ');
      err.statusCode = 400;
      throw err;
    }
    let fileUrl = null;
    let fileGuid = null;
    for (let i = 0; i < 40; i++) {
      const delay = cargoLabelPollDelayMs(i);
      if (delay > 0) await new Promise((r) => setTimeout(r, delay));
      const st = await ozonApiPostWithRetry(
        '/v1/cargoes/label/transport/status',
        { operation_id: operationId },
        ozonApiOpts
      );
      const status = String(st?.status || st?.result?.status || '').toUpperCase();
      fileUrl =
        st?.file_url ??
        st?.result?.file_url ??
        st?.result?.result?.file_url ??
        null;
      fileGuid =
        st?.file_guid ??
        st?.result?.file_guid ??
        st?.result?.result?.file_guid ??
        null;
      if (status === 'FAILED' || status === 'ERROR') {
        const err = new Error(
          formatOzonCargoErrorReasons(st?.errors || st?.error_reasons) ||
            'Ozon не сформировал этикетки ТГМ'
        );
        err.statusCode = 400;
        throw err;
      }
      if (fileUrl || fileGuid || status === 'SUCCESS' || status === 'COMPLETED') break;
    }
    let buffer = null;
    if (fileUrl) {
      const r = await fetch(String(fileUrl));
      if (!r.ok) throw new Error(`Не удалось скачать этикетки ТГМ (${r.status})`);
      buffer = Buffer.from(await r.arrayBuffer());
    } else if (fileGuid) {
      const base = config.ozon?.apiUrl || 'https://api-seller.ozon.ru';
      const r = await fetch(`${base}/v1/cargoes-label/file/${fileGuid}`, {
        headers: {
          'Client-Id': String(ozonCfg.clientId),
          'Api-Key': String(ozonCfg.apiKey),
        },
      });
      if (!r.ok) throw new Error(`Не удалось скачать этикетки ТГМ (${r.status})`);
      buffer = Buffer.from(await r.arrayBuffer());
    }
    if (!buffer) {
      const err = new Error('Ozon не вернул файл этикеток ТГМ');
      err.statusCode = 400;
      throw err;
    }
    try {
      fs.writeFileSync(cachePath, buffer);
    } catch (_) {
      /* ignore cache write */
    }
    return { buffer, cached: false, cargoIds: ids };
  }

  /**
   * Prefetch в фоне после создания ГМ — к моменту печати часто уже в кэше.
   */
  prefetchCargoLabels(supplyId, cargoIds, { profileId } = {}) {
    const ids = (cargoIds || []).map((id) => String(id).trim()).filter(Boolean);
    if (!ids.length) return;
    this.fetchCargoLabelsPdf(supplyId, ids, { profileId, useCache: true }).catch((e) => {
      logger.warn('[FBO Ozon] prefetch cargo labels failed', {
        supplyId,
        cargoIds: ids,
        err: e?.message,
      });
    });
  }

  async fetchCargoLabelsPdf(supplyId, cargoIds, { profileId, useCache = true } = {}) {
    const ids = [...new Set((cargoIds || []).map((id) => String(id).trim()).filter(Boolean))];
    if (!ids.length) {
      const err = new Error('Укажите номера грузомест (cargo_id)');
      err.statusCode = 400;
      throw err;
    }

    const packing = await fboSuppliesPackingService.getPackingState(supplyId, { profileId });
    const ermKindByBarcode = new Map(
      (packing?.cargoUnits || [])
        .filter((u) => u?.barcode)
        .map((u) => [String(u.barcode).trim(), u.cargoKind === 'pallet' ? 'PALLET' : 'BOX'])
    );

    let ozonById = null;
    const missingInErm = ids.filter((id) => !ermKindByBarcode.has(id));
    if (missingInErm.length) {
      const { ozonSupplyId, ozonApiOpts } = await resolveOzonApiContext(supplyId, { profileId });
      const ozonCargoes = await fetchOzonSupplyCargoes(ozonSupplyId, ozonApiOpts);
      ozonById = new Map(ozonCargoes.map((c) => [c.cargoId, c]));
      const unknown = ids.filter((id) => !ermKindByBarcode.has(id) && !ozonById.has(id));
      if (unknown.length) {
        const err = new Error(
          `Грузоместа не найдены в Ozon: ${unknown.join(', ')}. Сначала создайте их на маркетплейсе.`
        );
        err.statusCode = 400;
        err.code = 'OZON_CARGO_NOT_FOUND';
        throw err;
      }
    }

    const cargoEntries = normalizeCargoEntries(
      ids.map((id) => {
        const ermType = ermKindByBarcode.get(id);
        const ozon = ozonById?.get(id);
        const ozonType = ozon?.type === 'PALLET' ? 'PALLET' : ozon?.type === 'BOX' ? 'BOX' : null;
        return { cargoId: id, type: ermType || ozonType || 'BOX' };
      })
    );

    const dedupeKey = labelsCachePath(supplyId, cargoEntries);
    if (pendingCargoLabelFetches.has(dedupeKey)) {
      return pendingCargoLabelFetches.get(dedupeKey);
    }

    const run = this._fetchCargoLabelsPdfWork(supplyId, cargoEntries, {
      profileId,
      useCache,
      cachePath: dedupeKey,
    });
    pendingCargoLabelFetches.set(dedupeKey, run);
    try {
      return await run;
    } finally {
      pendingCargoLabelFetches.delete(dedupeKey);
    }
  }

  async _fetchCargoLabelsPdfWork(supplyId, cargoEntries, { profileId, useCache, cachePath }) {
    const ids = cargoEntries.map((e) => e.cargoId);

    if (useCache && fs.existsSync(cachePath)) {
      return { buffer: fs.readFileSync(cachePath), cached: true, cargoIds: ids };
    }

    if (useCache && cargoEntries.length > 1) {
      const perCargo = [];
      let allCached = true;
      for (const entry of cargoEntries) {
        const p = singleCargoLabelCachePath(supplyId, entry.cargoId, entry.type);
        if (!fs.existsSync(p)) {
          allCached = false;
          break;
        }
        perCargo.push(fs.readFileSync(p));
      }
      if (allCached && perCargo.length === cargoEntries.length) {
        const buffer = await mergePdfBuffers(perCargo);
        try {
          fs.writeFileSync(cachePath, buffer);
        } catch (_) {
          /* ignore */
        }
        return { buffer, cached: true, cargoIds: ids, mergedFromSingles: true };
      }
    }

    if (useCache && cargoEntries.length === 1) {
      const p = singleCargoLabelCachePath(supplyId, cargoEntries[0].cargoId, cargoEntries[0].type);
      if (fs.existsSync(p)) {
        return { buffer: fs.readFileSync(p), cached: true, cargoIds: ids };
      }
    }

    const { ozonSupplyId, ozonApiOpts, ozonCfg } = await resolveOzonApiContext(supplyId, {
      profileId,
    });
    const labelBody = buildOzonCargoLabelsCreateBody(ozonSupplyId, cargoEntries);
    logger.info('[FBO Ozon] cargoes-label/create', {
      supplyId,
      ozonSupplyId,
      cargoes: labelBody.cargoes,
    });

    const createData = await ozonApiPostWithRetry('/v1/cargoes-label/create', labelBody, ozonApiOpts);
    const operationId =
      createData?.operation_id ??
      createData?.operationId ??
      createData?.result?.operation_id ??
      null;
    if (!operationId) {
      const err = new Error('Ozon не вернул идентификатор операции генерации этикеток');
      err.statusCode = 400;
      throw err;
    }

    const { fileGuid, fileUrl } = await pollOzonCargoLabels(operationId, ozonApiOpts);
    let buffer;
    if (fileUrl) {
      buffer = await ozonApiGetBinary(fileUrl);
    } else {
      buffer = await ozonApiGetBinary(
        `/v1/cargoes-label/file/${encodeURIComponent(fileGuid)}`,
        ozonCfg
      );
    }
    try {
      fs.writeFileSync(cachePath, buffer);
    } catch (_) {
      /* ignore */
    }
    await cacheSplitCargoPdfPages(supplyId, cargoEntries, buffer);
    return { buffer, cached: false, cargoIds: ids, fileGuid, fileUrl };
  }

  buildCargoLabelsPrintHtml(pdfUrl) {
    const safeUrl = String(pdfUrl).replace(/"/g, '&quot;');
    return `<!DOCTYPE html>
<html>
<head>
  <meta charset="utf-8">
  <title>Этикетки грузомест</title>
  <style>
    body { margin: 0; }
    iframe { width: 100%; height: 100vh; border: none; }
  </style>
</head>
<body>
  <iframe id="labelFrame" src="${safeUrl}"></iframe>
  <script>
    (function(){
      var done=false;
      function doPrint(){if(done)return;done=true;try{window.focus();window.print();}catch(e){}}
      var f=document.getElementById('labelFrame');
      f.addEventListener('load',function(){setTimeout(doPrint,300);});
      setTimeout(doPrint,1500);
    })();
  </script>
</body>
</html>`;
  }
}

export default new FboSuppliesOzonCargoesService();
