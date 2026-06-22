import {
  buildOzonCargoesBody,
  ozonCargoKeyFromUnit,
} from '../src/services/fboSuppliesSubmit.service.js';

describe('buildOzonCargoesBody', () => {
  const supply = { externalSupplyId: '12345678' };

  test('items use product barcode; cargo key is ШК из сборки', () => {
    const body = buildOzonCargoesBody(supply, {
      cargoUnits: [
        {
          id: 1,
          barcode: '1022085981237000',
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
    expect(body.delete_current_version).toBeUndefined();
    expect(body.cargoes).toHaveLength(1);
    expect(body.cargoes[0].key).toBe('1022085981237000');
    expect(body.cargoes[0].value.type).toBe('BOX');
    expect(body.cargoes[0].value.items).toEqual([
      { barcode: '4601234567890', quantity: 3, expires_at: '2026-12-31' },
    ]);
    expect(body.cargoes[0].value.items[0]).not.toHaveProperty('offer_id');
  });

  test('sends ERM barcode as key even if it differs from another Ozon id', () => {
    const body = buildOzonCargoesBody(supply, {
      cargoUnits: [
        {
          id: 2,
          barcode: '1022085990462000',
          cargoKind: 'box',
          contents: [{ productBarcode: '4601234567890', quantity: 1 }],
        },
      ],
    });
    expect(body.cargoes[0].key).toBe('1022085990462000');
  });

  test('throws when product barcode is missing', () => {
    expect(() =>
      buildOzonCargoesBody(supply, {
        cargoUnits: [
          {
            id: 1,
            barcode: 'CARGO-1',
            cargoKind: 'box',
            contents: [{ sku: 'OFFER-ONLY', quantity: 1, productName: 'Тест' }],
          },
        ],
      })
    ).toThrow(/штрихкод/);
  });
});

describe('ozonCargoKeyFromUnit', () => {
  test('trims barcode string', () => {
    expect(ozonCargoKeyFromUnit({ barcode: ' 1022085990462000 ' })).toBe('1022085990462000');
  });
});
