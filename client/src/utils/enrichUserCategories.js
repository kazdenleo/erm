/**
 * Обогащение ERP-категорий сопоставлениями МП для списка (без полных справочников Ozon/YM).
 */

function parseMarketplaceMappings(raw) {
  if (!raw) return null;
  if (typeof raw === 'object' && !Array.isArray(raw)) return raw;
  if (typeof raw === 'string') {
    try {
      const p = JSON.parse(raw);
      return typeof p === 'object' && p ? p : null;
    } catch {
      return null;
    }
  }
  return null;
}

function normalizeOzonId(id) {
  if (id == null || id === '') return '';
  return String(id).trim().replace(/^ozon_/i, '');
}

/** Map subjectID → название из отчёта комиссий WB */
export function buildWbCategoryNameMap(wbCommissionsReport) {
  const map = new Map();
  if (!Array.isArray(wbCommissionsReport)) return map;
  for (const row of wbCommissionsReport) {
    const id = row?.subjectID ?? row?.category_id ?? row?.categoryId;
    if (id == null || id === '') continue;
    const key = String(id);
    if (map.has(key)) continue;
    let rawData = row.raw_data;
    if (typeof rawData === 'string') {
      try {
        rawData = JSON.parse(rawData);
      } catch {
        rawData = null;
      }
    }
    const name =
      rawData?.subjectName ??
      row.subjectName ??
      row.category_name ??
      row.categoryName ??
      null;
    if (name) map.set(key, name);
  }
  return map;
}

function resolveMappingDisplayName(marketplace, categoryId, wbNameMap, mm = null) {
  const mp = String(marketplace || '').toLowerCase();
  const id = categoryId != null ? String(categoryId) : '';
  if (!id) return null;

  if (mp === 'wb' || mp === 'wildberries') {
    return wbNameMap.get(id) ?? null;
  }
  if (mp === 'ozon') {
    if (mm?.ozon_display) return mm.ozon_display;
    const clean = normalizeOzonId(id);
    if (mm?.ozon && normalizeOzonId(mm.ozon) === clean && mm.ozon_display) {
      return mm.ozon_display;
    }
    return null;
  }
  if (mp === 'ym' || mp === 'yandex') {
    if (mm?.ym_display) return mm.ym_display;
    return null;
  }
  return null;
}

function fallbackDisplayName(marketplace, categoryId) {
  const mp = String(marketplace || '').toLowerCase();
  const id = String(categoryId);
  if (mp === 'ym' || mp === 'yandex') return `Яндекс.Маркет #${id}`;
  if (mp === 'ozon') return `Ozon #${normalizeOzonId(id) || id}`;
  if (mp === 'wb' || mp === 'wildberries') return `WB #${id}`;
  return id;
}

/**
 * @param {Array} categories — user categories
 * @param {Array} mappings — category_mappings
 * @param {Record<string, number[]>} productIdsByCategory
 * @param {{ wbNameMap?: Map<string, string> }} [opts]
 */
export function enrichUserCategoriesWithMappings(
  categories,
  mappings,
  productIdsByCategory,
  opts = {}
) {
  const wbNameMap = opts.wbNameMap ?? new Map();
  const allMappings = Array.isArray(mappings) ? mappings : [];
  const mappingsByProductId = {};

  for (const m of allMappings) {
    if (m.product_id === undefined || m.product_id === null) continue;
    const k = String(m.product_id);
    if (!mappingsByProductId[k]) mappingsByProductId[k] = [];
    mappingsByProductId[k].push(m);
  }

  return (categories || []).map((category) => {
    const mm = parseMarketplaceMappings(category.marketplace_mappings);
    const productIds = productIdsByCategory[String(category.id)] || [];
    const productsCount = productIds.length;

    let categoryMappings = productIds.flatMap((pid) => mappingsByProductId[String(pid)] || []);
    categoryMappings = categoryMappings.map((m) => {
      const resolved =
        resolveMappingDisplayName(m.marketplace, m.category_id, wbNameMap, mm) ??
        (m.marketplace_category_name && m.marketplace_category_name !== 'Unknown Category'
          ? m.marketplace_category_name
          : null);
      return {
        ...m,
        marketplace_category_id: m.marketplace_category_id ?? m.category_id,
        marketplace_category_name:
          resolved ?? fallbackDisplayName(m.marketplace, m.category_id),
      };
    });

    const mappingsByMarketplace = {};
    for (const mapping of categoryMappings) {
      const marketplace = mapping.marketplace;
      if (!mappingsByMarketplace[marketplace]) mappingsByMarketplace[marketplace] = [];
      const exists = mappingsByMarketplace[marketplace].some(
        (m) =>
          m.marketplace_category_id === mapping.marketplace_category_id ||
          m.category_id === mapping.category_id
      );
      if (!exists) mappingsByMarketplace[marketplace].push(mapping);
    }

    if (mm && typeof mm === 'object') {
      if (mm.wb && !mappingsByMarketplace.wb?.length) {
        const name =
          resolveMappingDisplayName('wb', mm.wb, wbNameMap, mm) ??
          fallbackDisplayName('wb', mm.wb);
        mappingsByMarketplace.wb = [
          {
            marketplace_category_name: name,
            category_id: mm.wb,
            marketplace_category_id: mm.wb,
          },
        ];
      }
      if (mm.ozon) {
        const ozonDisplayName =
          mm.ozon_display ??
          resolveMappingDisplayName('ozon', mm.ozon, wbNameMap, mm) ??
          fallbackDisplayName('ozon', mm.ozon);
        if (!mappingsByMarketplace.ozon?.length) {
          mappingsByMarketplace.ozon = [
            {
              marketplace_category_name: ozonDisplayName,
              category_id: mm.ozon,
              marketplace_category_id: mm.ozon,
            },
          ];
        } else {
          mappingsByMarketplace.ozon[0].marketplace_category_name = ozonDisplayName;
        }
      }
      if (mm.ym) {
        const ymDisplayName =
          mm.ym_display ??
          resolveMappingDisplayName('ym', mm.ym, wbNameMap, mm) ??
          fallbackDisplayName('ym', mm.ym);
        if (!mappingsByMarketplace.ym?.length) {
          mappingsByMarketplace.ym = [
            {
              marketplace_category_name: ymDisplayName,
              category_id: mm.ym,
              marketplace_category_id: mm.ym,
            },
          ];
        } else {
          mappingsByMarketplace.ym[0].marketplace_category_name = ymDisplayName;
        }
      }
    }

    return {
      ...category,
      productsCount,
      mappings: mappingsByMarketplace,
    };
  });
}

/** Значки МП у категории (как у товаров), если есть сопоставление */
export function getCategoryMarketplaceLinkBadges(category) {
  const badges = [];
  const mappings = category?.mappings;
  const add = (key, className, label, title) => {
    badges.push({ key, className, label, title });
  };

  if (mappings && typeof mappings === 'object') {
    if (mappings.wb?.length) {
      const name = mappings.wb[0]?.marketplace_category_name;
      add('wb', 'wb', 'WB', name ? `Wildberries: ${name}` : 'Сопоставлено с Wildberries');
    }
    if (mappings.ozon?.length) {
      const name = mappings.ozon[0]?.marketplace_category_name;
      add('ozon', 'ozon', 'OZ', name ? `Ozon: ${name}` : 'Сопоставлено с Ozon');
    }
    if (mappings.ym?.length) {
      const name = mappings.ym[0]?.marketplace_category_name;
      add('ym', 'ym', 'YM', name ? `Яндекс.Маркет: ${name}` : 'Сопоставлено с Яндекс.Маркет');
    }
    if (badges.length) return badges;
  }

  const mm = parseMarketplaceMappings(category?.marketplace_mappings);
  if (!mm) return badges;
  if (mm.wb) add('wb', 'wb', 'WB', 'Сопоставлено с Wildberries');
  if (mm.ozon) add('ozon', 'ozon', 'OZ', mm.ozon_display ? `Ozon: ${mm.ozon_display}` : 'Сопоставлено с Ozon');
  if (mm.ym || mm.yandex) add('ym', 'ym', 'YM', 'Сопоставлено с Яндекс.Маркет');
  return badges;
}
