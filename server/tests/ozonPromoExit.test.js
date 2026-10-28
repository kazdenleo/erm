import { exitActionPrice, isUnifiedPriceBlock, restoreExitPrice } from '../src/utils/ozonPromoExit.js';

describe('ozonPromoExit', () => {
  test('обычная цена выше порога акции — её и ставим, пол не опускаем', () => {
    expect(exitActionPrice({
      price: 1348,
      floor: 1040,
      max_action_price: 927,
      alert_max_action_price: 0,
    })).toBe(1348);
  });

  test('если обычная цена внутри порога, берём минимальную из карточки', () => {
    expect(exitActionPrice({
      price: 900,
      floor: 1040,
      maxActionPrice: 927,
    })).toBe(1040);
  });

  test('если своих цен выше порога нет, ставим на рубль выше максимальной цены акции', () => {
    expect(exitActionPrice({
      price: 800,
      floor: 700,
      max_action_price: 927,
      price_max_elastic: 910,
    })).toBe(928);
  });

  test('код 9 unified price logic', () => {
    expect(isUnifiedPriceBlock('deactivate 400: {"code":9,"message":"the method is blocked due to unified price logic"}')).toBe(true);
    expect(isUnifiedPriceBlock('deactivate 400: not found')).toBe(false);
  });

  test('restoreExitPrice предпочитает selling ERP', () => {
    expect(restoreExitPrice({
      selling_price: 1500,
      floor: 1000,
      list_price: 1100,
      max_action_price: 1200,
    })).toBe(1500);
  });

  test('restoreExitPrice без selling берёт пол', () => {
    expect(restoreExitPrice({
      floor: 1300,
      list_price: 900,
      max_action_price: 1200,
    })).toBe(1300);
  });

  test('restoreExitPrice поднимает до порога+1, если selling ниже', () => {
    expect(restoreExitPrice({
      selling_price: 1000,
      floor: 900,
      max_action_price: 1200,
    })).toBe(1201);
  });
});
