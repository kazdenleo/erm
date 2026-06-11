/**
 * Отправка состава упакованных грузомест на маркетплейс (Ozon FBO).
 */

import integrationsService from './integrations.service.js';
import fboSuppliesService from './fboSupplies.service.js';
import fboSuppliesPackingService from './fboSuppliesPacking.service.js';

function normalizeMp(marketplace) {
  const m = String(marketplace || 'ozon').trim().toLowerCase();
  if (m === 'wb' || m === 'wildberries') return 'wb';
  if (m === 'ym' || m === 'yandex') return 'ym';
  return 'ozon';
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

function buildOzonCargoesBody(supply, packing) {
  const ozonSupplyId = supply.externalSupplyId;
  if (!ozonSupplyId) {
    const err = new Error('У поставки не указан ID поставки Ozon (поле «ID поставки Ozon»)');
    err.statusCode = 400;
    throw err;
  }

  const cargoUnits = packing?.cargoUnits || [];
  if (!cargoUnits.length) {
    const err = new Error('Нет грузомест — сначала выполните сборку');
    err.statusCode = 400;
    throw err;
  }

  const cargoes = [];
  for (const cargo of cargoUnits) {
    const lines = cargo.contents || [];
    if (!lines.length) continue;

    const items = [];
    for (const line of lines) {
      const offerId = line.sku != null ? String(line.sku).trim() : '';
      if (!offerId) continue;
      const item = {
        offer_id: offerId,
        quantity: Number(line.quantity) || 0,
      };
      const expiry = formatOzonExpiry(line.expiresAt);
      if (expiry) item.expires_at = expiry;
      const zone = line.placementZone != null ? String(line.placementZone).trim() : '';
      if (zone) item.placement_zone = zone;
      if (item.quantity > 0) items.push(item);
    }

    if (!items.length) continue;

    const barcode = cargo.barcode != null ? String(cargo.barcode).trim() : '';
    if (!barcode) {
      const err = new Error('У грузоместа не указан штрихкод (ШК ГМ)');
      err.statusCode = 400;
      throw err;
    }

    cargoes.push({
      key: barcode,
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

    if (mp === 'wb') {
      const err = new Error(
        'Отправка состава упаковки на Wildberries через API пока недоступна — выгрузите Excel и загрузите в личном кабинете WB'
      );
      err.statusCode = 400;
      err.code = 'WB_SUBMIT_NOT_SUPPORTED';
      throw err;
    }
    if (mp === 'ym') {
      const err = new Error('Отправка состава на Яндекс Маркет через API не поддерживается');
      err.statusCode = 400;
      throw err;
    }

    const packing = await fboSuppliesPackingService.getPackingState(supplyId, { profileId });
    const body = buildOzonCargoesBody(supply, packing);

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

    const createData = await integrationsService._ozonApiPost('/v1/cargoes/create', body, ozonApiOpts);
    const operationId = extractOzonOperationId(createData);

    let pollResult = null;
    if (operationId) {
      pollResult = await pollOzonCargoesCreateInfo(operationId, ozonApiOpts);
    }

    return {
      marketplace: 'ozon',
      operationId,
      cargoCount: body.cargoes.length,
      poll: pollResult,
      message:
        pollResult?.message ||
        (pollResult?.ok
          ? `Грузоместа отправлены в Ozon (${body.cargoes.length} шт.)`
          : 'Запрос на установку грузомест отправлен в Ozon'),
    };
  }
}

export default new FboSuppliesSubmitService();
