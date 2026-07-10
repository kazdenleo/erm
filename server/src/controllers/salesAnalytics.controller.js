import salesAnalyticsService from '../services/salesAnalytics.service.js';

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
