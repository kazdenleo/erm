/**
 * Отзывы покупателей с маркетплейсов: список из БД + синхронизация из API Ozon / WB / Яндекс.
 */

import {
  getMarketplaceReviewsStats,
  listMarketplaceReviews,
  submitMarketplaceReviewAnswer,
  syncMarketplaceReviews,
} from '../services/marketplaceReviews.service.js';
import { tenantListProfileId, TENANT_LIST_EMPTY } from '../utils/tenantListProfileId.js';

class ReviewsController {
  async getList(req, res, next) {
    try {
      const tid = tenantListProfileId(req);
      if (tid === TENANT_LIST_EMPTY || tid == null) {
        res.setHeader('Cache-Control', 'no-store');
        return res.status(200).json({ ok: true, data: [] });
      }
      const items = await listMarketplaceReviews(tid, req.query || {});
      res.setHeader('Cache-Control', 'no-store');
      return res.status(200).json({ ok: true, data: items });
    } catch (error) {
      next(error);
    }
  }

  async getStats(req, res, next) {
    try {
      const tid = tenantListProfileId(req);
      if (tid === TENANT_LIST_EMPTY || tid == null) {
        res.setHeader('Cache-Control', 'no-store');
        return res.status(200).json({
          ok: true,
          data: { newCount: 0, counts: { all: 0, new: 0, answered: 0 }, countsByMarketplace: { ozon: 0, wildberries: 0, yandex: 0 } },
        });
      }
      const data = await getMarketplaceReviewsStats(tid, req.query || {});
      res.setHeader('Cache-Control', 'no-store');
      return res.status(200).json({ ok: true, data });
    } catch (error) {
      next(error);
    }
  }

  /**
   * POST /reviews/sync?marketplace=ozon — только один МП; без параметра — все три.
   */
  async sync(req, res, next) {
    try {
      const pid = req.user?.profileId;
      if (pid == null || pid === '') {
        return res.status(403).json({ ok: false, message: 'Нет привязки к аккаунту.' });
      }
      const onlyRaw = req.query?.marketplace;
      const only = onlyRaw != null && String(onlyRaw).trim() !== '' ? String(onlyRaw).trim().toLowerCase() : null;
      const data = await syncMarketplaceReviews(pid, { only });
      res.setHeader('Cache-Control', 'no-store');
      return res.status(200).json({ ok: true, data });
    } catch (error) {
      if (error.statusCode === 400 || error.statusCode === 501) {
        return res.status(error.statusCode).json({ ok: false, message: error.message });
      }
      next(error);
    }
  }

  /**
   * POST /reviews/:id/answer — тело { text }
   */
  async answer(req, res, next) {
    try {
      const pid = req.user?.profileId;
      if (pid == null || pid === '') {
        return res.status(403).json({ ok: false, message: 'Нет привязки к аккаунту.' });
      }
      const id = req.params?.id;
      const text = req.body?.text;
      const saved = await submitMarketplaceReviewAnswer(pid, id, text);
      res.setHeader('Cache-Control', 'no-store');
      return res.status(200).json({ ok: true, data: saved });
    } catch (error) {
      if ([400, 404, 501, 502].includes(error.statusCode)) {
        return res.status(error.statusCode).json({ ok: false, message: error.message });
      }
      next(error);
    }
  }
}

export default new ReviewsController();

