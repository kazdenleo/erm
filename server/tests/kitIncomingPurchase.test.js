import test from 'node:test';
import assert from 'node:assert/strict';
import { kitIncomingUnitsFromPurchaseMovements, isPurchaseIncomingRemovalMovement, isKitPurchaseIncomingAddMovement } from '../../client/src/utils/kitStockMetrics.js';

const kitProduct = {
  id: 100,
  kit_components: [
    { component_product_id: 1, quantity: 3 },
    { component_product_id: 2, quantity: 1 },
  ],
};

test('kitIncomingUnitsFromPurchaseMovements: whole kits + min from components', () => {
  const movements = [
    { product_id: 100, quantity_change: 10 },
    { product_id: 1, quantity_change: 10 },
    { product_id: 2, quantity_change: 10 },
  ];
  assert.equal(kitIncomingUnitsFromPurchaseMovements(movements, kitProduct), 13);
});

test('kitIncomingUnitsFromPurchaseMovements: components only', () => {
  const movements = [
    { product_id: 1, quantity_change: 9 },
    { product_id: 2, quantity_change: 3 },
  ];
  assert.equal(kitIncomingUnitsFromPurchaseMovements(movements, kitProduct), 3);
});

test('kitIncomingUnitsFromPurchaseMovements: whole kits only', () => {
  const movements = [{ product_id: 100, quantity_change: 10 }];
  assert.equal(kitIncomingUnitsFromPurchaseMovements(movements, kitProduct), 10);
});

test('isPurchaseIncomingRemovalMovement: снятие ожидания при уменьшении', () => {
  assert.equal(
    isPurchaseIncomingRemovalMovement({
      type: 'incoming',
      quantity_change: -1,
      reason: 'Снятие ожидания при уменьшении строки закупки №36',
    }),
    true
  );
});

test('isKitPurchaseIncomingAddMovement: не включает снятие ожидания', () => {
  assert.equal(
    isKitPurchaseIncomingAddMovement(
      {
        type: 'incoming',
        product_id: 100,
        quantity_change: -1,
        reason: 'Снятие ожидания при уменьшении строки закупки №36',
      },
      { id: 100, kit_components: [] }
    ),
    false
  );
  assert.equal(
    isKitPurchaseIncomingAddMovement(
      {
        type: 'incoming',
        product_id: 100,
        quantity_change: 10,
        reason: 'Закупка №36 — ожидание',
      },
      { id: 100, kit_components: [] }
    ),
    true
  );
});
