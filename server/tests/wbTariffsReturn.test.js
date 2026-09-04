import {
  computeWbReturnAmount,
  computeWbVolumeBaseTariff,
  computeWbLogisticsCost,
  pickWbReverseDeliveryBaseLiter,
  applyWbWarehouseCoef,
  parseWbWarehouseCoefPercent,
} from '../src/utils/wbTariffs.js';

describe('WB reverse delivery (return_amount)', () => {
  test('uses marketplace base when FBO box base empty (46+14)', () => {
    const row = {
      boxDeliveryBase: '-',
      boxDeliveryLiter: '-',
      boxDeliveryMarketplaceBase: '46',
      boxDeliveryMarketplaceLiter: '14',
    };
    expect(pickWbReverseDeliveryBaseLiter(row)).toMatchObject({
      base: 46,
      liter: 14,
      coef: 100,
      source: 'boxDeliveryMarketplace',
    });
    expect(computeWbReturnAmount(row, 2.7)).toBe(74);
    expect(computeWbReturnAmount(row, 1.8)).toBe(60);
    expect(computeWbReturnAmount(row, 0.9)).toBe(46);
  });

  test('prefers FBO boxDelivery when present', () => {
    const row = {
      boxDeliveryBase: '50',
      boxDeliveryLiter: '10',
      boxDeliveryMarketplaceBase: '46',
      boxDeliveryMarketplaceLiter: '14',
    };
    expect(computeWbReturnAmount(row, 2.5)).toBe(70);
  });

  test('FBO falls back to marketplace tariff when FBO base empty', () => {
    const row = {
      boxDeliveryBase: '-',
      boxDeliveryLiter: '-',
      boxDeliveryMarketplaceBase: '78,2',
      boxDeliveryMarketplaceLiter: '23,8',
      boxDeliveryMarketplaceCoefExpr: '170',
    };
    const fbo = computeWbLogisticsCost(row, 1, 'fbo');
    const fbs = computeWbLogisticsCost(row, 1, 'fbs');
    expect(fbo.cost).toBe(fbs.cost);
    expect(fbo.coef).toBe(170); // справочно из API
    expect(fbo.base).toBe(78.2); // без повторного × коэф
    expect(fbo.source).toBe('boxDeliveryMarketplace');
  });

  test('forward logistics does not re-apply warehouse coef; IL defaults to 1', () => {
    const row = {
      boxDeliveryBase: '-',
      boxDeliveryLiter: '-',
      boxDeliveryMarketplaceBase: '78,2',
      boxDeliveryMarketplaceLiter: '23,8',
      boxDeliveryMarketplaceCoefExpr: '170',
    };
    const log = computeWbLogisticsCost(row, 2.1, 'fbs');
    expect(log.coef).toBe(170);
    expect(log.rawBase).toBe(78.2);
    expect(log.base).toBe(78.2);
    expect(log.liter).toBe(23.8);
    expect(log.localizationIndex).toBe(1);
    // ceil(2.1−1)=2 → 78.2 + 23.8×2 = 125.8
    expect(log.cost).toBe(125.8);
    expect(log.cost).toBe(computeWbVolumeBaseTariff(78.2, 23.8, 2.1));
    expect(computeWbReturnAmount(row, 2.1, null, 'fbs')).toBe(125.8);
  });

  test('localization index multiplies volume tariff when set', () => {
    const row = {
      boxDeliveryMarketplaceBase: '46',
      boxDeliveryMarketplaceLiter: '14',
      boxDeliveryMarketplaceCoefExpr: '100',
    };
    const log = computeWbLogisticsCost(row, 1.8, 'fbs', 1.2);
    // ceil(0.8)=1 → (46+14)×1.2 = 72
    expect(log.cost).toBe(72);
    expect(log.localizationIndex).toBe(1.2);
  });

  test('coef "-" defaults to 100%', () => {
    expect(parseWbWarehouseCoefPercent('-')).toBe(100);
    expect(applyWbWarehouseCoef(50, '-')).toBe(50);
  });

  test('does not use deliveryDumpSupReturnExpr (250)', () => {
    const row = {
      deliveryDumpSupReturnExpr: '250',
      deliveryDumpSupOfficeBase: 'не принимает',
    };
    expect(computeWbReturnAmount(row, 2.7)).toBe(0);
    expect(computeWbReturnAmount(row, 2.7, { base: 46, liter: 14 })).toBe(74);
  });

  test('computeWbVolumeBaseTariff rounds to kopecks', () => {
    expect(computeWbVolumeBaseTariff(46.5, 14.2, 2.1)).toBe(74.9);
  });
});
