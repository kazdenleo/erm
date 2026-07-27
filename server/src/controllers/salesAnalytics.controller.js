import salesAnalyticsService from '../services/salesAnalytics.service.js';
import marketplaceCategoryAnalyticsService from '../services/marketplaceCategoryAnalytics.service.js';

export async function getFbsByProduct(req, res) {
  const profileId = req.user?.profileId ?? null;
  const { dateFrom, dateTo, marketplace, limit } = req.query || {};
  const data = await salesAnalyticsService.getFbsByProduct({
    profileId,
    dateFrom,
    dateTo,
    marketplace,
    limit,
  });
  return res.json({ ok: true, data });
}

export async function getByCategory(req, res) {
  const profileId = req.user?.profileId ?? null;
  const { dateFrom, dateTo, marketplace, scheme } = req.query || {};
  const data = await marketplaceCategoryAnalyticsService.getByCategory({
    profileId,
    dateFrom,
    dateTo,
    marketplace,
    scheme,
  });
  return res.json({ ok: true, data });
}
