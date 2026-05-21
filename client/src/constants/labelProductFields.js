/**
 * Поля карточки товара (вкладка «Основное»), доступные на этикетке.
 * Не включаем: описание, изображения, % выкупа, себестоимость, доп. расходы, мин. чистую прибыль.
 */
export const LABEL_PRODUCT_FIELDS = [
  { key: 'brand', label: 'Бренд' },
  { key: 'length', label: 'Длина (мм)' },
  { key: 'width', label: 'Ширина (мм)' },
  { key: 'height', label: 'Высота (мм)' },
  { key: 'weight', label: 'Вес (г)' },
  { key: 'volume', label: 'Объём (л)' },
  { key: 'product_type', label: 'Тип товара' },
  { key: 'category_name', label: 'Категория' },
  { key: 'organization_name', label: 'Организация' },
  { key: 'country_of_origin', label: 'Страна производства' },
  { key: 'barcodes_text', label: 'Штрихкоды (текст)' },
];

export function labelProductFieldLabel(fieldKey) {
  const f = LABEL_PRODUCT_FIELDS.find((x) => x.key === fieldKey);
  return f?.label || fieldKey;
}
