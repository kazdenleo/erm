/**
 * Объём товара в литрах для расчёта логистики и отображения.
 * Считаем из габаритов (мм) — те же размеры, что уходят на МП / правятся на вкладках МП.
 * Поле products.volume — только fallback, если габаритов нет.
 * Ozon API volume_weight — объёмный вес в кг, не литры; не используем как объём.
 */

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
  const direct = product.volume ?? product.volume_liters ?? product.volumeLiters;
  if (direct != null && direct !== '') {
    const n = Number(direct);
    if (Number.isFinite(n) && n > 0) return Math.round(n * 1000) / 1000;
  }
  return null;
}

/**
 * @param {{ volume?: number|string|null, length?: number|string|null, width?: number|string|null, height?: number|string|null }} product
 * @returns {number|null} литры
 */
export function resolveProductVolumeLiters(product) {
  if (!product || typeof product !== 'object') return null;
  return litersFromDimensions(product) ?? litersFromVolumeField(product);
}

/**
 * @param {object|null|undefined} calculator
 * @param {object|null|undefined} product
 * @returns {number|null}
 */
export function resolveEffectiveVolumeLiters(calculator, product) {
  const fromProduct = resolveProductVolumeLiters(product);
  if (fromProduct != null) return fromProduct;

  const fromCalc = calculator?.volume_weight;
  if (fromCalc != null && fromCalc !== '') {
    const n = Number(fromCalc);
    if (Number.isFinite(n) && n > 0) return n;
  }

  return null;
}

/**
 * Подставляет литры из габаритов карточки в сохранённые детали расчёта.
 */
export function enrichCalculatorVolumeFromProduct(calculator, product) {
  if (!calculator || typeof calculator !== 'object') return calculator;
  const liters = resolveProductVolumeLiters(product);
  if (liters == null) return calculator;
  return { ...calculator, volume_weight: liters, volume_source: 'dimensions' };
}
