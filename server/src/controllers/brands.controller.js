/**
 * Brands Controller
 * Контроллер для управления брендами
 */

import repositoryFactory from '../config/repository-factory.js';
import { tenantListProfileId, TENANT_LIST_EMPTY } from '../utils/tenantListProfileId.js';
import {
  attachBrandDetails,
  syncBrandMappingsFromCatalog,
  normalizeMappingsPayload,
  scheduleOzonMinPriceRecalcForBrand,
  promoSettingsChanged,
} from '../services/brands.service.js';

const brandsRepository = repositoryFactory.getBrandsRepository();

async function assertBrandAccess(brandId, profileId) {
  const cur = await brandsRepository.findById(brandId);
  if (!cur) {
    const err = new Error('Бренд не найден');
    err.statusCode = 404;
    throw err;
  }
  if (Number(cur.profile_id) !== Number(profileId)) {
    const err = new Error('Нет доступа');
    err.statusCode = 403;
    throw err;
  }
  return cur;
}

export const brandsController = {
  async getAll(req, res, next) {
    try {
      const tid = tenantListProfileId(req);
      if (tid === TENANT_LIST_EMPTY) {
        return res.json({ ok: true, data: [] });
      }
      const brands = await brandsRepository.findAll(tid != null ? { profileId: tid } : {});
      const enriched = await Promise.all(brands.map((b) => attachBrandDetails(b)));
      res.json({ ok: true, data: enriched });
    } catch (error) {
      next(error);
    }
  },

  async getById(req, res, next) {
    try {
      const { id } = req.params;
      const brand = await brandsRepository.findById(id);
      if (!brand) {
        return res.status(404).json({ ok: false, message: 'Бренд не найден' });
      }
      res.json({ ok: true, data: await attachBrandDetails(brand) });
    } catch (error) {
      next(error);
    }
  },

  async create(req, res, next) {
    try {
      const tid = tenantListProfileId(req);
      if (tid === TENANT_LIST_EMPTY || tid == null) {
        return res.status(403).json({ ok: false, message: 'Нет привязки к аккаунту' });
      }
      const brandData = req.body;
      const brand = await brandsRepository.create(brandData, { profileId: tid });
      const mappings = normalizeMappingsPayload(brandData.marketplace_mappings ?? brandData.marketplaceMappings);
      if (mappings.length > 0 && brand?.id) {
        await brandsRepository.replaceMarketplaceMappings(brand.id, mappings);
      }
      res.status(201).json({ ok: true, data: await attachBrandDetails(brand) });
    } catch (error) {
      next(error);
    }
  },

  async update(req, res, next) {
    try {
      const tid = tenantListProfileId(req);
      if (tid === TENANT_LIST_EMPTY || tid == null) {
        return res.status(403).json({ ok: false, message: 'Нет привязки к аккаунту' });
      }
      const { id } = req.params;
      const prev = await assertBrandAccess(id, tid);
      const updates = req.body;
      const brand = await brandsRepository.update(id, updates);
      if (!brand) {
        return res.status(404).json({ ok: false, message: 'Бренд не найден' });
      }
      if (updates.marketplace_mappings != null || updates.marketplaceMappings != null) {
        const mappings = normalizeMappingsPayload(
          updates.marketplace_mappings ?? updates.marketplaceMappings
        );
        await brandsRepository.replaceMarketplaceMappings(id, mappings);
      }
      if (promoSettingsChanged(updates, prev)) {
        scheduleOzonMinPriceRecalcForBrand(id);
      }
      res.json({ ok: true, data: await attachBrandDetails(brand) });
    } catch (error) {
      if (error.statusCode) return res.status(error.statusCode).json({ ok: false, message: error.message });
      next(error);
    }
  },

  async delete(req, res, next) {
    try {
      const tid = tenantListProfileId(req);
      if (tid === TENANT_LIST_EMPTY || tid == null) {
        return res.status(403).json({ ok: false, message: 'Нет привязки к аккаунту' });
      }
      const { id } = req.params;
      await assertBrandAccess(id, tid);
      const deleted = await brandsRepository.delete(id);
      if (!deleted) {
        return res.status(404).json({ ok: false, message: 'Бренд не найден' });
      }
      res.json({ ok: true, message: 'Бренд удален' });
    } catch (error) {
      if (error.statusCode) return res.status(error.statusCode).json({ ok: false, message: error.message });
      next(error);
    }
  },

  /** POST /brands/:id/sync-mp-brands — подсказки и опционально применение сопоставлений */
  async syncMpBrands(req, res, next) {
    try {
      const tid = tenantListProfileId(req);
      if (tid === TENANT_LIST_EMPTY || tid == null) {
        return res.status(403).json({ ok: false, message: 'Нет привязки к аккаунту' });
      }
      const { id } = req.params;
      const brand = await assertBrandAccess(id, tid);
      const apply = req.body?.apply !== false;
      const result = await syncBrandMappingsFromCatalog(id, tid, { apply });
      res.json({
        ok: true,
        data: {
          ...result,
          brand: await attachBrandDetails(brand),
        },
      });
    } catch (error) {
      if (error.statusCode) return res.status(error.statusCode).json({ ok: false, message: error.message });
      next(error);
    }
  },

  /** GET /brands/:id/mp-brand-candidates */
  async getMpBrandCandidates(req, res, next) {
    try {
      const tid = tenantListProfileId(req);
      if (tid === TENANT_LIST_EMPTY || tid == null) {
        return res.status(403).json({ ok: false, message: 'Нет привязки к аккаунту' });
      }
      const { id } = req.params;
      await assertBrandAccess(id, tid);
      const result = await syncBrandMappingsFromCatalog(id, tid, { apply: false });
      res.json({
        ok: true,
        data: result.suggestions,
      });
    } catch (error) {
      if (error.statusCode) return res.status(error.statusCode).json({ ok: false, message: error.message });
      next(error);
    }
  },
};
