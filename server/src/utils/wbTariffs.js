/**
 * Разбор ответа WB GET /api/v1/tariffs/box и /api/v1/tariffs/return (разные обёртки response/data).
 *
 * Логистика мин. цены (док. WB):
 *   (база_1л + литр × доп.литры) × коэф_склада × индекс_локализации
 * В /tariffs/box поля boxDelivery* уже приходят с учётом коэф. склада — повторно не умножаем.
 * Индекс локализации в этом API нет → по умолчанию 1.
 */

export function extractWbWarehouseList(boxTariffsData) {
  if (boxTariffsData == null) return [];
  if (Array.isArray(boxTariffsData)) return boxTariffsData;

  if (typeof boxTariffsData !== 'object') return [];

  const paths = [
    boxTariffsData?.response?.data?.warehouseList,
    boxTariffsData?.response?.data?.warehouse_list,
    boxTariffsData?.response?.warehouseList,
    boxTariffsData?.data?.warehouseList,
    boxTariffsData?.data?.warehouse_list,
    boxTariffsData?.warehouseList,
    boxTariffsData?.warehouse_list,
  ];

  for (const list of paths) {
    if (Array.isArray(list) && list.length > 0) return list;
  }

  return [];
}

export function hasWbTariffsWarehouseList(boxTariffsData) {
  return extractWbWarehouseList(boxTariffsData).length > 0;
}

export function wbTariffWarehouseLabel(row) {
  return (row?.warehouseName ?? row?.geoName ?? '').toString().trim();
}

/** Поиск строки тарифа WB по имени склада или warehouseId (с учётом префикса «Маркетплейс:»). */
export function findWbTariffWarehouse(warehouseList, requestedName) {
  if (!requestedName || !Array.isArray(warehouseList) || !warehouseList.length) return null;
  const req = String(requestedName).trim();
  if (!req) return null;

  const reqId = /^\d+$/.test(req) ? req : null;
  if (reqId) {
    const byId = warehouseList.find((w) => {
      const id = w?.warehouseId ?? w?.warehouse_id ?? w?.id ?? null;
      return id != null && String(id).trim() === reqId;
    });
    if (byId) return byId;
  }

  const normalizedName = req.replace(/^Маркетплейс:\s*/i, '').trim();
  return (
    warehouseList.find((w) => {
      const wName = wbTariffWarehouseLabel(w);
      return (
        wName === req ||
        wName === normalizedName ||
        wName.toLowerCase() === req.toLowerCase() ||
        wName.toLowerCase() === normalizedName.toLowerCase()
      );
    }) || null
  );
}

/** Число из тарифа WB (запятая, пробелы). «-» и пусто → fallback. */
export function parseWbTariffAmount(value, fallback = 0) {
  if (value == null || value === '') return fallback;
  const s = String(value).trim();
  if (s === '-' || s === '—') return fallback;
  const n = parseFloat(s.replace(/\s/g, '').replace(',', '.'));
  return Number.isFinite(n) ? n : fallback;
}

/** Коэффициент склада WB из CoefExpr (%). «-» и пусто → 100%. Справочно (в мин. цене не умножаем). */
export function parseWbWarehouseCoefPercent(coefExpr) {
  const n = parseWbTariffAmount(coefExpr, NaN);
  if (Number.isFinite(n) && n > 0) return n;
  return 100;
}

/** ИЛ из настроек интеграции WB; пусто/некорректно → 1. */
export function resolveWbLocalizationIndex(value) {
  const n = Number(value);
  if (Number.isFinite(n) && n > 0) return n;
  return 1;
}

/** @deprecated Тарифы box уже с коэфом; не использовать в расчёте мин. цены. */
export function applyWbWarehouseCoef(amount, coefPercent = 100) {
  const a = Number(amount) || 0;
  if (!(a > 0)) return 0;
  const c = parseWbWarehouseCoefPercent(coefPercent);
  return Math.round(((a * c) / 100) * 100) / 100;
}

/**
 * Тарифы логистики WB по схеме из /tariffs/box.
 * base/liter — как в API (уже с коэф. склада).
 * @returns {{ rawBase: number, rawLiter: number, coef: number, source: string }|null}
 */
export function pickWbSchemeTariff(boxTariffRow, scheme = 'fbo') {
  if (!boxTariffRow || typeof boxTariffRow !== 'object') return null;
  const isFbs = String(scheme).toLowerCase() === 'fbs';
  if (isFbs) {
    const rawBase = parseWbTariffAmount(boxTariffRow.boxDeliveryMarketplaceBase);
    const rawLiter = parseWbTariffAmount(boxTariffRow.boxDeliveryMarketplaceLiter);
    const coef = parseWbWarehouseCoefPercent(boxTariffRow.boxDeliveryMarketplaceCoefExpr);
    if (rawBase > 0) {
      return { rawBase, rawLiter, coef, source: 'boxDeliveryMarketplace' };
    }
    return null;
  }
  const rawBase = parseWbTariffAmount(boxTariffRow.boxDeliveryBase);
  const rawLiter = parseWbTariffAmount(boxTariffRow.boxDeliveryLiter);
  const coef = parseWbWarehouseCoefPercent(boxTariffRow.boxDeliveryCoefExpr);
  if (rawBase > 0) {
    return { rawBase, rawLiter, coef, source: 'boxDelivery' };
  }
  return null;
}

/**
 * База + литр для обратной доставки: тариф по объёму из box (без доп. коэфа / ИЛ).
 * FBO → иначе marketplace.
 */
export function pickWbReverseDeliveryBaseLiter(boxTariffRow) {
  let picked = pickWbSchemeTariff(boxTariffRow, 'fbo');
  if (!picked) picked = pickWbSchemeTariff(boxTariffRow, 'fbs');
  if (!picked) return null;
  return {
    base: picked.rawBase,
    liter: picked.rawLiter,
    coef: 100,
    rawBase: picked.rawBase,
    rawLiter: picked.rawLiter,
    source: picked.source,
  };
}

/** Стоимость базового тарифа WB по объёму: base + liter × ceil(V−1). */
export function computeWbVolumeBaseTariff(base, liter, volumeLiters = 0) {
  const b = Number(base) || 0;
  const l = Number(liter) || 0;
  const vol = Number(volumeLiters) || 0;
  if (!(b > 0)) return 0;
  if (vol > 1) {
    return Math.round((b + l * Math.ceil(vol - 1)) * 100) / 100;
  }
  return Math.round(b * 100) / 100;
}

/**
 * Прямая логистика WB для мин. цены:
 * (база + литр × доп.) × индекс_локализации.
 * Коэф. склада не умножаем — уже заложен в boxDelivery* из API.
 * @param {number} [localizationIndex=1] — ИЛ; в /tariffs/box нет, по умолчанию 1
 */
export function computeWbLogisticsCost(
  boxTariffRow,
  volumeLiters = 0,
  scheme = 'fbo',
  localizationIndex = 1
) {
  const requested = String(scheme).toLowerCase() === 'fbs' ? 'fbs' : 'fbo';
  let picked = pickWbSchemeTariff(boxTariffRow, requested);
  if (!picked && requested === 'fbo') {
    picked = pickWbSchemeTariff(boxTariffRow, 'fbs');
  }
  if (!picked) {
    return {
      cost: 0,
      base: 0,
      liter: 0,
      coef: 100,
      rawBase: 0,
      rawLiter: 0,
      localizationIndex: 1,
      source: null,
    };
  }
  const il = Number(localizationIndex);
  const loc = Number.isFinite(il) && il > 0 ? il : 1;
  const base = picked.rawBase;
  const liter = picked.rawLiter;
  const volumeCost = computeWbVolumeBaseTariff(base, liter, volumeLiters);
  return {
    base,
    liter,
    coef: picked.coef,
    rawBase: picked.rawBase,
    rawLiter: picked.rawLiter,
    localizationIndex: loc,
    source: picked.source,
    cost: Math.round(volumeCost * loc * 100) / 100,
  };
}

/**
 * Обратная доставка WB для мин. цены (отказ/невыкуп):
 * только базовый тариф box по объёму — без коэффициента склада и без ИЛ.
 */
export function computeWbReturnAmount(boxTariffRow, volumeLiters = 0, fallback = null, preferredScheme = null) {
  const schemes = preferredScheme
    ? [String(preferredScheme).toLowerCase() === 'fbs' ? 'fbs' : 'fbo']
    : ['fbo', 'fbs'];
  for (const scheme of schemes) {
    let picked = pickWbSchemeTariff(boxTariffRow, scheme);
    if (!picked && scheme === 'fbo') {
      picked = pickWbSchemeTariff(boxTariffRow, 'fbs');
    }
    if (picked) {
      return computeWbVolumeBaseTariff(picked.rawBase, picked.rawLiter, volumeLiters);
    }
  }
  const fb = fallback && typeof fallback === 'object' ? fallback : null;
  const base = Number(fb?.rawBase ?? fb?.base);
  const liter = Number(fb?.rawLiter ?? fb?.liter);
  if (Number.isFinite(base) && base > 0) {
    return computeWbVolumeBaseTariff(base, Number.isFinite(liter) ? liter : 0, volumeLiters);
  }
  return 0;
}
