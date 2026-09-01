import salesAnalyticsService from '../services/salesAnalytics.service.js';
import marketplaceCategoryAnalyticsService from '../services/marketplaceCategoryAnalytics.service.js';
import marketplaceTurnoverAnalyticsService from '../services/marketplaceTurnoverAnalytics.service.js';
import marketplaceCardWorkService from '../services/marketplaceCardWork.service.js';

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

export async function getProductDynamics(req, res) {
  const profileId = req.user?.profileId ?? null;
  const {
    dateFrom,
    dateTo,
    comparePeriods,
    granularity,
    marketplace,
    scheme,
    productId,
  } = req.query || {};
  const data = await marketplaceCategoryAnalyticsService.getProductDynamics({
    profileId,
    dateFrom,
    dateTo,
    comparePeriods,
    granularity,
    marketplace,
    scheme,
    productId,
  });
  return res.json({ ok: true, data });
}

export async function getAbcAnalysis(req, res) {
  const profileId = req.user?.profileId ?? null;
  const { dateFrom, dateTo, marketplace, scheme } = req.query || {};
  const data = await marketplaceCategoryAnalyticsService.getAbcAnalysis({
    profileId,
    dateFrom,
    dateTo,
    marketplace,
    scheme,
  });
  return res.json({ ok: true, data });
}

export async function getTurnover(req, res) {
  const profileId = req.user?.profileId ?? null;
  const { dateFrom, dateTo, marketplace, scheme } = req.query || {};
  const data = await marketplaceTurnoverAnalyticsService.getTurnover({
    profileId,
    dateFrom,
    dateTo,
    marketplace,
    scheme,
  });
  return res.json({ ok: true, data });
}

export async function getCardWork(req, res) {
  const profileId = req.user?.profileId ?? null;
  const { dateFrom, dateTo, marketplace, scheme, reason, fastDays, slowDays, minTurnover } =
    req.query || {};
  const data = await marketplaceCardWorkService.getQueue({
    profileId,
    dateFrom,
    dateTo,
    marketplace,
    scheme,
    reason,
    fastDays,
    slowDays,
    minTurnover,
  });
  return res.json({ ok: true, data });
}
