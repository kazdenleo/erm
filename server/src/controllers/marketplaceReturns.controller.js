/**
 * Возвраты с маркетплейсов (Ozon, WB, Яндекс): список и счётчики.
 */

import { getMarketplaceReturnsStats, listMarketplaceReturns } from '../services/marketplaceReturns.service.js';
import { tenantListProfileId, TENANT_LIST_EMPTY } from '../utils/tenantListProfileId.js';

class MarketplaceReturnsController {
  parseOrganizationId(req) {
    const raw = req.get('x-organization-id') || req.get('X-Organization-Id');
    if (raw == null) return null;
    const s = String(raw).trim();
    return s === '' ? null : s;
  }

  buildOptions(req) {
    const q = req.query || {};
    return {
      organizationId: this.parseOrganizationId(req),
      marketplace: q.marketplace || 'all',
      filter: q.filter || 'waiting',
      dateFrom: q.dateFrom || null,
      dateTo: q.dateTo || null,
      days: q.days != null ? Number(q.days) : undefined,
    };
  }

  emptyListResponse(res) {
    res.setHeader('Cache-Control', 'no-store');
    return res.status(200).json({
      ok: true,
      data: [],
      meta: {
        waitingCount: 0,
        countsByMarketplace: { ozon: 0, wildberries: 0, yandex: 0 },
      },
    });
  }

  emptyStatsResponse(res) {
    res.setHeader('Cache-Control', 'no-store');
    return res.status(200).json({
      ok: true,
      data: {
        waitingCount: 0,
        totalCount: 0,
        countsByMarketplace: { ozon: 0, wildberries: 0, yandex: 0 },
      },
    });
  }

  async getList(req, res, next) {
    try {
      const tid = tenantListProfileId(req);
      if (tid === TENANT_LIST_EMPTY || tid == null) {
        return this.emptyListResponse(res);
      }
      const { items, meta } = await listMarketplaceReturns(tid, this.buildOptions(req));
      res.setHeader('Cache-Control', 'no-store');
      return res.status(200).json({ ok: true, data: items, meta });
    } catch (error) {
      next(error);
    }
  }

  async getStats(req, res, next) {
    try {
      const tid = tenantListProfileId(req);
      if (tid === TENANT_LIST_EMPTY || tid == null) {
        return this.emptyStatsResponse(res);
      }
      const data = await getMarketplaceReturnsStats(tid, this.buildOptions(req));
      res.setHeader('Cache-Control', 'no-store');
      return res.status(200).json({ ok: true, data });
    } catch (error) {
      next(error);
    }
  }
}

export default new MarketplaceReturnsController();
