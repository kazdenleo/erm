/**
 * Объём товара в литрах (клиент).
 * Для мин. цен МП — строго из атрибутов/габаритов маркетплейса; без ERP fallback.
 */

import { resolveMarketplaceVolumeLiters } from './marketplaceDimensions.js';

export { resolveMarketplaceVolumeLiters } from './marketplaceDimensions.js';

function litersFromDimensions(product) {
  const length = Number(product.length);
  const width = Number(product.width);
  const height = Number(product.height);
  if (
    Number.isFinite(length) && length > 0 &&
    Number.isFinite(width) && width > 0 &&
    Number.isFinite(height) && height > 0
  ) {
    const liters = (length * width * height) / 1_000_000;
    if (liters > 0) return Math.round(liters * 1000) / 1000;
  }
  return null;
}

function litersFromVolumeField(product) {
  const direct =
    product.effectiveVolume ??
    product.volume ??
    product.volume_liters ??
    product.volumeLiters;
  if (direct != null && direct !== '') {
    const n = Number(direct);
    if (Number.isFinite(n) && n > 0) return Math.round(n * 1000) / 1000;
  }
  return null;
}

export function resolveProductVolumeLiters(product) {
  if (!product || typeof product !== 'object') return null;
  return litersFromDimensions(product) ?? litersFromVolumeField(product);
}

export function resolveEffectiveVolumeLiters(calculator, product, marketplace = null) {
  const mp = marketplace || calculator?.marketplace || null;
  if (mp) {
    const fromMp = resolveMarketplaceVolumeLiters(product, mp);
    if (fromMp != null) return fromMp;
    return null;
  }

  const fromProduct = resolveProductVolumeLiters(product);
  if (fromProduct != null) return fromProduct;

  const fromCalc = calculator?.volume_weight;
  if (fromCalc != null && fromCalc !== '') {
    const n = Number(fromCalc);
    if (Number.isFinite(n) && n > 0) return n;
  }

  return null;
}

export function enrichCalculatorVolumeFromProduct(calculator, product, marketplace = null) {
  if (!calculator || typeof calculator !== 'object') return calculator;
  const mp = marketplace || calculator.marketplace || null;
  const mpNorm = String(mp || '').toLowerCase();
  const liters = mp
    ? resolveMarketplaceVolumeLiters(product, mp)
    : resolveProductVolumeLiters(product);
  if (liters == null) {
    if (mp) {
      return {
        ...calculator,
        volume_weight: null,
        volume_source: `${mpNorm}:missing_packaging`,
        marketplace: mpNorm === 'yandex' ? 'ym' : mpNorm === 'wildberries' ? 'wb' : mpNorm,
      };
    }
    return calculator;
  }
  return {
    ...calculator,
    volume_weight: liters,
    volume_source: mp ? `mp:${mp}` : 'dimensions',
    ...(mp ? { marketplace: mpNorm === 'yandex' ? 'ym' : mpNorm === 'wildberries' ? 'wb' : mpNorm } : {}),
  };
}
