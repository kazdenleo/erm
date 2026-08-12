/**
 * Обогащение карточек товаров (PartsAPI)
 */

import * as productEnrichmentService from '../services/productEnrichment.service.js';
import { resolveEffectiveProfileId } from '../utils/effectiveProfile.js';

class ProductEnrichmentController {
  async status(req, res, next) {
    try {
      const profileId = await resolveEffectiveProfileId(req, req.user);
      const data = await productEnrichmentService.getEnrichmentStatusForProfile(profileId);
      res.json({ success: true, data });
    } catch (error) {
      next(error);
    }
  }

  async enrich(req, res, next) {
    try {
      const productId = req.params.id;
      const profileId = await resolveEffectiveProfileId(req, req.user);
      const apply = req.body?.apply !== false && req.query?.dryRun !== '1';
      const result = await productEnrichmentService.enrichProductById(productId, {
        profileId,
        apply,
        dryRun: req.body?.dryRun === true || req.query?.dryRun === '1',
      });
      res.json({
        success: true,
        data: result.product,
        preview: result.preview,
      });
    } catch (error) {
      if (error?.statusCode) {
        return res.status(error.statusCode).json({
          success: false,
          error: error.message,
          message: error.message,
        });
      }
      next(error);
    }
  }

  async enrichBulk(req, res, next) {
    try {
      const profileId = await resolveEffectiveProfileId(req, req.user);
      const items = Array.isArray(req.body?.items) ? req.body.items : [];
      if (!items.length) {
        return res.status(400).json({
          success: false,
          error: 'Передайте items: [{ brand, sku }, ...]',
          message: 'Передайте items: [{ brand, sku }, ...]',
        });
      }
      if (items.length > 500) {
        return res.status(400).json({
          success: false,
          error: 'За один раз не больше 500 позиций',
          message: 'За один раз не больше 500 позиций',
        });
      }
      const apply = req.body?.apply !== false;
      const data = await productEnrichmentService.enrichProductsByBrandSkuList(items, {
        profileId,
        apply,
      });
      res.json({ success: true, data });
    } catch (error) {
      console.error('[productEnrichment] enrichBulk:', error?.message || error, error?.stack);
      if (error?.statusCode) {
        return res.status(error.statusCode).json({
          success: false,
          error: error.message,
          message: error.message,
        });
      }
      next(error);
    }
  }
}

export default new ProductEnrichmentController();
