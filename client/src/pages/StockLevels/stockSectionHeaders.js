/**
 * Заголовки подразделов «Склад» (h2.title + p.subtitle в StockLevelsLayout).
 */

import { warehouseOpFromSearch } from './warehouseTabs.js';

/** @type {Record<string, { title: string, subtitle: string }>} */
export const STOCK_SECTION_HEADERS = {
  table: {
    title: '📦 Остатки',
    subtitle:
      'Складской учёт: остатки, приёмка, перемещение между складами организации, списание и инвентаризация. Поиск — по штрихкоду, артикулу или названию.',
  },
  purchases: {
    title: '🧾 Закупка',
    subtitle: 'Ожидание поставки (incoming) и приёмки по закупкам',
  },
  receipts_list: {
    title: '📑 Приёмка',
    subtitle: 'Список приёмок и оформление поступлений товара на склад',
  },
  transfer: {
    title: '↔️ Перемещение',
    subtitle: 'Перемещение товаров между складами одной организации',
  },
  return_supplier: {
    title: '↩️ Возврат поставщику',
    subtitle: 'Оформление возврата товара поставщику и возвратные накладные',
  },
  return_customer: {
    title: '📥 Возвраты от клиентов',
    subtitle:
      'Возвраты с маркетплейсов, готовые к выдаче, и приёмка возвращённого товара на склад',
  },
  inventory: {
    title: '📋 Инвентаризация',
    subtitle: 'Пересчёт остатков на складе и оформление документов инвентаризации',
  },
  writeoff: {
    title: '📤 Списание',
    subtitle: 'Списание товара со склада по скану штрихкода или из списка',
  },
  fbo_supplies: {
    title: '📦 Поставки FBO',
    subtitle: 'Поставки товаров на склады маркетплейсов (FBO)',
  },
  fbo_forecasting: {
    title: '📊 Прогнозирование поставок',
    subtitle: 'Прогноз потребности и планирование поставок Wildberries по кластерам',
  },
  fbo_purchase_calc: {
    title: '🧾 Расчёт закупки FBO',
    subtitle: 'Расчёт закупки под незакрытые поставки FBO',
  },
};

/** Заголовок для текущего маршрута; null — страница со своим заголовком (карточка поставки). */
export function resolveStockSectionHeader(pathname, search = '') {
  const path = String(pathname || '');

  if (path.startsWith('/stock-levels/purchases')) {
    return STOCK_SECTION_HEADERS.purchases;
  }

  if (/^\/stock-levels\/fbo-supplies\/[^/]+/.test(path)) {
    if (path.includes('/forecasting')) return STOCK_SECTION_HEADERS.fbo_forecasting;
    if (path.includes('/purchase-calc')) return STOCK_SECTION_HEADERS.fbo_purchase_calc;
    return null;
  }
  if (path.startsWith('/stock-levels/fbo-supplies/forecasting')) {
    return STOCK_SECTION_HEADERS.fbo_forecasting;
  }
  if (path.startsWith('/stock-levels/fbo-supplies/purchase-calc')) {
    return STOCK_SECTION_HEADERS.fbo_purchase_calc;
  }
  if (path.startsWith('/stock-levels/fbo-supplies')) {
    return STOCK_SECTION_HEADERS.fbo_supplies;
  }

  if (path.startsWith('/stock-levels/warehouse')) {
    const op = warehouseOpFromSearch(new URLSearchParams(search || ''));
    return STOCK_SECTION_HEADERS[op] || STOCK_SECTION_HEADERS.table;
  }

  return null;
}
