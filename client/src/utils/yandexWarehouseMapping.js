/**
 * Формат привязки Яндекс.Маркет в warehouse_mappings.marketplace_warehouse_id.
 * Дублирует серверную логику для UI.
 */

export function parseYandexWarehouseMapping(raw) {
  const value = String(raw ?? '').trim();
  if (!value) {
    return { campaignId: '', warehouseId: '', raw: '' };
  }

  const campaignMatch = value.match(/(?:^|[;,\s])campaignId\s*=\s*([0-9]+)/i);
  const warehouseMatch = value.match(/(?:^|[;,\s])warehouseId\s*=\s*([0-9]+)/i);
  if (campaignMatch || warehouseMatch) {
    return {
      campaignId: campaignMatch?.[1] ? String(campaignMatch[1]).trim() : '',
      warehouseId: warehouseMatch?.[1] ? String(warehouseMatch[1]).trim() : '',
      raw: value,
    };
  }

  if (/^\d+$/.test(value)) {
    return { campaignId: value, warehouseId: '', raw: value };
  }

  return { campaignId: '', warehouseId: '', raw: value };
}

export function buildYandexWarehouseMapping({ campaignId = '', warehouseId = '' } = {}) {
  const campaign = String(campaignId ?? '').trim();
  const warehouse = String(warehouseId ?? '').trim();
  if (!campaign && !warehouse) return '';
  if (campaign && warehouse) return `campaignId=${campaign};warehouseId=${warehouse}`;
  if (campaign) return `campaignId=${campaign}`;
  return `warehouseId=${warehouse}`;
}

export function formatYandexWarehouseMappingLabel(raw) {
  const parsed = parseYandexWarehouseMapping(raw);
  const parts = [];
  if (parsed.campaignId) parts.push(`campaignId ${parsed.campaignId}`);
  if (parsed.warehouseId) parts.push(`склад ${parsed.warehouseId}`);
  return parts.length ? parts.join(' · ') : String(raw || '').trim();
}
