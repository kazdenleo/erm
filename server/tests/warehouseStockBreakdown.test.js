import { getWarehouseStockBreakdown } from '../src/services/kitStock.service.js';

describe('getWarehouseStockBreakdown', () => {
  test('без id — пустой снимок', async () => {
    await expect(getWarehouseStockBreakdown(null, 5)).resolves.toMatchObject({
      quantity: 0,
      isKit: false,
      components: [],
    });
  });

  test('без склада — пустой снимок', async () => {
    await expect(getWarehouseStockBreakdown(10, null)).resolves.toMatchObject({
      quantity: 0,
      availableTotal: 0,
    });
  });
});
