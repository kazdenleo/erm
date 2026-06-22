/**
 * Ozon FBO: создание грузомест, этикетки, превью отправки состава.
 */

import fs from 'fs';
import { join } from 'path';
import fetch from 'node-fetch';
import crypto from 'crypto';
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
  isOzonCargoFilled,
  ozonCargoKeyFromUnit,
} from './fboSuppliesSubmit.service.js';
import { ozonApiPostWithRetry } from '../utils/ozonSellerApi.js';
import logger from '../utils/logger.js';

function packedCargoUnits(packing) {
  return (packing?.cargoUnits || []).sort((a, b) => Number(a.id) - Number(b.id));
}

function ozonCargoType(cargoKind) {
  return cargoKind === 'pallet' ? 'PALLET' : 'BOX';
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
    null;
  if (typeof fromPoll === 'string' && fromPoll.trim()) return fromPoll.trim();
  if (fromPoll?.message) return String(fromPoll.message);
  if (Array.isArray(fromPoll) && fromPoll.length) {
    return fromPoll.map((e) => e?.message || e?.description || JSON.stringify(e)).join('; ');
  }
  return err?.message || 'Ozon отклонил создание грузомест';
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

async function insertErmCargoUnits(supplyId, cargoIds, cargoKind) {
  const kind = cargoKind === 'pallet' ? 'pallet' : 'box';
  const created = [];
  for (const cargoId of cargoIds) {
    const exists = await query(
      `SELECT id FROM fbo_supply_cargo_units WHERE fbo_supply_id = $1 AND barcode = $2 LIMIT 1`,
      [supplyId, cargoId]
    );
    if (exists.rows?.length) {
      created.push({ cargoId, cargoUnitId: exists.rows[0].id, existed: true });
      continue;
    }
    const ins = await query(
      `INSERT INTO fbo_supply_cargo_units (fbo_supply_id, barcode, cargo_kind)
       VALUES ($1, $2, $3)
       RETURNING id`,
      [supplyId, cargoId, kind]
    );
    created.push({
      cargoId,
      cargoUnitId: ins.rows[0]?.id,
      existed: false,
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

function labelsCachePath(supplyId, cargoIds) {
  const hash = crypto
    .createHash('md5')
    .update([supplyId, ...(cargoIds || [])].join(':'))
    .digest('hex');
  return join(labelsCacheDir(), `${supplyId}_${hash}.pdf`);
}

async function ozonApiGetBinary(path, { clientId, apiKey }) {
  const url = path.startsWith('http')
    ? path
    : `https://api-seller.ozon.ru${path.startsWith('/') ? path : `/${path}`}`;
  const response = await fetch(url, {
    method: 'GET',
    headers: {
      'Client-Id': String(clientId),
      'Api-Key': String(apiKey),
    },
    timeout: 60000,
  });
  if (!response.ok) {
    const text = await response.text();
    const err = new Error(`Ozon API ${response.status}: ${text.slice(0, 200)}`);
    err.statusCode = 400;
    throw err;
  }
  return Buffer.from(await response.arrayBuffer());
}

async function pollOzonCargoLabels(operationId, ozonApiOpts, { maxAttempts = 30, pollIntervalMs = 2000 } = {}) {
  for (let i = 0; i < maxAttempts; i++) {
    if (i > 0) {
      await new Promise((r) => setTimeout(r, pollIntervalMs));
    }
    const data = await ozonApiPostWithRetry(
      '/v1/cargoes-label/get',
      { operation_id: operationId },
      ozonApiOpts
    );
    const root = data?.result ?? data ?? {};
    const status = String(root.status ?? root.state ?? '').toUpperCase();
    if (status === 'SUCCESS' || status === 'COMPLETED' || status === 'DONE') {
      const fileGuid = root.file_guid ?? root.fileGuid ?? root.result?.file_guid;
      if (!fileGuid) {
        const err = new Error('Ozon не вернул идентификатор файла этикеток');
        err.statusCode = 400;
        throw err;
      }
      return String(fileGuid).trim();
    }
    if (status === 'FAILED' || status === 'ERROR') {
      const err = new Error('Ozon не смог сформировать этикетки грузомест');
      err.statusCode = 400;
      err.details = root;
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

    const created = await insertErmCargoUnits(supplyId, newCargoIds, kind);
    const packing = await fboSuppliesPackingService.getPackingState(supplyId, { profileId });
    const ozonMeta = buildOzonPackingSubmitPreview(packing, ozonAfter);

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
    const ozonCargoes = await fetchOzonSupplyCargoes(ozonSupplyId, ozonApiOpts);
    const ozonIds = ozonCargoes.map((c) => c.cargoId).filter(Boolean);
    if (!ozonIds.length) {
      const err = new Error(
        'В Ozon пока нет грузомест для этой поставки. Сначала создайте их в личном кабинете или кнопкой «Создать на Ozon».'
      );
      err.statusCode = 400;
      throw err;
    }

    const created = await insertErmCargoUnits(supplyId, ozonIds, 'box');
    const added = created.filter((c) => !c.existed);
    const packing = await fboSuppliesPackingService.getPackingState(supplyId, { profileId });
    const ozonMeta = buildOzonPackingSubmitPreview(packing, ozonCargoes);

    return {
      createdCargoIds: ozonIds,
      created,
      addedCount: added.length,
      packing,
      ozonMeta,
      message:
        added.length > 0
          ? `Добавлено ${added.length} грузомест из Ozon: ${added.map((c) => c.cargoId).join(', ')}`
          : 'Все грузоместа Ozon уже есть в сборке ERM',
    };
  }

  async fetchCargoLabelsPdf(supplyId, cargoIds, { profileId, useCache = true } = {}) {
    const ids = (cargoIds || []).map((id) => String(id).trim()).filter(Boolean);
    if (!ids.length) {
      const err = new Error('Укажите номера грузомест (cargo_id)');
      err.statusCode = 400;
      throw err;
    }

    const cachePath = labelsCachePath(supplyId, ids);
    if (useCache && fs.existsSync(cachePath)) {
      return { buffer: fs.readFileSync(cachePath), cached: true, cargoIds: ids };
    }

    const { ozonSupplyId, ozonApiOpts, ozonCfg } = await resolveOzonApiContext(supplyId, {
      profileId,
    });
    const ozonCargoes = await fetchOzonSupplyCargoes(ozonSupplyId, ozonApiOpts);
    const ozonSet = new Set(ozonCargoes.map((c) => c.cargoId));
    const unknown = ids.filter((id) => !ozonSet.has(id));
    if (unknown.length) {
      const err = new Error(
        `Грузоместа не найдены в Ozon: ${unknown.join(', ')}. Сначала создайте их на маркетплейсе.`
      );
      err.statusCode = 400;
      err.code = 'OZON_CARGO_NOT_FOUND';
      throw err;
    }

    const createData = await ozonApiPostWithRetry(
      '/v1/cargoes-label/create',
      {
        supply_id: Number(ozonSupplyId) || ozonSupplyId,
        cargoes: ids.map((cargo_id) => ({
          cargo_id: Number(cargo_id) || cargo_id,
        })),
      },
      ozonApiOpts
    );
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

    const fileGuid = await pollOzonCargoLabels(operationId, ozonApiOpts);
    const buffer = await ozonApiGetBinary(
      `/v1/cargoes-label/file/${encodeURIComponent(fileGuid)}`,
      ozonCfg
    );
    fs.writeFileSync(cachePath, buffer);
    return { buffer, cached: false, cargoIds: ids, fileGuid };
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
