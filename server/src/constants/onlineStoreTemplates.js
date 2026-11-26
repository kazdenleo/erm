/** Шаблоны публичной витрины (коды совпадают с CHECK в online_stores). */
export const ONLINE_STORE_TEMPLATES = Object.freeze([
  {
    code: 'minimal',
    name: 'Минимал',
    blurb: 'Чистая витрина: логотип, сетка карточек, быстрый заказ.',
  },
  {
    code: 'showcase',
    name: 'Витрина',
    blurb: 'Крупный герой на главной и акцентные карточки — для бренда и D2C.',
  },
  {
    code: 'catalog',
    name: 'Каталог',
    blurb: 'Плотный список с ценой и наличием — удобно для B2B и опта.',
  },
]);

export const ONLINE_STORE_TEMPLATE_CODES = Object.freeze(
  ONLINE_STORE_TEMPLATES.map((t) => t.code)
);

export function isOnlineStoreTemplate(code) {
  return ONLINE_STORE_TEMPLATE_CODES.includes(String(code || '').trim().toLowerCase());
}
