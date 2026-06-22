import {
  buildOzonCargoesBody,
  extractOzonCargoIdMapping,
  parseOzonSupplyCargoIds,
} from '../src/services/fboSuppliesSubmit.service.js';

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
    expect(body.delete_current_version).toBeUndefined();
    expect(body.cargoes).toHaveLength(1);
    expect(body.cargoes[0].key).toBe('1022085884189001');
    expect(body.cargoes[0].value.type).toBe('BOX');
    expect(body.cargoes[0].value.items).toEqual([
      { barcode: '4601234567890', quantity: 3, expires_at: '2026-12-31' },
    ]);
  });

  test('requires matching Ozon cargo_id when cargoes already exist in Ozon', () => {
    expect(() =>
      buildOzonCargoesBody(
        supply,
        {
          cargoUnits: [
            {
              barcode: '1022085963765000',
              cargoKind: 'box',
              contents: [{ productBarcode: '4601234567890', quantity: 1 }],
            },
          ],
        },
        { ozonCargoIds: ['1022085981237000'] }
      )
    ).toThrow(/не совпадают с Ozon/);
  });

  test('uses Ozon cargo_id as key when barcodes match', () => {
    const body = buildOzonCargoesBody(
      supply,
      {
        cargoUnits: [
          {
            barcode: '1022085981237000',
            cargoKind: 'box',
            contents: [{ productBarcode: '4601234567890', quantity: 1 }],
          },
        ],
      },
      { ozonCargoIds: ['1022085981237000'] }
    );
    expect(body.cargoes[0].key).toBe('1022085981237000');
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

describe('parseOzonSupplyCargoIds', () => {
  test('extracts cargo_id list for supply', () => {
    const ids = parseOzonSupplyCargoIds(
      {
        result: {
          supply: [
            {
              supply_id: 12345678,
              cargoes: [{ cargo_id: 1022085981237000 }],
            },
          ],
        },
      },
      '12345678'
    );
    expect(ids).toEqual(['1022085981237000']);
  });
});

describe('extractOzonCargoIdMapping', () => {
  test('maps request key to Ozon cargo_id', () => {
    const map = extractOzonCargoIdMapping({
      data: {
        cargoes: [{ key: 'client-1', value: { cargo_id: 1022085981237000 } }],
      },
    });
    expect(map.get('client-1')).toBe('1022085981237000');
  });
});
