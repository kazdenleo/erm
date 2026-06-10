/**
 * Зоны размещения Ozon FBO: сортируемый / несортируемый и прочие зоны.
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
  if (typeof ozonTags === 'string') {
    try {
      const parsed = JSON.parse(ozonTags);
      if (Array.isArray(parsed)) return normalizeTags(parsed);
    } catch {
      /* ignore */
    }
    return ozonTags.trim() ? [ozonTags.trim().toUpperCase()] : [];
  }
  return [];
}

/**
 * Ключ для проверки смешивания в одном грузоместе.
 * sortable / non_sortable — главное правило Ozon; остальные зоны не смешиваются между собой.
 */
export function ozonPlacementMixingKey(placementZone, ozonTags) {
  const zone = placementZone != null ? String(placementZone).trim().toUpperCase() : '';
  const tags = normalizeTags(ozonTags);

  if (zone && SORTABLE_ZONES.has(zone)) return 'sortable';
  if (zone && NON_SORTABLE_ZONES.has(zone)) return 'non_sortable';

  for (const tag of tags) {
    if (SORTABLE_TAGS.has(tag)) return 'sortable';
    if (NON_SORTABLE_TAGS.has(tag)) return 'non_sortable';
  }

  if (zone) return zone;
  return null;
}

export function ozonPlacementZoneLabel(placementZone, ozonTags) {
  const key = ozonPlacementMixingKey(placementZone, ozonTags);
  if (key === 'sortable') return 'Сортируемый';
  if (key === 'non_sortable') return 'Несортируемый';
  if (!key) return '—';
  return ZONE_LABELS[key] || key;
}

export function ozonPlacementZonesConflict(keyA, keyB) {
  if (!keyA || !keyB) return false;
  return keyA !== keyB;
}

/** Сообщение при попытке смешать сортируемые и несортируемые (и прочие зоны) в одном грузоместе. */
export function buildPlacementMixingMessage(existingKey, newKey) {
  if (existingKey === 'sortable' && newKey === 'non_sortable') {
    return 'В этом грузоместе уже лежат сортируемые товары. Несортируемый товар добавить нельзя.';
  }
  if (existingKey === 'non_sortable' && newKey === 'sortable') {
    return 'В этом грузоместе уже лежат несортируемые товары. Сортируемый товар добавить нельзя.';
  }
  if (existingKey && newKey && existingKey !== newKey) {
    const a = ozonPlacementZoneLabel(existingKey, []);
    const b = ozonPlacementZoneLabel(newKey, []);
    return `В этом грузоместе товары зоны «${a}». Нельзя смешивать с «${b}».`;
  }
  return 'Нельзя смешивать разные зоны размещения в одном грузоместе.';
}

export function summarizeOzonPlacementZones(items) {
  const counts = new Map();
  for (const it of items || []) {
    const label = ozonPlacementZoneLabel(it.placementZone ?? it.placement_zone, it.ozonTags ?? it.ozon_tags);
    const qty = parseInt(it.quantity, 10) || 1;
    counts.set(label, (counts.get(label) || 0) + qty);
  }
  if (!counts.size) return '—';
  return Array.from(counts.entries())
    .map(([label, qty]) => `${label}: ${qty}`)
    .join(' · ');
}

function normalizeOzonTagValue(tag) {
  if (tag == null) return '';
  if (typeof tag === 'string' || typeof tag === 'number') return String(tag).trim();
  if (typeof tag === 'object') {
    const v =
      tag.tag ??
      tag.name ??
      tag.code ??
      tag.value ??
      tag.type ??
      null;
    return v != null ? String(v).trim() : '';
  }
  return '';
}

export function parseOzonBundleRowMeta(row) {
  const placementZone = row?.placement_zone ?? row?.placementZone ?? null;
  const rawTags = row?.tags ?? row?.item_tags ?? [];
  const ozonTags = Array.isArray(rawTags)
    ? rawTags.map(normalizeOzonTagValue).filter(Boolean)
    : [];
  return {
    placementZone: placementZone != null ? String(placementZone).trim() : null,
    ozonTags,
  };
}
