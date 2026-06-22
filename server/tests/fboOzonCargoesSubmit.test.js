import {
  assertOzonCargoBarcodesMatchExisting,
  buildOzonCargoesBody,
  ozonCargoKeyFromUnit,
  parseOzonSupplyCargoIds,
} from '../src/services/fboSuppliesSubmit.service.js';

describe('buildOzonCargoesBody', () => {
  const supply = { externalSupplyId: '12345678' };

  test('items use product barcode; cargo key is ШК из сборки', () => {
    const body = buildOzonCargoesBody(
      supply,
      {
        cargoUnits: [
          {
            id: 1,
            barcode: '1022086000854000',
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
      },
      { ozonSupplyId: 987654321 }
    );

    expect(body.supply_id).toBe(987654321);
    expect(body.cargoes[0].key).toBe('1022086000854000');
    expect(body.cargoes[0].value.items[0].barcode).toBe('4601234567890');
  });
});

describe('assertOzonCargoBarcodesMatchExisting', () => {
  test('rejects when Ozon has no cargoes yet', () => {
    expect(() => assertOzonCargoBarcodesMatchExisting(['1022086000854000'], [])).toThrow(
      /ещё нет грузомест/
    );
  });

  test('rejects when ERM barcode not in Ozon', () => {
    expect(() =>
      assertOzonCargoBarcodesMatchExisting(
        ['1022086000854000'],
        ['1022086001533000']
      )
    ).toThrow(/не найдены в Ozon/);
  });

  test('passes when barcodes match', () => {
    expect(() =>
      assertOzonCargoBarcodesMatchExisting(
        ['1022086000854000'],
        ['1022086000854000']
      )
    ).not.toThrow();
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
              cargoes: [{ cargo_id: 1022086000854000 }],
            },
          ],
        },
      },
      '12345678'
    );
    expect(ids).toEqual(['1022086000854000']);
  });
});

describe('ozonCargoKeyFromUnit', () => {
  test('trims barcode string', () => {
    expect(ozonCargoKeyFromUnit({ barcode: ' 1022086000854000 ' })).toBe('1022086000854000');
  });
});
