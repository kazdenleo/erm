/**
 * Лимиты длины идентификаторов связи ERP ↔ маркетплейс (документация партнёрских API).
 * Дублируются в server/src/validators/productValidator.js — при изменении синхронизировать.
 */
export const MP_LINK_MAX = {
  OZON_OFFER_ID: 50,
  OZON_PRODUCT_ID_DIGITS: 19,
  WB_NMID: 20,
  YM_OFFER_ID: 255,
  WB_VENDOR_CODE: 255,
};

export const MP_LINK_PANEL_STYLE = {
  ozon: {
    border: '1px solid rgba(255, 107, 0, 0.35)',
    background: 'rgba(255, 107, 0, 0.06)',
  },
  wb: {
    border: '1px solid rgba(203, 17, 171, 0.35)',
    background: 'rgba(203, 17, 171, 0.06)',
  },
  ym: {
    border: '1px solid rgba(255, 204, 0, 0.35)',
    background: 'rgba(255, 204, 0, 0.08)',
  },
};
