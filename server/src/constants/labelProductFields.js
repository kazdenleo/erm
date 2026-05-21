/**
 * Поля карточки товара для этикетки (см. client/src/constants/labelProductFields.js).
 */

export const LABEL_PRODUCT_FIELD_LABELS = {
  brand: 'Бренд',
  length: 'Длина (мм)',
  width: 'Ширина (мм)',
  height: 'Высота (мм)',
  weight: 'Вес (г)',
  volume: 'Объём (л)',
  product_type: 'Тип товара',
  category_name: 'Категория',
  organization_name: 'Организация',
  country_of_origin: 'Страна производства',
  barcodes_text: 'Штрихкоды',
};

export function labelProductFieldLabel(fieldKey) {
  return LABEL_PRODUCT_FIELD_LABELS[fieldKey] || String(fieldKey || '');
}

export function formatProductVolumeLiters(product) {
  const l = Number(product?.length);
  const w = Number(product?.width);
  const h = Number(product?.height);
  if (![l, w, h].every((n) => Number.isFinite(n) && n > 0)) return '';
  return (l * w * h / 1_000_000).toFixed(2);
}

export function getProductFieldDisplayValue(product, fieldKey) {
  if (!product || !fieldKey) return '';
  switch (fieldKey) {
    case 'brand':
      return String(product.brand ?? product.brand_name ?? '').trim();
    case 'length':
    case 'width':
    case 'height':
    case 'weight': {
      const v = product[fieldKey];
      if (v == null || v === '') return '';
      return String(v).trim();
    }
    case 'volume':
      return formatProductVolumeLiters(product);
    case 'product_type': {
      const t = String(product.product_type || 'product').toLowerCase();
      return t === 'kit' ? 'Комплект' : 'Товар';
    }
    case 'category_name':
      return String(product.category_name ?? product.categoryName ?? '').trim();
    case 'organization_name':
      return String(product.organization_name ?? product.organizationName ?? '').trim();
    case 'country_of_origin':
      return String(product.country_of_origin ?? '').trim();
    case 'barcodes_text': {
      const list = Array.isArray(product.barcodes) ? product.barcodes : [];
      return list.map((b) => String(b).trim()).filter(Boolean).join(', ');
    }
    default:
      return '';
  }
}
