/**
 * Product Competitors Controller
 */
import productCompetitorsService from '../services/productCompetitors.service.js';
import { MAX_COMPETITORS_PER_MARKETPLACE } from '../services/productCompetitors.fetch.js';
import {
  listOzonCompetitorPrices,
  productHasOzonOffer,
} from '../services/ozonCompetitorPrices.service.js';
import pricesService from '../services/prices.service.js';

class ProductCompetitorsController {
  async list(req, res) {
    const productId = Number(req.params.id);
    const items = await productCompetitorsService.listByProductId(productId);
    let ozonCompetitors = [];
    let hasOzonSku = false;
    try {
      hasOzonSku = await productHasOzonOffer(productId);
      if (hasOzonSku) ozonCompetitors = await listOzonCompetitorPrices(productId);
    } catch (e) {
      if (!String(e?.message || '').includes('ozon_competitor_prices')) throw e;
    }
    return res.status(200).json({
      ok: true,
      data: items,
      ozon_competitors: ozonCompetitors,
      meta: {
        max_per_marketplace: MAX_COMPETITORS_PER_MARKETPLACE,
        has_ozon_sku: hasOzonSku,
      },
    });
  }

  async ingest(req, res) {
    const productId = Number(req.params.id);
    const user = req.user;
    const profileId =
      user && !(user.role === 'admin' && (user.profileId == null || user.profileId === ''))
        ? user.profileId ?? null
        : null;
    const result = await productCompetitorsService.ingestFromExtension(productId, req.body || {}, {
      profileId,
    });
    return res.status(result.created ? 201 : 200).json({ ok: true, created: result.created, data: result.item });
  }

  async ingestMany(req, res) {
    const productId = Number(req.params.id);
    const user = req.user;
    const profileId =
      user && !(user.role === 'admin' && (user.profileId == null || user.profileId === ''))
        ? user.profileId ?? null
        : null;
    const result = await productCompetitorsService.ingestManyFromExtension(
      productId,
      req.body?.items,
      { profileId }
    );
    return res.status(200).json({ ok: true, ...result });
  }

  async refreshOzon(req, res) {
    const productId = Number(req.params.id);
    const result = await pricesService.refreshOzonCompetitorPricesForProduct(productId);
    return res.status(200).json(result);
  }

  async add(req, res) {
    const productId = Number(req.params.id);
    const url = req.body?.url;
    const item = await productCompetitorsService.add(productId, url);
    return res.status(201).json({ ok: true, data: item });
  }

  async remove(req, res) {
    const productId = Number(req.params.id);
    const competitorId = Number(req.params.competitorId);
    await productCompetitorsService.remove(productId, competitorId);
    return res.status(200).json({ ok: true });
  }

  async refresh(req, res) {
    const productId = Number(req.params.id);
    const competitorId = req.params.competitorId ? Number(req.params.competitorId) : null;
    if (competitorId) {
      const item = await productCompetitorsService.refreshOne(competitorId);
      if (Number(item.product_id) !== productId) {
        return res.status(404).json({ ok: false, message: 'Конкурент не найден' });
      }
      return res.status(200).json({ ok: true, data: item });
    }
    const items = await productCompetitorsService.refreshProduct(productId);
    return res.status(200).json({ ok: true, data: items });
  }
}

export default new ProductCompetitorsController();
