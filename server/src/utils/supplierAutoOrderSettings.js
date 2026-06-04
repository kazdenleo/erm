/**
 * Настройки автозаказов поставщика (suppliers.api_config).
 */

export function autoOrderSettingsFromApiConfig(apiConfig) {
  const cfg = apiConfig && typeof apiConfig === 'object' ? apiConfig : {};
  const rawMin = cfg.minOrderAmount ?? cfg.min_order_amount;
  let minOrderAmount = null;
  if (rawMin !== '' && rawMin != null && !Number.isNaN(Number(rawMin))) {
    const n = Number(rawMin);
    minOrderAmount = n >= 0 ? n : null;
  }
  return {
    minOrderAmount,
    isPriority: Boolean(cfg.isPriority ?? cfg.is_priority),
    autoOrdersEnabled: Boolean(cfg.autoOrdersEnabled ?? cfg.auto_orders_enabled),
  };
}
