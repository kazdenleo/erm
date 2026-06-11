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
import { tenantListProfileId, TENANT_LIST_EMPTY } from '../utils/tenantListProfileId.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const FBO_TEMPLATE_XLSX = join(__dirname, '../../templates/fbo_import_artikul_kolichestvo.xlsx');

function setAttachmentXlsx(res, filename) {
  const encoded = encodeURIComponent(filename).replace(/['()]/g, escape);
  res.setHeader('Content-Disposition', `attachment; filename="${filename}"; filename*=UTF-8''${encoded}`);
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

  async list(req, res, next) {
    try {
      const tid = tenantListProfileId(req);
      if (tid === TENANT_LIST_EMPTY) {
        return res.status(200).json({ ok: true, data: [] });
      }
      const limit = req.query.limit ? parseInt(req.query.limit, 10) : 200;
      const status = req.query.status?.trim() || null;
      const marketplace = req.query.marketplace?.trim() || null;
      const data = await fboSuppliesService.list({
        profileId: tid,
        limit,
        status,
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
      const profileId = req.user?.profileId ?? null;
      const data = await fboSuppliesService.getById(id, { profileId });
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
      return res.status(200).json({ ok: true, data });
    } catch (e) {
      if (e.statusCode === 404) {
        return res.status(404).json({ ok: false, message: e.message });
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
      const { cargoKind, palletTareWeightKg } = req.body || {};
      const data = await fboSuppliesPackingService.updateCargoUnit(
        id,
        cargoUnitId,
        { cargoKind, palletTareWeightKg },
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
      if (e.statusCode === 400 || e.statusCode === 409) {
        return res.status(e.statusCode).json({ ok: false, message: e.message });
      }
      next(e);
    }
  }
}

export default new FboSuppliesController();
