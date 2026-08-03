/**
 * Ozon закрепил габариты/вес после замера (SKU_VWC_IS_NOT_EDITABLE).
 * Флаг: products.ozon_draft.dimensionsLocked
 */

function parseDraft(raw) {
  if (raw == null) return {};
  if (typeof raw === 'object' && !Array.isArray(raw)) return raw;
  if (typeof raw === 'string') {
    try {
      const p = JSON.parse(raw);
      return p && typeof p === 'object' && !Array.isArray(p) ? p : {};
    } catch {
      return {};
    }
  }
  return {};
}

export function isOzonPackagingDimensionsLocked(formOrProduct) {
  const d = parseDraft(formOrProduct?.ozon_draft);
  if (d.dimensionsLocked === true) return true;
  // bulk-row может держать baseline отдельно
  const base = formOrProduct?._ozonDraftBaseline;
  if (base && typeof base === 'object' && base.dimensionsLocked === true) return true;
  return false;
}

export const OZON_DIMS_LOCK_TITLE =
  'Ozon закрепил габариты и вес после складского замера — изменить через API нельзя. ' +
  'При импорте с Ozon значения в ERP обновляются по замерам Ozon. ' +
  'Если замер неверный — напишите в поддержку Ozon.';
