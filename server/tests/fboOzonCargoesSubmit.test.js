import {
  assertOzonCargoBarcodesMatchExisting,
  assertOzonCargoIdsUnchanged,
  assertOzonCargoesNotFilledYet,
  assertOzonPollCargoIdsMatchPlan,
  buildOzonCargoSubmitPlan,
  buildOzonCargoesBody,
  extractOzonCargoIdMapping,
  ozonCargoKeyFromUnit,
  parseOzonSupplyCargoIds,
  parseOzonSupplyCargoes,
  selectOzonCargoesForCompositionSubmit,
} from '../src/services/fboSuppliesSubmit.service.js';

describe('buildOzonCargoesBody', () => {
  const supply = { externalSupplyId: '12345678' };
  const packing = {
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
  };
  const ozonCargoes = [{ cargoId: '1022086000854000', contentType: 'NONE', bundleId: '' }];
  const submitPlan = buildOzonCargoSubmitPlan(packing, ozonCargoes);

  test('uses ordinal request keys; items use product barcode', () => {
    const body = buildOzonCargoesBody(supply, packing, {
      ozonSupplyId: 987654321,
      submitPlan,
    });

    expect(body.supply_id).toBe(987654321);
    expect(body.delete_current_version).toBe(false);
    expect(body.cargoes[0].key).toBe('1');
    expect(body.cargoes[0].value.items[0].barcode).toBe('4601234567890');
  });
});

describe('buildOzonCargoSubmitPlan', () => {
  test('maps ERM barcode to ordinal key by Ozon cargo_id order', () => {
    const plan = buildOzonCargoSubmitPlan(
      {
        cargoUnits: [
          {
            id: 2,
            barcode: '1022086001533000',
            contents: [{ productBarcode: '111', quantity: 1 }],
          },
          {
            id: 1,
            barcode: '1022086000854000',
            contents: [{ productBarcode: '222', quantity: 2 }],
          },
        ],
      },
      [
        { cargoId: '1022086000854000', contentType: 'NONE', bundleId: '' },
        { cargoId: '1022086001533000', contentType: 'NONE', bundleId: '' },
      ]
    );

    expect(plan).toHaveLength(2);
    expect(plan[0]).toMatchObject({
      requestKey: '1',
      ozonCargoId: '1022086000854000',
      ermBarcode: '1022086000854000',
    });
    expect(plan[1]).toMatchObject({
      requestKey: '2',
      ozonCargoId: '1022086001533000',
      ermBarcode: '1022086001533000',
    });
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

describe('assertOzonCargoesNotFilledYet', () => {
  test('rejects when cargo already has composition', () => {
    expect(() =>
      assertOzonCargoesNotFilledYet([
        { cargoId: '1022086000854000', contentType: 'MONO', bundleId: 'b1' },
      ])
    ).toThrow(/уже установлен в Ozon/);
  });
});

describe('assertOzonPollCargoIdsMatchPlan', () => {
  test('rejects when Ozon assigns different cargo_id', () => {
    const plan = [
      {
        requestKey: '1',
        ozonCargoId: '1022086000854000',
        ermBarcode: '1022086000854000',
      },
    ];
    const mapping = new Map([['1', '1022086001533000']]);
    expect(() => assertOzonPollCargoIdsMatchPlan(plan, mapping)).toThrow(/другие ID/);
  });
});

describe('assertOzonCargoIdsUnchanged', () => {
  test('rejects when cargo ids changed after submit', () => {
    expect(() =>
      assertOzonCargoIdsUnchanged(['1022086000854000'], ['1022086001533000'])
    ).toThrow(/изменил номера/);
  });
});

describe('parseOzonSupplyCargoes', () => {
  test('extracts cargo metadata for supply', () => {
    const cargoes = parseOzonSupplyCargoes(
      {
        result: {
          supply: [
            {
              supply_id: 12345678,
              cargoes: [{ cargo_id: 1022086000854000, content_type: 'NONE' }],
            },
          ],
        },
      },
      '12345678'
    );
    expect(cargoes).toEqual([
      {
        cargoId: '1022086000854000',
        contentType: 'NONE',
        bundleId: '',
        type: '',
      },
    ]);
  });
});

describe('selectOzonCargoesForCompositionSubmit', () => {
  test('skips cargoes that already have composition', () => {
    const selected = selectOzonCargoesForCompositionSubmit([
      { cargoId: '1', contentType: 'MONO', bundleId: 'b' },
      { cargoId: '2', contentType: 'NONE', bundleId: '' },
    ]);
    expect(selected.map((c) => c.cargoId)).toEqual(['2']);
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

describe('extractOzonCargoIdMapping', () => {
  test('reads key to cargo_id from poll result', () => {
    const mapping = extractOzonCargoIdMapping({
      cargoes: [{ key: '1', value: { cargo_id: 1022086000854000 } }],
    });
    expect(mapping.get('1')).toBe('1022086000854000');
  });
});

describe('ozonCargoKeyFromUnit', () => {
  test('trims barcode string', () => {
    expect(ozonCargoKeyFromUnit({ barcode: ' 1022086000854000 ' })).toBe('1022086000854000');
  });
});
