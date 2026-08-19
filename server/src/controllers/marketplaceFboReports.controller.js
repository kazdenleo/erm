import marketplaceFboReportsService from '../services/marketplaceFboReports.service.js';

export async function syncFboReports(req, res) {
  const profileId = req.user?.profileId ?? null;
  const { dateFrom, dateTo, marketplace } = req.body || req.query || {};
  const data = await marketplaceFboReportsService.sync({
    profileId,
    dateFrom,
    dateTo,
    marketplace,
  });
  return res.json({ ok: true, data });
}

export async function getFboByProduct(req, res) {
  const profileId = req.user?.profileId ?? null;
  const { dateFrom, dateTo, marketplace, limit } = req.query || {};
  const data = await marketplaceFboReportsService.getFboByProduct({
    profileId,
    dateFrom,
    dateTo,
    marketplace,
    limit,
  });
  return res.json({ ok: true, data });
}

export async function getFboByOrder(req, res) {
  const profileId = req.user?.profileId ?? null;
  const { dateFrom, dateTo, marketplace, limit } = req.query || {};
  const data = await marketplaceFboReportsService.getFboByOrder({
    profileId,
    dateFrom,
    dateTo,
    marketplace,
    limit,
  });
  return res.json({ ok: true, data });
}

export async function lookupFboOrder(req, res) {
  const profileId = req.user?.profileId ?? null;
  const { marketplace, orderId } = req.query || {};
  const data = await marketplaceFboReportsService.lookupByOrder({
    profileId,
    marketplace,
    orderId,
  });
  return res.json({ ok: true, data });
}
