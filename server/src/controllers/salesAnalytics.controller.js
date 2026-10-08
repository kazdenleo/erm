import salesAnalyticsService from '../services/salesAnalytics.service.js';
import marketplaceCategoryAnalyticsService from '../services/marketplaceCategoryAnalytics.service.js';
import marketplaceTurnoverAnalyticsService from '../services/marketplaceTurnoverAnalytics.service.js';
import marketplaceCardWorkService from '../services/marketplaceCardWork.service.js';
import employeeMetricsService from '../services/employeeMetrics.service.js';
import companyExpensesService from '../services/companyExpenses.service.js';
import pnlAnalyticsService from '../services/pnlAnalytics.service.js';
import lostRevenueAnalyticsService from '../services/lostRevenueAnalytics.service.js';
import returnsAnalyticsService from '../services/returnsAnalytics.service.js';
import deadStockAnalyticsService from '../services/deadStockAnalytics.service.js';
import penaltiesAnalyticsService from '../services/penaltiesAnalytics.service.js';

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

export async function getCardWorkDuplicates(req, res) {
  const profileId = req.user?.profileId ?? null;
  const data = await marketplaceCardWorkService.getDuplicates({ profileId });
  return res.json({ ok: true, data });
}

export async function getCardWorkMissingCost(req, res) {
  const profileId = req.user?.profileId ?? null;
  const data = await marketplaceCardWorkService.getMissingCost({ profileId });
  return res.json({ ok: true, data });
}

export async function getLostRevenue(req, res) {
  const profileId = req.user?.profileId ?? null;
  const { dateFrom, dateTo, marketplace, scheme, limit } = req.query || {};
  const data = await lostRevenueAnalyticsService.getLostRevenue({
    profileId,
    dateFrom,
    dateTo,
    marketplace,
    scheme,
    limit,
  });
  return res.json({ ok: true, data });
}

export async function getReturns(req, res) {
  const profileId = req.user?.profileId ?? null;
  const { dateFrom, dateTo, marketplace, scheme, minReturns, ratePercent } = req.query || {};
  const data = await returnsAnalyticsService.getReturns({
    profileId,
    dateFrom,
    dateTo,
    marketplace,
    scheme,
    minReturns,
    ratePercent,
  });
  return res.json({ ok: true, data });
}

export async function getDeadStock(req, res) {
  const profileId = req.user?.profileId ?? null;
  const { noSalesDays, horizonDays, storagePerLiterDay, removalPerUnit, capitalRatePercent, mode } =
    req.query || {};
  const data = await deadStockAnalyticsService.getDeadStock({
    profileId,
    noSalesDays,
    horizonDays,
    storagePerLiterDay,
    removalPerUnit,
    capitalRatePercent,
    mode,
  });
  return res.json({ ok: true, data });
}

export async function getPenalties(req, res) {
  const profileId = req.user?.profileId ?? null;
  const { dateFrom, dateTo, marketplace, scheme, unpaidAfterDays } = req.query || {};
  const data = await penaltiesAnalyticsService.getPenalties({
    profileId,
    dateFrom,
    dateTo,
    marketplace,
    scheme,
    unpaidAfterDays,
  });
  return res.json({ ok: true, data });
}

export async function getEmployeeMetrics(req, res) {
  const profileId = req.user?.profileId ?? null;
  const { dateFrom, dateTo } = req.query || {};
  const data = await employeeMetricsService.getMetrics({ profileId, dateFrom, dateTo });
  return res.json({ ok: true, data });
}

export async function getPnl(req, res) {
  const profileId = req.user?.profileId ?? null;
  const { monthFrom, monthTo, marketplace, organizationId, scheme } = req.query || {};
  const data = await pnlAnalyticsService.getPnl({
    profileId,
    monthFrom,
    monthTo,
    marketplace,
    organizationId,
    scheme,
  });
  return res.json({ ok: true, data });
}

export async function listExpenses(req, res) {
  const profileId = req.user?.profileId ?? null;
  const data = await companyExpensesService.list({ profileId });
  return res.json({ ok: true, data });
}

export async function createExpense(req, res) {
  const profileId = req.user?.profileId ?? null;
  const data = await companyExpensesService.create({
    profileId,
    userId: req.user?.id ?? null,
    body: req.body || {},
  });
  return res.status(201).json({ ok: true, data });
}

export async function updateExpense(req, res) {
  const profileId = req.user?.profileId ?? null;
  const data = await companyExpensesService.update({ profileId, id: req.params?.id, body: req.body || {} });
  return res.json({ ok: true, data });
}

export async function deleteExpense(req, res) {
  const profileId = req.user?.profileId ?? null;
  const data = await companyExpensesService.remove({ profileId, id: req.params?.id });
  return res.json({ ok: true, data });
}
