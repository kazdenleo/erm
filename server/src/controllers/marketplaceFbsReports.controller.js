import marketplaceFbsReportsService from '../services/marketplaceFbsReports.service.js';

export async function syncFbsReports(req, res) {
  const profileId = req.user?.profileId ?? null;
  const { dateFrom, dateTo, marketplace } = req.body || req.query || {};
  const data = await marketplaceFbsReportsService.sync({
    profileId,
    dateFrom,
    dateTo,
    marketplace,
  });
  return res.json({ ok: true, data });
}

export async function getFbsByProduct(req, res) {
  const profileId = req.user?.profileId ?? null;
  const { dateFrom, dateTo, marketplace, limit } = req.query || {};
  const data = await marketplaceFbsReportsService.getFbsByProduct({
    profileId,
    dateFrom,
    dateTo,
    marketplace,
    limit,
  });
  return res.json({ ok: true, data });
}

export async function getFbsByOrder(req, res) {
  const profileId = req.user?.profileId ?? null;
  const { dateFrom, dateTo, marketplace, limit } = req.query || {};
  const data = await marketplaceFbsReportsService.getFbsByOrder({
    profileId,
    dateFrom,
    dateTo,
    marketplace,
    limit,
  });
  return res.json({ ok: true, data });
}

export async function lookupFbsOrder(req, res) {
  const profileId = req.user?.profileId ?? null;
  const { marketplace, orderId } = req.query || {};
  const data = await marketplaceFbsReportsService.lookupByOrder({
    profileId,
    marketplace,
    orderId,
  });
  return res.json({ ok: true, data });
}
