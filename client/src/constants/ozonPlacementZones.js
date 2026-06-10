/**
 * Зоны размещения Ozon FBO (клиент).
 */

const SORTABLE_ZONES = new Set(['SORT', 'SORTABLE']);
const NON_SORTABLE_ZONES = new Set(['NON_SORT', 'NONSORT', 'NON_SORTABLE', 'UNSORTED', 'UNSORT']);

const SORTABLE_TAGS = new Set(['SORTABLE', 'SORT']);
const NON_SORTABLE_TAGS = new Set(['NON_SORTABLE', 'NON_SORT', 'NONSORT', 'UNSORTED', 'UNSORT']);

const ZONE_LABELS = {
  SORT: 'Сортируемый',
  SORTABLE: 'Сортируемый',
  NON_SORT: 'Несортируемый',
  NONSORT: 'Несортируемый',
  NON_SORTABLE: 'Несортируемый',
  UNSORTED: 'Несортируемый',
  UNSORT: 'Несортируемый',
  FOOD: 'Продукты',
  DANGEROUS: 'Опасный груз',
  ZONE_A: 'Зона A',
  ZONE_B: 'Зона B',
  ZONE_C: 'Зона C',
};

function normalizeTags(ozonTags) {
  if (!ozonTags) return [];
  if (Array.isArray(ozonTags)) {
    return ozonTags.map((t) => String(t).trim().toUpperCase()).filter(Boolean);
  }
  return [];
}

export function ozonPlacementZoneLabel(placementZone, ozonTags) {
  const zone = placementZone != null ? String(placementZone).trim().toUpperCase() : '';
  const tags = normalizeTags(ozonTags);

  if (zone && SORTABLE_ZONES.has(zone)) return 'Сортируемый';
  if (zone && NON_SORTABLE_ZONES.has(zone)) return 'Несортируемый';

  for (const tag of tags) {
    if (SORTABLE_TAGS.has(tag)) return 'Сортируемый';
    if (NON_SORTABLE_TAGS.has(tag)) return 'Несортируемый';
  }

  if (!zone) return '—';
  return ZONE_LABELS[zone] || zone;
}

export function summarizeOzonPlacementZones(items) {
  const counts = new Map();
  for (const it of items || []) {
    const label = ozonPlacementZoneLabel(it.placementZone, it.ozonTags);
    const qty = parseInt(it.quantity, 10) || 1;
    counts.set(label, (counts.get(label) || 0) + qty);
  }
  if (!counts.size) return '—';
  return Array.from(counts.entries())
    .map(([label, qty]) => `${label}: ${qty}`)
    .join(' · ');
}
