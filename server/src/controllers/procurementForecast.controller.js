import procurementForecastService from '../services/procurementForecast.service.js';

export async function getFbsForecast(req, res) {
  const profileId = req.user?.profileId ?? null;
  const {
    organizationId,
    warehouseId,
    salesDateFrom,
    salesDateTo,
    procurementDays,
    bufferPercent,
  } = req.query || {};

  const data = await procurementForecastService.getFbsForecast({
    profileId,
    organizationId,
    warehouseId,
    salesDateFrom,
    salesDateTo,
    procurementDays,
    bufferPercent,
  });

  return res.json({ ok: true, data });
}
