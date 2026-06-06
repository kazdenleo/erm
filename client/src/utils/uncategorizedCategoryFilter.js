/**
 * Фильтр «Без категории» — sentinel и проверка наличия товаров без user_category_id.
 */

import { productsApi } from '../services/products.api.js';

/** Должно совпадать с buildFindAllFilters на сервере. */
export const FILTER_CATEGORY_NONE = '__no_category__';

/** Есть ли товары без ERP-категории в рамках переданных фильтров списка. */
export async function fetchHasUncategorizedProducts(listParams = {}) {
  const res = await productsApi.getAll({
    cacheBust: true,
    limit: 1,
    offset: 0,
    ...listParams,
    categoryId: FILTER_CATEGORY_NONE,
  });
  const total = Number(res?.meta?.total);
  if (Number.isFinite(total)) return total > 0;
  const list = Array.isArray(res?.data) ? res.data : [];
  return list.length > 0;
}
