import procurementForecastService from '../services/procurementForecast.service.js';
import stockRunwayService from '../services/stockRunway.service.js';

function parseFlag(v, fallback) {
  if (v == null || v === '') return fallback;
  const s = String(v).trim().toLowerCase();
  return !(s === '0' || s === 'false' || s === 'no' || s === 'off');
}

export async function getFbsForecast(req, res) {
  const profileId = req.user?.profileId ?? null;
  const {
    organizationId,
    warehouseId,
    salesDateFrom,
    salesDateTo,
    procurementDays,
    bufferPercent,
    excludeStockoutDays,
    seasonality,
  } = req.query || {};

  const data = await procurementForecastService.getFbsForecast({
    profileId,
    organizationId,
    warehouseId,
    salesDateFrom,
    salesDateTo,
    procurementDays,
    bufferPercent,
    excludeStockoutDays: parseFlag(excludeStockoutDays, true),
    seasonality: parseFlag(seasonality, true),
  });

  return res.json({ ok: true, data });
}

export async function getLowStock(req, res) {
  const { warehouseId, periodDays, alertDays, coverDays, limit } = req.query || {};
  const data = await stockRunwayService.getRunway({
    profileId: req.user?.profileId ?? null,
    warehouseId: warehouseId || null,
    periodDays,
    alertDays,
    coverDays,
    limit,
  });
  return res.json({ ok: true, data });
}
