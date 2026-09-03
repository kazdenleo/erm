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

  test('applies warehouse coefficient to tariff before volume calc', () => {
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
    expect(log.base).toBe(applyWbWarehouseCoef(78.2, 170));
    expect(log.cost).toBe(computeWbVolumeBaseTariff(log.base, log.liter, 2.1));
    expect(computeWbReturnAmount(row, 2.1, null, 'fbs')).toBe(log.cost);
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
