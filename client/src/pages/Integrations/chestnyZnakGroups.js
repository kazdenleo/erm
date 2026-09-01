/** Справочник товарных групп True API (pg). Держать в синхроне с server/src/utils/chestnyZnak.js */
export const CHESTNY_ZNAK_PRODUCT_GROUPS = [
  { id: 'tires', name: 'Шины и покрышки' },
  { id: 'autofluids', name: 'Моторные масла' },
  { id: 'chemistry', name: 'Косметика и бытовая химия' },
  { id: 'radio', name: 'Радиоэлектронная продукция' },
  { id: 'fire', name: 'Средства пожарной безопасности' },
  { id: 'heater', name: 'Отопительные приборы' },
  { id: 'electronics', name: 'Фотокамеры и вспышки' },
  { id: 'construction', name: 'Строительные материалы' },
  { id: 'antiseptic', name: 'Антисептики' },
  { id: 'bio', name: 'БАД' },
  { id: 'grocery', name: 'Бакалея' },
  { id: 'nabeer', name: 'Безалкогольное пиво' },
  { id: 'softdrinks', name: 'Безалкогольные напитки' },
  { id: 'otp', name: 'Альтернативный табак' },
  { id: 'bicycle', name: 'Велосипеды' },
  { id: 'water', name: 'Упакованная вода' },
  { id: 'petfood', name: 'Корма для животных' },
  { id: 'wheelchairs', name: 'Кресла-коляски' },
  { id: 'lp', name: 'Одежда (лёгпром)' },
  { id: 'conserve', name: 'Консервы' },
  { id: 'perfumery', name: 'Духи и туалетная вода' },
  { id: 'toys', name: 'Игры и игрушки' },
  { id: 'cabling', name: 'Кабельная продукция' },
  { id: 'pharma', name: 'Лекарственные препараты' },
  { id: 'medical', name: 'Медицинские изделия' },
  { id: 'furs', name: 'Меховые изделия' },
  { id: 'milk', name: 'Молочная продукция' },
  { id: 'seafood', name: 'Морепродукты' },
  { id: 'meat', name: 'Мясные изделия' },
  { id: 'ncp', name: 'Никотинсодержащая продукция' },
  { id: 'shoes', name: 'Обувь' },
  { id: 'opticfiber', name: 'Оптоволокно' },
  { id: 'beer', name: 'Пиво и слабоалкогольные напитки' },
  { id: 'vegetableoil', name: 'Растительные масла' },
  { id: 'sweets', name: 'Сладости и кондитерские изделия' },
  { id: 'tobacco', name: 'Табачная продукция' },
  { id: 'titan', name: 'Титановая металлопродукция' },
  { id: 'vetpharma', name: 'Ветеринарные препараты' },
  { id: 'books', name: 'Печатная продукция' },
];

export function mergeProductGroupOptions(fromApi) {
  const byId = new Map(CHESTNY_ZNAK_PRODUCT_GROUPS.map((g) => [g.id, g]));
  for (const g of fromApi || []) {
    const id = String(g?.id || '').trim();
    if (!id) continue;
    byId.set(id, { id, name: String(g.name || id) });
  }
  return Array.from(byId.values());
}

export const CHESTNY_ZNAK_OPERATIONS = [
  { id: 'purchase_accept', name: 'Закупка / приёмка', hint: 'Входящий УПД с КИ. Для шин — ЭДО.', channel: 'edo' },
  { id: 'wholesale_ship', name: 'Оптовая отгрузка', hint: 'Исходящий УПД участнику оборота.', channel: 'edo' },
  { id: 'fbo_transfer', name: 'Поставка FBO', hint: 'УПД на склад маркетплейса. Продажу выводит площадка.', channel: 'edo' },
  { id: 'fbs_distance', name: 'Продажа FBS / DBS', hint: 'Вывод «дистанционная продажа» со своего склада.', channel: 'true_api' },
  { id: 'own_use', name: 'Покупка / списание себе', hint: 'Вывод «собственные нужды».', channel: 'true_api' },
  { id: 'retail', name: 'Розница', hint: 'Вывод «розничная реализация».', channel: 'true_api' },
];
