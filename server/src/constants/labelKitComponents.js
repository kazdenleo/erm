/**
 * Форматирование состава комплекта для этикетки.
 */

export function getKitComponentsFromProduct(product) {
  const list = product?.kit_components ?? product?.kitComponents;
  return Array.isArray(list) ? list : [];
}

export function formatKitComponentLine(component, options = {}) {
  const showQuantity = options.showQuantity !== false;
  const showSku = options.showSku !== false;
  const showName = options.showName !== false;

  const q = Math.max(1, Number(component?.quantity) || 1);
  const sku = String(component?.component_sku ?? component?.sku ?? '').trim();
  const name = String(component?.product_name ?? component?.name ?? '').trim();
  const id = component?.productId ?? component?.component_product_id;

  const labelParts = [];
  if (showSku && sku) labelParts.push(sku);
  if (showName && name) labelParts.push(name);
  const label = labelParts.join(' — ') || (id != null ? `товар #${id}` : '');

  if (!label) return '';
  if (showQuantity) return `${q}× ${label}`.trim();
  return label;
}

export function formatKitComponentLines(product, element = {}) {
  const components = getKitComponentsFromProduct(product);
  if (!components.length) return [];

  const options = {
    showQuantity: element.showQuantity,
    showSku: element.showSku,
    showName: element.showName,
  };

  return components
    .map((c) => formatKitComponentLine(c, options))
    .filter((line) => line && String(line).trim());
}
