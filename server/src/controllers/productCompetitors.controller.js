/**
 * Product Competitors Controller
 */
import productCompetitorsService from '../services/productCompetitors.service.js';
import { MAX_COMPETITORS_PER_MARKETPLACE } from '../services/productCompetitors.fetch.js';

class ProductCompetitorsController {
  async list(req, res) {
    const productId = Number(req.params.id);
    const items = await productCompetitorsService.listByProductId(productId);
    return res.status(200).json({
      ok: true,
      data: items,
      meta: { max_per_marketplace: MAX_COMPETITORS_PER_MARKETPLACE },
    });
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
