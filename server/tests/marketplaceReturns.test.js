import {
  isOzonReturnWaitingPickup,
  isYmReturnWaitingPickup,
} from '../src/services/marketplaceReturns.service.js';
import {
  buildGoodsReturnDateRanges,
  isWbReturnWaitingPickup,
} from '../src/services/wbReturns.service.js';

describe('isOzonReturnWaitingPickup', () => {
  test('waiting at pickup point', () => {
    expect(
      isOzonReturnWaitingPickup({
        visual: { status: { sys_name: 'ArrivedAtReturnPlace', display_name: 'В пункте выдачи' } },
      })
    ).toBe(true);
  });

  test('in transit is not waiting', () => {
    expect(
      isOzonReturnWaitingPickup({
        visual: { status: { sys_name: 'MovingToSeller', display_name: 'В пути к продавцу' } },
      })
    ).toBe(false);
  });

  test('completed when seller received', () => {
    expect(
      isOzonReturnWaitingPickup({
        logistic: { final_moment: '2025-01-01T00:00:00Z' },
        visual: { status: { sys_name: 'ArrivedAtReturnPlace' } },
      })
    ).toBe(false);
  });
});

describe('isYmReturnWaitingPickup', () => {
  test('ready for pickup to shop', () => {
    expect(
      isYmReturnWaitingPickup({
        shipmentStatus: 'READY_FOR_PICKUP',
        shipmentRecipientType: 'SHOP',
      })
    ).toBe(true);
  });

  test('in transit is not waiting', () => {
    expect(
      isYmReturnWaitingPickup({
        shipmentStatus: 'IN_TRANSIT',
        shipmentRecipientType: 'SHOP',
      })
    ).toBe(false);
  });

  test('picked is not waiting', () => {
    expect(
      isYmReturnWaitingPickup({
        shipmentStatus: 'PICKED',
        shipmentRecipientType: 'SHOP',
      })
    ).toBe(false);
  });
});

describe('buildGoodsReturnDateRanges', () => {
  test('splits long spans', () => {
    const ranges = buildGoodsReturnDateRanges({
      dateFrom: '2024-01-01',
      dateTo: '2024-03-01',
    });
    expect(ranges.length).toBeGreaterThan(1);
  });
});
