/**
 * PDF этикеток ячеек: размер и состав из шаблона конструктора (пресет 58×40 / 75×120).
 */

import { effectiveBarcode } from './addressStorage.service.js';
import productLabelsService, { defaultCellTemplate } from './productLabels.service.js';

function locationLegend(loc, settings) {
  const levels = Array.isArray(settings?.levels) ? settings.levels : [];
  return (loc.parts || [])
    .map((p, i) => `${levels[i]?.label || ''} ${p}`.trim())
    .filter(Boolean)
    .join(' · ');
}

/** Шаблон конструктора; если не сохранён — пресет и состав по умолчанию (не мм со склада). */
export function resolveCellPrintTemplate(template) {
  const base = defaultCellTemplate();
  if (!template || typeof template !== 'object') return base;
  const elements = Array.isArray(template.elements) ? template.elements : [];
  return {
    ...base,
    ...template,
    size_preset: template.size_preset || template.sizePreset || base.size_preset,
    elements: elements.length ? elements : base.elements,
  };
}

export async function buildLocationLabelsPdf(locations, settings, { template = null, warehouseName = '' } = {}) {
  const cells = (locations || []).map((loc) => ({
    code: loc.code,
    legend: locationLegend(loc, settings),
    barcode: effectiveBarcode(loc),
    warehouseName: warehouseName || '',
  }));
  return productLabelsService.renderCellLabelsPdf(resolveCellPrintTemplate(template), cells);
}
