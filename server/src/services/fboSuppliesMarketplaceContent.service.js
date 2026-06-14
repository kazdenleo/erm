/**
 * Синхронизация товарного состава поставки FBO с маркетплейсом.
 */

import { query } from '../config/database.js';
import integrationsService from './integrations.service.js';
import fboSuppliesService from './fboSupplies.service.js';
import fboSuppliesImportService from './fboSuppliesImport.service.js';

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

function extractOzonContentUpdateStatus(data) {
  const root = data?.result ?? data ?? {};
  const status = String(root.status ?? root.state ?? '').toUpperCase();
  const errors = root.errors ?? root.error ?? root.editing_errors ?? null;
  return { status, errors, raw: root };
}

function resolveOzonContentUpdateSku(item) {
  const mpProduct = item.mpProductId ?? item.mp_product_id;
  const fromMp = Number(mpProduct);
  if (Number.isFinite(fromMp) && fromMp > 0) return fromMp;

  const offer = item.sku ?? item.mpOfferId ?? item.mp_offer_id;
  if (offer != null && String(offer).trim() !== '') {
    const asNum = Number(offer);
    if (Number.isFinite(asNum) && asNum > 0 && String(asNum) === String(offer).trim()) {
      return asNum;
    }
  }
  return null;
}

function buildOzonContentItems(supplyItems) {
  const items = [];
  const missing = [];
  for (const it of supplyItems || []) {
    const qty = Number(it.quantity);
    if (!qty || qty <= 0) continue;
    const sku = resolveOzonContentUpdateSku(it);
    if (!sku) {
      missing.push(it.sku || it.productName || it.name || `строка #${it.id}`);
      continue;
    }
    items.push({ sku, quantity: qty, quant: qty });
  }
  if (missing.length) {
    const err = new Error(
      `Не удалось сопоставить товары с Ozon (нужен числовой SKU Ozon): ${missing.slice(0, 5).join(', ')}${
        missing.length > 5 ? '…' : ''
      }`
    );
    err.statusCode = 400;
    throw err;
  }
  if (!items.length) {
    const err = new Error('В поставке нет строк с количеством для отправки на Ozon');
    err.statusCode = 400;
    throw err;
  }
  return items;
}

async function pollOzonContentUpdateStatus(operationId, ozonApiOpts, { maxAttempts = 15 } = {}) {
  for (let i = 0; i < maxAttempts; i++) {
    if (i > 0) {
      await new Promise((r) => setTimeout(r, 1500));
    }
    const data = await integrationsService._ozonApiPost(
      '/v1/supply-order/content/update/status',
      { operation_id: operationId },
      ozonApiOpts
    );
    const info = extractOzonContentUpdateStatus(data);
    if (info.status === 'SUCCESS' || info.status === 'COMPLETED' || info.status === 'DONE') {
      return { ok: true, status: info.status, data: info.raw };
    }
    if (info.status === 'FAILED' || info.status === 'ERROR') {
      const err = new Error(
        typeof info.errors === 'string'
          ? info.errors
          : info.errors?.message ||
            (Array.isArray(info.errors) ? info.errors.map((e) => e?.message || e).join('; ') : null) ||
            'Ozon отклонил обновление состава поставки'
      );
      err.statusCode = 400;
      err.details = info.raw;
      throw err;
    }
  }
  return {
    ok: true,
    status: 'PENDING',
    message: 'Запрос принят, проверьте статус в личном кабинете Ozon',
  };
}

function formatOzonValidationErrors(data) {
  const root = data?.result ?? data ?? {};
  const errs = root.editing_errors ?? root.errors ?? root.error;
  if (!errs) return null;
  if (typeof errs === 'string') return errs;
  if (Array.isArray(errs)) {
    return errs
      .map((e) => (typeof e === 'string' ? e : e?.message || e?.description || JSON.stringify(e)))
      .filter(Boolean)
      .join('; ');
  }
  if (typeof errs === 'object' && errs.message) return String(errs.message);
  return null;
}

class FboSuppliesMarketplaceContentService {
  async syncSupplyContentToMarketplace(supplyId, { profileId } = {}) {
    const supply = await fboSuppliesService.getById(supplyId, { profileId });
    const mp = normalizeMp(supply.marketplace);
    const mpLabel = mpLabelRu(mp);

    if (mp === 'wb' || mp === 'ym') {
      const err = new Error(
        `Обновление состава поставки на ${mpLabel} через API недоступно — измените состав в личном кабинете маркетплейса`
      );
      err.statusCode = 400;
      err.code = mp === 'wb' ? 'WB_CONTENT_SYNC_NOT_SUPPORTED' : 'YM_CONTENT_SYNC_NOT_SUPPORTED';
      throw err;
    }

    const extSupply =
      supply.externalSupplyId != null ? String(supply.externalSupplyId).trim() : '';
    const extNum =
      supply.externalShipmentNumber != null ? String(supply.externalShipmentNumber).trim() : '';
    if (!extSupply && !extNum) {
      const err = new Error('У поставки не указан номер отгрузки или ID поставки на Ozon');
      err.statusCode = 400;
      throw err;
    }

    const items = buildOzonContentItems(supply.items);
    const { orderId, supplyId: ozonSupplyId } =
      await fboSuppliesImportService.resolveOzonSupplyApiIds(supplyId, { profileId });

    const body = {
      order_id: orderId,
      supply_id: ozonSupplyId,
      items,
    };

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

    try {
      const validation = await integrationsService._ozonApiPost(
        '/v1/supply-order/content/update/validation',
        body,
        ozonApiOpts
      );
      const validationErr = formatOzonValidationErrors(validation);
      if (validationErr) {
        const err = new Error(`Ozon не принимает новый состав: ${validationErr}`);
        err.statusCode = 400;
        err.details = validation?.result ?? validation;
        throw err;
      }
    } catch (e) {
      if (e.statusCode === 400 && e.message?.startsWith('Ozon не принимает')) throw e;
      /* validation endpoint may be unavailable — continue with update */
    }

    const updateData = await integrationsService._ozonApiPost(
      '/v1/supply-order/content/update',
      body,
      ozonApiOpts
    );
    const operationId = extractOzonOperationId(updateData);

    let pollResult = null;
    if (operationId) {
      pollResult = await pollOzonContentUpdateStatus(operationId, ozonApiOpts);
    }

    await query(
      `UPDATE fbo_supplies
       SET pending_mp_content_update = FALSE,
           marketplace_content_synced_at = CURRENT_TIMESTAMP,
           updated_at = CURRENT_TIMESTAMP
       WHERE id = $1`,
      [supplyId]
    );
    await query(
      `UPDATE fbo_supply_items
       SET mp_quantity = quantity, updated_at = CURRENT_TIMESTAMP
       WHERE fbo_supply_id = $1`,
      [supplyId]
    );

    return {
      message:
        pollResult?.message ||
        (pollResult?.status === 'PENDING'
          ? `Запрос на обновление состава отправлен в ${mpLabel}`
          : `Состав поставки обновлён на ${mpLabel}`),
      operationId: operationId ?? null,
      status: pollResult?.status ?? 'SUBMITTED',
      itemCount: items.length,
    };
  }
}

export default new FboSuppliesMarketplaceContentService();
