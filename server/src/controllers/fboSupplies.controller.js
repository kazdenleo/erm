/**
 * FBO Supplies Controller
 */

import { readFileSync, existsSync } from 'fs';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';
import fboSuppliesService from '../services/fboSupplies.service.js';
import fboSuppliesImportService from '../services/fboSuppliesImport.service.js';
import fboSuppliesExportService from '../services/fboSuppliesExport.service.js';
import fboSuppliesPackingService from '../services/fboSuppliesPacking.service.js';
import fboSuppliesPurchaseCalcService from '../services/fboSuppliesPurchaseCalc.service.js';
import fboPurchaseCalcSessionService from '../services/fboPurchaseCalcSession.service.js';
import fboSuppliesSubmitService from '../services/fboSuppliesSubmit.service.js';
import fboSuppliesOzonCargoesService from '../services/fboSuppliesOzonCargoes.service.js';
import fboSuppliesMarketplaceContentService from '../services/fboSuppliesMarketplaceContent.service.js';
import fboSupplyForecastService from '../services/fboSupplyForecast.service.js';
import { tenantListProfileId, TENANT_LIST_EMPTY } from '../utils/tenantListProfileId.js';
import { FBO_SUPPLY_STATUSES } from '../constants/fboSupplyStatuses.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const FBO_TEMPLATE_XLSX = join(__dirname, '../../templates/fbo_import_artikul_kolichestvo.xlsx');

function setAttachmentXlsx(res, filename) {
  const encoded = encodeURIComponent(filename).replace(/['()]/g, escape);
  res.setHeader('Content-Disposition', `attachment; filename="${filename}"; filename*=UTF-8''${encoded}`);
}

/** Статусы списка FBO: ?statuses=new,packed или повтор status=. */
function parseFboListStatuses(query = {}) {
  const allowed = new Set(FBO_SUPPLY_STATUSES);
  const raw = [];
  const multi = query.statuses;
  if (Array.isArray(multi)) {
    for (const v of multi) raw.push(...String(v).split(','));
  } else if (multi != null && String(multi).trim() !== '') {
    raw.push(...String(multi).split(','));
  }
  const single = query.status;
  if (Array.isArray(single)) {
    for (const v of single) raw.push(...String(v).split(','));
  } else if (single != null && String(single).trim() !== '') {
    raw.push(...String(single).split(','));
  }
  const out = [];
  for (const part of raw) {
    const key = String(part || '').trim().toLowerCase();
    if (!key || !allowed.has(key) || out.includes(key)) continue;
    out.push(key);
  }
  return out.length > 0 ? out : null;
}

/** Профиль для сессий расчёта закупки — как у списка поставок + заголовок X-Account-Id. */
function resolveFboProfileId(req) {
  const tid = tenantListProfileId(req);
  if (tid === TENANT_LIST_EMPTY) {
    const h = req.get('x-account-id') || req.get('X-Account-Id');
    const n = h != null && String(h).trim() !== '' ? Number(String(h).trim()) : NaN;
    return Number.isFinite(n) && n > 0 ? n : TENANT_LIST_EMPTY;
  }
  if (tid == null) {
    const h = req.get('x-account-id') || req.get('X-Account-Id');
    const n = h != null && String(h).trim() !== '' ? Number(String(h).trim()) : NaN;
    if (Number.isFinite(n) && n > 0) return n;
    return null;
  }
  return tid;
}

/** Организация из тела запроса или заголовка (как на странице «Интеграции»). */
function resolveOrganizationIdFromRequest(req) {
  const fromBody = req.body?.organizationId ?? req.body?.organization_id ?? null;
  if (fromBody != null && String(fromBody).trim() !== '') return String(fromBody).trim();
  const orgHeader = req.get('x-organization-id') || req.get('X-Organization-Id');
  if (orgHeader != null && String(orgHeader).trim() !== '') return String(orgHeader).trim();
  return null;
}

class FboSuppliesController {
  async listDeductionWarehouses(req, res, next) {
    try {
      const tid = tenantListProfileId(req);
      if (tid === TENANT_LIST_EMPTY) {
        return res.status(200).json({ ok: true, data: [] });
      }
      const orgQ = req.query?.organizationId;
      const organizationId =
        orgQ != null && String(orgQ).trim() !== '' ? String(orgQ).trim() : null;
      const data = await fboSuppliesService.listDeductionWarehouses({
        profileId: tid,
        organizationId,
      });
      return res.status(200).json({ ok: true, data });
    } catch (e) {
      next(e);
    }
  }

  async getWbForecast(req, res, next) {
    try {
      const tid = resolveFboProfileId(req);
      if (tid === TENANT_LIST_EMPTY) {
        return res.status(200).json({
          ok: true,
          data: {
            syncedAt: null,
            rows: [],
            warehouses: [],
            totals: { quantity: 0, inWayToClient: 0, inWayFromClient: 0, rowCount: 0 },
          },
        });
      }
      const organizationId = resolveOrganizationIdFromRequest(req) || req.query?.organizationId || null;
      const warehouseId = req.query?.warehouseId ?? req.query?.warehouse_id ?? null;
      const search = req.query?.q ?? req.query?.search ?? null;
      const unlinkedOnly =
        req.query?.unlinkedOnly === '1' ||
        req.query?.unlinkedOnly === 'true' ||
        req.query?.unlinked === '1';
      const planDaysRaw = req.query?.planDays ?? req.query?.plan_days ?? req.query?.periodDays ?? null;
      const planDays =
        planDaysRaw != null && String(planDaysRaw).trim() !== '' ? Number(planDaysRaw) : 30;
      const data = await fboSupplyForecastService.getWbForecast({
        profileId: tid,
        organizationId,
        warehouseId,
        search,
        unlinkedOnly,
        planDays,
      });
      return res.status(200).json({ ok: true, data });
    } catch (e) {
      next(e);
    }
  }

  async syncWbForecast(req, res, next) {
    try {
      const tid = resolveFboProfileId(req);
      if (tid === TENANT_LIST_EMPTY) {
        return res.status(400).json({ ok: false, message: 'Не выбран профиль' });
      }
      const organizationId = resolveOrganizationIdFromRequest(req);
      const data = await fboSupplyForecastService.syncWb({
        profileId: tid,
        organizationId,
      });
      return res.status(200).json({ ok: true, data });
    } catch (e) {
      if (e.statusCode === 429) {
        return res.status(429).json({
          ok: false,
          message: e.message,
          retryAfterSec: e.retryAfterSec ?? null,
        });
      }
      if (e.statusCode === 400) {
        return res.status(400).json({ ok: false, message: e.message });
      }
      if (e.statusCode === 502) {
        return res.status(502).json({ ok: false, message: e.message });
      }
      next(e);
    }
  }

  async list(req, res, next) {
    try {
      const tid = tenantListProfileId(req);
      if (tid === TENANT_LIST_EMPTY) {
        return res.status(200).json({ ok: true, data: [] });
      }
      const limit = req.query.limit ? parseInt(req.query.limit, 10) : 200;
      const statuses = parseFboListStatuses(req.query);
      const marketplace = req.query.marketplace?.trim() || null;
      const data = await fboSuppliesService.list({
        profileId: tid,
        limit,
        statuses,
        marketplace,
      });
      return res.status(200).json({ ok: true, data });
    } catch (e) {
      next(e);
    }
  }

  async getById(req, res, next) {
    try {
      const { id } = req.params;
      const tid = tenantListProfileId(req);
      if (tid === TENANT_LIST_EMPTY) {
        return res.status(404).json({ ok: false, message: 'Поставка FBO не найдена' });
      }
      const skipReserveEnrichment =
        req.query.skipReserve === '1' ||
        req.query.skipReserve === 'true' ||
        req.query.light === '1';
      const data = await fboSuppliesService.getById(id, {
        profileId: tid,
        skipReserveEnrichment,
      });
      return res.status(200).json({ ok: true, data });
    } catch (e) {
      if (e.statusCode === 404) {
        return res.status(404).json({ ok: false, message: e.message });
      }
      next(e);
    }
  }

  async create(req, res, next) {
    try {
      const profileId = req.user?.profileId ?? null;
      const userId = req.user?.id ?? null;
      const data = await fboSuppliesService.create(req.body || {}, { profileId, userId });
      return res.status(201).json({ ok: true, data });
    } catch (e) {
      if (e.statusCode === 400 || e.statusCode === 409) {
        return res.status(e.statusCode).json({ ok: false, message: e.message, code: e.code });
      }
      next(e);
    }
  }

  async update(req, res, next) {
    try {
      const { id } = req.params;
      const profileId = req.user?.profileId ?? null;
      const data = await fboSuppliesService.update(id, req.body || {}, { profileId });
      return res.status(200).json({ ok: true, data });
    } catch (e) {
      if (e.statusCode === 400 || e.statusCode === 404) {
        return res.status(e.statusCode).json({ ok: false, message: e.message });
      }
      next(e);
    }
  }

  async advanceStatus(req, res, next) {
    try {
      const { id } = req.params;
      const profileId = req.user?.profileId ?? null;
      const data = await fboSuppliesService.advanceStatus(id, { profileId });
      return res.status(200).json({ ok: true, data });
    } catch (e) {
      if (e.statusCode === 400 || e.statusCode === 404) {
        return res.status(e.statusCode).json({ ok: false, message: e.message });
      }
      if (/PostgreSQL pool is not initialized/i.test(String(e?.message || ''))) {
        return res.status(503).json({
          ok: false,
          message:
            'Временная ошибка подключения к базе данных. Подождите 10–20 секунд и повторите. Если не помогло — сообщите администратору.',
          code: 'DB_POOL_NOT_READY',
        });
      }
      next(e);
    }
  }

  async syncOzonPlacementZones(req, res, next) {
    try {
      const { id } = req.params;
      const profileId = req.user?.profileId ?? null;
      const data = await fboSuppliesImportService.syncOzonPlacementZones(id, { profileId });
      return res.status(200).json({ ok: true, data });
    } catch (e) {
      if (e.statusCode === 400 || e.statusCode === 404) {
        return res.status(e.statusCode).json({ ok: false, message: e.message });
      }
      next(e);
    }
  }

  async syncMarketplaceStatus(req, res, next) {
    try {
      const { id } = req.params;
      const profileId = req.user?.profileId ?? null;
      const data = await fboSuppliesImportService.syncSupplyStatusFromMarketplace(id, { profileId });
      return res.status(200).json({ ok: true, data });
    } catch (e) {
      if (e.statusCode === 400 || e.statusCode === 404) {
        return res.status(e.statusCode).json({ ok: false, message: e.message });
      }
      next(e);
    }
  }

  async syncMarketplaceContent(req, res, next) {
    try {
      const { id } = req.params;
      const profileId = req.user?.profileId ?? null;
      const data = await fboSuppliesMarketplaceContentService.syncSupplyContentToMarketplace(id, {
        profileId,
      });
      const supply = await fboSuppliesService.getById(id, { profileId });
      return res.status(200).json({ ok: true, data: { ...data, supply } });
    } catch (e) {
      if (e.statusCode === 400 || e.statusCode === 404 || e.statusCode === 409) {
        return res.status(e.statusCode).json({
          ok: false,
          message: e.message,
          code: e.code || undefined,
        });
      }
      next(e);
    }
  }

  async pullMarketplaceContent(req, res, next) {
    try {
      const { id } = req.params;
      const profileId = req.user?.profileId ?? null;
      const data = await fboSuppliesImportService.pullMarketplaceContentFromMarketplace(id, {
        profileId,
      });
      return res.status(200).json({ ok: true, data });
    } catch (e) {
      if (e.statusCode === 400 || e.statusCode === 404) {
        return res.status(e.statusCode).json({ ok: false, message: e.message });
      }
      next(e);
    }
  }

  async submitPackingToMarketplace(req, res, next) {
    try {
      const { id } = req.params;
      const profileId = req.user?.profileId ?? null;
      const data = await fboSuppliesSubmitService.submitPackingToMarketplace(id, { profileId });
      return res.status(200).json({ ok: true, data });
    } catch (e) {
      if (e.statusCode === 400 || e.statusCode === 404 || e.statusCode === 409) {
        return res.status(e.statusCode).json({
          ok: false,
          message: e.message,
          code: e.code || undefined,
        });
      }
      next(e);
    }
  }

  async delete(req, res, next) {
    try {
      const { id } = req.params;
      const profileId = req.user?.profileId ?? null;
      const data = await fboSuppliesService.delete(id, { profileId });
      return res.status(200).json({ ok: true, data });
    } catch (e) {
      if (e.statusCode === 404) {
        return res.status(404).json({ ok: false, message: e.message });
      }
      next(e);
    }
  }

  async downloadImportTemplateExcel(req, res, next) {
    try {
      let buffer;
      if (existsSync(FBO_TEMPLATE_XLSX)) {
        buffer = readFileSync(FBO_TEMPLATE_XLSX);
      } else {
        buffer = await fboSuppliesExportService.buildImportTemplateBuffer();
      }
      const date = new Date().toISOString().slice(0, 10);
      const filename = `fbo_postavka_artikul_kolichestvo_${date}.xlsx`;
      res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
      res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate');
      res.setHeader('Pragma', 'no-cache');
      res.setHeader('X-Fbo-Template-Version', 'sku-quantity-v2');
      setAttachmentXlsx(res, filename);
      res.send(buffer);
    } catch (e) {
      next(e);
    }
  }

  async previewApiImport(req, res, next) {
    try {
      const profileId = req.user?.profileId ?? null;
      const { marketplace, daysBack } = req.body || {};
      const organizationId = resolveOrganizationIdFromRequest(req);
      const data = await fboSuppliesImportService.fetchMarketplacePreview({
        marketplace,
        profileId,
        organizationId,
        daysBack,
      });
      return res.status(200).json({ ok: true, data });
    } catch (e) {
      if (e.statusCode === 400) {
        return res.status(400).json({ ok: false, message: e.message });
      }
      next(e);
    }
  }

  async previewExcelImport(req, res, next) {
    try {
      const profileId = req.user?.profileId ?? null;
      if (!req.file?.buffer) {
        return res.status(400).json({ ok: false, message: 'Загрузите файл Excel (.xlsx)' });
      }
      const data = await fboSuppliesImportService.parseExcelBuffer(req.file.buffer, { profileId });
      return res.status(200).json({ ok: true, data });
    } catch (e) {
      if (e.statusCode === 400) {
        return res.status(400).json({ ok: false, message: e.message });
      }
      next(e);
    }
  }

  async purchaseCalculation(req, res, next) {
    try {
      const profileId = req.user?.profileId ?? null;
      const supplyIds = req.body?.supplyIds ?? req.body?.ids ?? [];
      const data = await fboSuppliesPurchaseCalcService.calculate(supplyIds, { profileId });
      return res.status(200).json({ ok: true, data });
    } catch (e) {
      if (e.statusCode === 400 || e.statusCode === 404) {
        return res.status(e.statusCode).json({ ok: false, message: e.message });
      }
      next(e);
    }
  }

  async exportPurchaseCalcExcel(req, res, next) {
    try {
      const profileId = req.user?.profileId ?? null;
      const supplyIds = req.body?.supplyIds ?? req.body?.ids ?? [];
      const calcPayload = {
        supplies: req.body?.supplies,
        rows: req.body?.rows,
        totals: req.body?.totals,
        fboWarehouse: req.body?.fboWarehouse,
      };
      const buffer = await fboSuppliesExportService.buildPurchaseCalcExportBuffer(
        supplyIds,
        calcPayload,
        { profileId }
      );
      const date = new Date().toISOString().slice(0, 10);
      const filename = `fbo_raschet_zakupki_${date}.xlsx`;
      res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
      res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate');
      res.setHeader('Pragma', 'no-cache');
      setAttachmentXlsx(res, filename);
      res.send(buffer);
    } catch (e) {
      if (e.statusCode === 400 || e.statusCode === 404) {
        return res.status(e.statusCode).json({ ok: false, message: e.message });
      }
      next(e);
    }
  }

  async listPurchaseCalcSessions(req, res, next) {
    try {
      const tid = resolveFboProfileId(req);
      if (tid === TENANT_LIST_EMPTY) {
        return res.status(200).json({ ok: true, data: [] });
      }
      const data = await fboPurchaseCalcSessionService.listOpen({ profileId: tid });
      return res.status(200).json({ ok: true, data });
    } catch (e) {
      next(e);
    }
  }

  async openPurchaseCalcSession(req, res, next) {
    try {
      const tid = resolveFboProfileId(req);
      if (tid === TENANT_LIST_EMPTY || tid == null) {
        return res.status(403).json({
          ok: false,
          message: 'Действие доступно только пользователям с привязкой к аккаунту (профилю)',
        });
      }
      const profileId = tid;
      const userId = req.user?.id ?? null;
      const supplyIds = req.body?.supplyIds ?? req.body?.ids ?? [];
      const opened = await fboPurchaseCalcSessionService.openOrCreate(supplyIds, {
        profileId,
        userId,
      });
      const view = await fboPurchaseCalcSessionService.getSessionView(opened.id, { profileId });
      return res.status(200).json({
        ok: true,
        data: { ...opened, ...view },
      });
    } catch (e) {
      if (e.statusCode === 400 || e.statusCode === 403) {
        return res.status(e.statusCode).json({ ok: false, message: e.message });
      }
      next(e);
    }
  }

  async getPurchaseCalcSession(req, res, next) {
    try {
      const tid = resolveFboProfileId(req);
      if (tid === TENANT_LIST_EMPTY) {
        return res.status(403).json({ ok: false, message: 'Сессия недоступна' });
      }
      const profileId = tid;
      const sessionId = req.params.sessionId;
      const supplierId = req.query?.supplierId ?? null;
      const data = await fboPurchaseCalcSessionService.getSessionView(sessionId, {
        profileId,
        supplierId,
      });
      return res.status(200).json({ ok: true, data });
    } catch (e) {
      if (e.statusCode === 400 || e.statusCode === 404 || e.statusCode === 403) {
        return res.status(e.statusCode).json({ ok: false, message: e.message });
      }
      next(e);
    }
  }

  async createPurchaseFromCalcSession(req, res, next) {
    try {
      const tid = resolveFboProfileId(req);
      if (tid === TENANT_LIST_EMPTY || tid == null) {
        return res.status(403).json({
          ok: false,
          message: 'Действие доступно только пользователям с привязкой к аккаунту (профилю)',
        });
      }
      const profileId = tid;
      const userId = req.user?.id ?? null;
      const sessionId = req.params.sessionId;
      const body = req.body || {};
      const data = await fboPurchaseCalcSessionService.createPurchaseFromSession(sessionId, {
        supplierId: body.supplierId,
        organizationId: body.organizationId ?? resolveOrganizationIdFromRequest(req),
        warehouseId: body.warehouseId,
        items: body.items,
        note: body.note,
        userId,
        profileId,
      });
      return res.status(200).json({ ok: true, data });
    } catch (e) {
      if (e.statusCode === 400 || e.statusCode === 404 || e.statusCode === 403) {
        return res.status(e.statusCode).json({ ok: false, message: e.message });
      }
      next(e);
    }
  }

  async addSupplyItem(req, res, next) {
    try {
      const { id: supplyId } = req.params;
      const profileId = req.user?.profileId ?? null;
      const data = await fboSuppliesService.addSupplyItem(supplyId, req.body, { profileId });
      return res.status(200).json({ ok: true, data });
    } catch (e) {
      if (e.statusCode === 400 || e.statusCode === 404) {
        return res.status(e.statusCode).json({ ok: false, message: e.message });
      }
      next(e);
    }
  }

  async updateSupplyItem(req, res, next) {
    try {
      const { id: supplyId, itemId } = req.params;
      const profileId = req.user?.profileId ?? null;
      const body = req.body || {};
      let data;
      if (body.productId != null) {
        data = await fboSuppliesService.replaceSupplyItemProduct(supplyId, itemId, body, {
          profileId,
        });
      } else {
        data = await fboSuppliesService.updateSupplyItemQuantity(
          supplyId,
          itemId,
          body.quantity,
          { profileId }
        );
      }
      return res.status(200).json({ ok: true, data });
    } catch (e) {
      if (e.statusCode === 400 || e.statusCode === 404) {
        return res.status(e.statusCode).json({ ok: false, message: e.message });
      }
      next(e);
    }
  }

  async getPacking(req, res, next) {
    try {
      const { id } = req.params;
      const profileId = req.user?.profileId ?? null;
      const data = await fboSuppliesPackingService.getPackingState(id, { profileId });
      const supply = await fboSuppliesService.getById(id, { profileId });
      const mp = String(supply?.marketplace || 'ozon').toLowerCase();
      const isOzon = mp !== 'wb' && mp !== 'ym' && mp !== 'yandex';
      if (isOzon && (supply?.externalSupplyId || supply?.externalShipmentNumber)) {
        try {
          data.ozonMeta = await fboSuppliesOzonCargoesService.getPackingOzonMeta(id, { profileId });
        } catch (ozonErr) {
          data.ozonMeta = {
            error: ozonErr.message,
            canSubmitCompositionViaApi: false,
            filledCargoWarning: null,
          };
        }
      }
      return res.status(200).json({ ok: true, data });
    } catch (e) {
      if (e.statusCode === 404) {
        return res.status(404).json({ ok: false, message: e.message });
      }
      next(e);
    }
  }

  async createOzonCargoUnits(req, res, next) {
    try {
      const { id } = req.params;
      const tid = resolveFboProfileId(req);
      if (tid === TENANT_LIST_EMPTY || tid == null) {
        return res.status(403).json({
          ok: false,
          message: 'Действие доступно только пользователям с привязкой к аккаунту (профилю)',
        });
      }
      const { count, cargoKind } = req.body || {};
      const data = await fboSuppliesOzonCargoesService.createEmptyCargoesOnOzon(id, {
        count,
        cargoKind,
        profileId: tid,
      });
      return res.status(200).json({ ok: true, data });
    } catch (e) {
      if (e.statusCode === 400 || e.statusCode === 404) {
        return res.status(e.statusCode).json({
          ok: false,
          message: e.message,
          code: e.code || undefined,
        });
      }
      next(e);
    }
  }

  async syncOzonCargoUnits(req, res, next) {
    try {
      const { id } = req.params;
      const tid = resolveFboProfileId(req);
      if (tid === TENANT_LIST_EMPTY || tid == null) {
        return res.status(403).json({
          ok: false,
          message: 'Действие доступно только пользователям с привязкой к аккаунту (профилю)',
        });
      }
      const data = await fboSuppliesOzonCargoesService.syncOzonCargoesToErm(id, { profileId: tid });
      return res.status(200).json({ ok: true, data });
    } catch (e) {
      if (e.statusCode === 400 || e.statusCode === 404) {
        return res.status(e.statusCode).json({
          ok: false,
          message: e.message,
          code: e.code || undefined,
        });
      }
      next(e);
    }
  }

  async downloadCargoLabels(req, res, next) {
    try {
      const { id } = req.params;
      const tid = resolveFboProfileId(req);
      if (tid === TENANT_LIST_EMPTY || tid == null) {
        return res.status(403).json({ ok: false, message: 'Этикетки недоступны без привязки к аккаунту' });
      }
      const raw = req.query?.cargoIds ?? req.query?.cargo_ids ?? '';
      const cargoIds = String(raw)
        .split(/[,;\s]+/)
        .map((s) => s.trim())
        .filter(Boolean);
      const { buffer, cargoIds: ids } = await fboSuppliesOzonCargoesService.fetchCargoLabelsPdf(
        id,
        cargoIds,
        { profileId: tid, useCache: req.query?.refresh !== '1' }
      );
      const filename = `ozon_cargo_labels_${id}.pdf`;
      res.setHeader('Content-Type', 'application/pdf');
      res.setHeader('Content-Disposition', `inline; filename="${filename}"`);
      return res.send(buffer);
    } catch (e) {
      if (e.statusCode === 400 || e.statusCode === 404) {
        return res.status(e.statusCode).json({ ok: false, message: e.message, code: e.code });
      }
      next(e);
    }
  }

  async printCargoLabels(req, res, next) {
    try {
      const { id } = req.params;
      const tid = resolveFboProfileId(req);
      if (tid === TENANT_LIST_EMPTY || tid == null) {
        return res.status(403).send('<p>Этикетки недоступны без привязки к аккаунту</p>');
      }
      const raw = req.query?.cargoIds ?? req.query?.cargo_ids ?? '';
      const cargoIds = String(raw)
        .split(/[,;\s]+/)
        .map((s) => s.trim())
        .filter(Boolean);
      const { buffer } = await fboSuppliesOzonCargoesService.fetchCargoLabelsPdf(id, cargoIds, {
        profileId: tid,
        useCache: req.query?.refresh !== '1',
      });
      const b64 = buffer.toString('base64');
      const html = `<!DOCTYPE html>
<html>
<head>
  <meta charset="utf-8">
  <title>Этикетки грузомест</title>
  <style>body{margin:0}iframe{width:100%;height:100vh;border:none}</style>
</head>
<body>
  <iframe id="labelFrame" src="data:application/pdf;base64,${b64}"></iframe>
  <script>
    (function(){
      var done=false;
      function doPrint(){if(done)return;done=true;try{window.focus();window.print();}catch(e){}}
      document.getElementById('labelFrame').addEventListener('load',function(){setTimeout(doPrint,400);});
      setTimeout(doPrint,1500);
    })();
  </script>
</body>
</html>`;
      res.setHeader('Content-Type', 'text/html; charset=utf-8');
      return res.send(html);
    } catch (e) {
      if (e.statusCode === 400 || e.statusCode === 404) {
        return res.status(e.statusCode).send(`<p>${e.message}</p>`);
      }
      next(e);
    }
  }

  async packingScan(req, res, next) {
    try {
      const { id } = req.params;
      const profileId = req.user?.profileId ?? null;
      const { barcode, activeCargoUnitId, scanMode } = req.body || {};
      const data = await fboSuppliesPackingService.scan(
        id,
        { barcode, activeCargoUnitId, scanMode },
        { profileId }
      );
      return res.status(200).json({ ok: true, data });
    } catch (e) {
      if (e.statusCode === 400 || e.statusCode === 404 || e.statusCode === 409) {
        return res.status(e.statusCode).json({
          ok: false,
          message: e.message,
          code: e.code || undefined,
        });
      }
      next(e);
    }
  }

  async downloadPackingExcel(req, res, next) {
    try {
      const { id } = req.params;
      const profileId = req.user?.profileId ?? null;
      const { buffer, marketplace } = await fboSuppliesExportService.buildPackingExportBuffer(id, {
        profileId,
      });
      const date = new Date().toISOString().slice(0, 10);
      const mpLabel = marketplace === 'wb' ? 'wb' : 'ozon';
      const filename = `fbo_gruzomesta_${id}_${mpLabel}_${date}.xlsx`;
      res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
      res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate');
      res.setHeader('Pragma', 'no-cache');
      setAttachmentXlsx(res, filename);
      res.send(buffer);
    } catch (e) {
      if (e.statusCode === 400 || e.statusCode === 404) {
        return res.status(e.statusCode).json({ ok: false, message: e.message });
      }
      next(e);
    }
  }

  async packingUpdateContent(req, res, next) {
    try {
      const { id, contentId } = req.params;
      const profileId = req.user?.profileId ?? null;
      const { placementZone, expiresAt } = req.body || {};
      const data = await fboSuppliesPackingService.updateCargoContent(
        id,
        contentId,
        { placementZone, expiresAt },
        { profileId }
      );
      return res.status(200).json({ ok: true, data });
    } catch (e) {
      if (e.statusCode === 400 || e.statusCode === 404) {
        return res.status(e.statusCode).json({ ok: false, message: e.message });
      }
      next(e);
    }
  }

  async packingScanRemove(req, res, next) {
    try {
      const { id } = req.params;
      const profileId = req.user?.profileId ?? null;
      const { barcode, activeCargoUnitId } = req.body || {};
      const data = await fboSuppliesPackingService.scanRemove(
        id,
        { barcode, activeCargoUnitId },
        { profileId }
      );
      return res.status(200).json({ ok: true, data });
    } catch (e) {
      if (e.statusCode === 400 || e.statusCode === 404) {
        return res.status(e.statusCode).json({ ok: false, message: e.message });
      }
      next(e);
    }
  }

  async packingUpdateCargoUnit(req, res, next) {
    try {
      const { id, cargoUnitId } = req.params;
      const profileId = req.user?.profileId ?? null;
      const { cargoKind, palletTareWeightKg, barcode } = req.body || {};
      const data = await fboSuppliesPackingService.updateCargoUnit(
        id,
        cargoUnitId,
        { cargoKind, palletTareWeightKg, barcode },
        { profileId }
      );
      return res.status(200).json({ ok: true, data });
    } catch (e) {
      if (e.statusCode === 400 || e.statusCode === 404 || e.statusCode === 409) {
        return res.status(e.statusCode).json({ ok: false, message: e.message });
      }
      next(e);
    }
  }

  async deleteCargoUnit(req, res, next) {
    try {
      const { id, cargoUnitId } = req.params;
      const profileId = req.user?.profileId ?? null;
      const data = await fboSuppliesPackingService.deleteCargoUnit(id, cargoUnitId, { profileId });
      return res.status(200).json({ ok: true, data });
    } catch (e) {
      if (e.statusCode === 404) {
        return res.status(404).json({ ok: false, message: e.message });
      }
      next(e);
    }
  }

  async confirmImport(req, res, next) {
    try {
      const profileId = req.user?.profileId ?? null;
      const userId = req.user?.id ?? null;
      const { supplies, source } = req.body || {};
      const rows = (supplies || []).map((s) => ({
        ...s,
        source: s.source || source || 'api',
      }));
      const data = await fboSuppliesImportService.confirmImport(rows, { profileId, userId });
      return res.status(200).json({ ok: true, data });
    } catch (e) {
      if (e.statusCode === 400 || e.statusCode === 409 || e.statusCode === 503) {
        return res.status(e.statusCode).json({ ok: false, message: e.message });
      }
      next(e);
    }
  }
}

export default new FboSuppliesController();
