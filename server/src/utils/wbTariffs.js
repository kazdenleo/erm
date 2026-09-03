/**
 * Разбор ответа WB GET /api/v1/tariffs/box и /api/v1/tariffs/return (разные обёртки response/data).
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

/** Коэффициент склада WB из CoefExpr (%). «-» и пусто → 100%. */
export function parseWbWarehouseCoefPercent(coefExpr) {
  const n = parseWbTariffAmount(coefExpr, NaN);
  if (Number.isFinite(n) && n > 0) return n;
  return 100;
}

/** Применить коэффициент склада к сумме тарифа (база или литр). */
export function applyWbWarehouseCoef(amount, coefPercent = 100) {
  const a = Number(amount) || 0;
  if (!(a > 0)) return 0;
  const c = parseWbWarehouseCoefPercent(coefPercent);
  return Math.round(((a * c) / 100) * 100) / 100;
}

/**
 * Сырые тарифы логистики WB по схеме из строки склада /tariffs/box.
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

/** @deprecated use pickWbSchemeTariff */
export function pickWbReverseDeliveryBaseLiter(boxTariffRow) {
  const fbo = pickWbSchemeTariff(boxTariffRow, 'fbo');
  if (fbo) {
    return {
      base: applyWbWarehouseCoef(fbo.rawBase, fbo.coef),
      liter: applyWbWarehouseCoef(fbo.rawLiter, fbo.coef),
      coef: fbo.coef,
      rawBase: fbo.rawBase,
      rawLiter: fbo.rawLiter,
      source: fbo.source,
    };
  }
  const fbs = pickWbSchemeTariff(boxTariffRow, 'fbs');
  if (fbs) {
    return {
      base: applyWbWarehouseCoef(fbs.rawBase, fbs.coef),
      liter: applyWbWarehouseCoef(fbs.rawLiter, fbs.coef),
      coef: fbs.coef,
      rawBase: fbs.rawBase,
      rawLiter: fbs.rawLiter,
      source: fbs.source,
    };
  }
  return null;
}

function effectiveWbTariffFromScheme(boxTariffRow, scheme) {
  const picked = pickWbSchemeTariff(boxTariffRow, scheme);
  if (!picked) return null;
  return {
    base: applyWbWarehouseCoef(picked.rawBase, picked.coef),
    liter: applyWbWarehouseCoef(picked.rawLiter, picked.coef),
    coef: picked.coef,
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
 * Прямая логистика WB: (база × коэф) + (литр × коэф) × ceil(V−1).
 */
export function computeWbLogisticsCost(boxTariffRow, volumeLiters = 0, scheme = 'fbo') {
  const eff = effectiveWbTariffFromScheme(boxTariffRow, scheme);
  if (!eff) {
    return {
      cost: 0,
      base: 0,
      liter: 0,
      coef: 100,
      rawBase: 0,
      rawLiter: 0,
      source: null,
    };
  }
  return {
    ...eff,
    cost: computeWbVolumeBaseTariff(eff.base, eff.liter, volumeLiters),
  };
}

/**
 * Обратная доставка WB для мин. цены (отказ/невыкуп): тариф box × коэф склада по объёму.
 */
export function computeWbReturnAmount(boxTariffRow, volumeLiters = 0, fallback = null, preferredScheme = null) {
  const schemes = preferredScheme
    ? [String(preferredScheme).toLowerCase() === 'fbs' ? 'fbs' : 'fbo']
    : ['fbo', 'fbs'];
  for (const scheme of schemes) {
    const eff = effectiveWbTariffFromScheme(boxTariffRow, scheme);
    if (eff) {
      return computeWbVolumeBaseTariff(eff.base, eff.liter, volumeLiters);
    }
  }
  const fb = fallback && typeof fallback === 'object' ? fallback : null;
  const base = Number(fb?.base);
  const liter = Number(fb?.liter);
  if (Number.isFinite(base) && base > 0) {
    return computeWbVolumeBaseTariff(base, Number.isFinite(liter) ? liter : 0, volumeLiters);
  }
  return 0;
}
