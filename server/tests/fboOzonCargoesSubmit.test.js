import { buildOzonCargoesBody } from '../src/services/fboSuppliesSubmit.service.js';

describe('buildOzonCargoesBody', () => {
  const supply = { externalSupplyId: '12345678' };

  test('items use product barcode, not offer_id', () => {
    const body = buildOzonCargoesBody(supply, {
      cargoUnits: [
        {
          barcode: '1022085884189001',
          cargoKind: 'box',
          contents: [
            {
              sku: 'MY-OFFER-001',
              productBarcode: '4601234567890',
              quantity: 3,
              expiresAt: '2026-12-31',
            },
          ],
        },
      ],
    });

    expect(body.supply_id).toBe(12345678);
    expect(body.delete_current_version).toBe(true);
    expect(body.cargoes).toHaveLength(1);
    expect(body.cargoes[0].key).toBe('1022085884189001');
    expect(body.cargoes[0].value.type).toBe('BOX');
    expect(body.cargoes[0].value.items).toEqual([
      { barcode: '4601234567890', quantity: 3, expires_at: '2026-12-31' },
    ]);
    expect(body.cargoes[0].value.items[0]).not.toHaveProperty('offer_id');
    expect(body.cargoes[0].value.items[0]).not.toHaveProperty('placement_zone');
  });

  test('falls back to line.barcode when productBarcode is empty', () => {
    const body = buildOzonCargoesBody(supply, {
      cargoUnits: [
        {
          barcode: 'CARGO-2',
          cargoKind: 'pallet',
          contents: [{ barcode: '4609999999999', quantity: 1 }],
        },
      ],
    });

    expect(body.cargoes[0].value.type).toBe('PALLET');
    expect(body.cargoes[0].value.items[0].barcode).toBe('4609999999999');
  });

  test('throws when product barcode is missing', () => {
    expect(() =>
      buildOzonCargoesBody(supply, {
        cargoUnits: [
          {
            barcode: 'CARGO-1',
            cargoKind: 'box',
            contents: [{ sku: 'OFFER-ONLY', quantity: 1, productName: 'Тест' }],
          },
        ],
      })
    ).toThrow(/штрихкод/);
  });
});
