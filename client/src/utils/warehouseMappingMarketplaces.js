/** Коды маркетплейсов в warehouse_mappings (как в БД: ozon | wb | ym). */

export const WAREHOUSE_MAPPING_MARKETPLACES = [
  { value: 'ozon', label: 'Ozon' },
  { value: 'wb', label: 'Wildberries' },
  { value: 'ym', label: 'Яндекс Маркет' },
];

const LABELS = Object.fromEntries(
  WAREHOUSE_MAPPING_MARKETPLACES.map((o) => [o.value, o.label])
);

export function normalizeWarehouseMappingMarketplace(value) {
  const v = String(value ?? '').trim().toLowerCase();
  if (v === 'wildberries' || v === 'wb') return 'wb';
  if (v === 'yandex' || v === 'ym' || v === 'яндекс' || v === 'яндекс маркет') return 'ym';
  if (v === 'ozon') return 'ozon';
  return v;
}

export function warehouseMappingMarketplaceLabel(value) {
  const code = normalizeWarehouseMappingMarketplace(value);
  return LABELS[code] || String(value || '').toUpperCase() || '—';
}

export function warehouseMappingMarketplaceHint(marketplace) {
  const mp = normalizeWarehouseMappingMarketplace(marketplace);
  if (mp === 'wb') {
    return (
      'Для Wildberries укажите склад FBS: значение offices[0] из заказа ' +
      'или «id — название» из API складов продавца (как в синхронизации заказов).'
    );
  }
  if (mp === 'ym') {
    return (
      'Для Яндекс.Маркет укажите campaignId из заказа (число). ' +
      'Его можно выбрать из списка кампаний интеграции.'
    );
  }
  return (
    'Для Ozon укажите warehouse_name из заказа (поле delivery_method.warehouse_name) ' +
    'или «id — название» из API Ozon.'
  );
}
