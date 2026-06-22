import {
  assertNoExtraOzonCargoesAfterSubmit,
  assertOzonCargoBarcodesMatchExisting,
  assertOzonCargoesCreateCompleted,
  assertOzonPollCargoIdsMatchPlan,
  assertPlanCargoIdsStillPresent,
  buildOzonCargoSubmitPlan,
  buildOzonCargoesBody,
  detectOzonCargoSubmitMode,
  extractOzonCargoIdMapping,
  findExtraOzonCargoes,
  isOzonCargoFilled,
  ozonCargoKeyFromUnit,
  parseOzonSupplyCargoIds,
  parseOzonSupplyCargoes,
  resolveOzonCargoesForSubmit,
  resolveOzonDeleteCurrentVersion,
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

  test('uses cargo_id as request key; items use product barcode', () => {
    const body = buildOzonCargoesBody(supply, packing, {
      ozonSupplyId: 987654321,
      submitPlan,
    });

    expect(body.supply_id).toBe(987654321);
    expect(body.delete_current_version).toBe(false);
    expect(body.cargoes[0].key).toBe('1022086000854000');
    expect(body.cargoes[0].value.items[0].barcode).toBe('4601234567890');
  });

  test('sets delete_current_version when replacing existing Ozon cargoes', () => {
    const body = buildOzonCargoesBody(supply, packing, {
      ozonSupplyId: 987654321,
      submitPlan,
      deleteCurrentVersion: true,
    });

    expect(body.delete_current_version).toBe(true);
  });
});

describe('buildOzonCargoSubmitPlan', () => {
  test('maps ERM barcode to cargo_id request key', () => {
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
      requestKey: '1022086000854000',
      ozonCargoId: '1022086000854000',
      ermBarcode: '1022086000854000',
      mode: 'create',
    });
    expect(plan[1]).toMatchObject({
      requestKey: '1022086001533000',
      ozonCargoId: '1022086001533000',
      ermBarcode: '1022086001533000',
      mode: 'create',
    });
  });

  test('allows update when cargo already has composition', () => {
    const plan = buildOzonCargoSubmitPlan(
      {
        cargoUnits: [
          {
            id: 1,
            barcode: '1022086008662000',
            contents: [{ productBarcode: '111', quantity: 1 }],
          },
        ],
      },
      [{ cargoId: '1022086008662000', contentType: 'MONO', bundleId: 'b1' }]
    );

    expect(plan).toHaveLength(1);
    expect(plan[0].mode).toBe('update');
    expect(plan[0].ozonCargoId).toBe('1022086008662000');
  });
});

describe('resolveOzonCargoesForSubmit', () => {
  test('matches erm barcodes to ozon cargo_id', () => {
    const matched = resolveOzonCargoesForSubmit(
      [
        { cargoId: '2', contentType: 'MONO', bundleId: 'b' },
        { cargoId: '1', contentType: 'NONE', bundleId: '' },
      ],
      ['1']
    );
    expect(matched.map((c) => c.cargoId)).toEqual(['1']);
  });
});

describe('resolveOzonDeleteCurrentVersion', () => {
  test('returns true when Ozon already has cargoes', () => {
    expect(resolveOzonDeleteCurrentVersion([{ cargoId: '1' }])).toBe(true);
    expect(resolveOzonDeleteCurrentVersion([])).toBe(false);
  });
});

describe('findExtraOzonCargoes', () => {
  test('lists Ozon cargo ids not in ERM assembly', () => {
    expect(
      findExtraOzonCargoes(
        [{ cargoId: '1022086008662000' }, { cargoId: '1022086044388000' }],
        ['1022086008662000']
      )
    ).toEqual(['1022086044388000']);
  });
});

describe('assertOzonCargoesCreateCompleted', () => {
  test('rejects PENDING poll result', () => {
    expect(() => assertOzonCargoesCreateCompleted({ ok: true, status: 'PENDING' })).toThrow(
      /не подтвердил/
    );
  });
});

describe('detectOzonCargoSubmitMode', () => {
  test('returns update when any cargo is filled', () => {
    expect(
      detectOzonCargoSubmitMode([{ cargoId: '1', contentType: 'MONO', bundleId: '' }])
    ).toBe('update');
    expect(
      detectOzonCargoSubmitMode([{ cargoId: '1', contentType: 'NONE', bundleId: '' }])
    ).toBe('create');
  });
});

describe('isOzonCargoFilled', () => {
  test('detects MONO/MIX/bundle', () => {
    expect(isOzonCargoFilled({ contentType: 'MONO', bundleId: '' })).toBe(true);
    expect(isOzonCargoFilled({ contentType: 'NONE', bundleId: 'b' })).toBe(true);
    expect(isOzonCargoFilled({ contentType: 'NONE', bundleId: '' })).toBe(false);
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

describe('assertNoExtraOzonCargoesAfterSubmit', () => {
  test('rejects when Ozon created extra cargo', () => {
    expect(() =>
      assertNoExtraOzonCargoesAfterSubmit(
        ['1022086008662000'],
        [{ cargoId: '1022086008662000' }, { cargoId: '1022086038261000' }]
      )
    ).toThrow(/дополнительные грузоместа/);
  });
});

describe('assertOzonPollCargoIdsMatchPlan', () => {
  test('rejects when Ozon assigns different cargo_id', () => {
    const plan = [
      {
        requestKey: '1022086008662000',
        ozonCargoId: '1022086008662000',
        ermBarcode: '1022086008662000',
      },
    ];
    const mapping = new Map([['1022086008662000', '1022086038261000']]);
    expect(() => assertOzonPollCargoIdsMatchPlan(plan, mapping)).toThrow(/другие ID/);
  });
});

describe('assertPlanCargoIdsStillPresent', () => {
  test('rejects when plan cargo id missing after submit', () => {
    const plan = [{ ozonCargoId: '1022086000854000' }];
    expect(() => assertPlanCargoIdsStillPresent(plan, [{ cargoId: '1022086001533000' }])).toThrow(
      /изменил номера/
    );
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
      cargoes: [{ key: '1022086000854000', value: { cargo_id: 1022086000854000 } }],
    });
    expect(mapping.get('1022086000854000')).toBe('1022086000854000');
  });
});

describe('ozonCargoKeyFromUnit', () => {
  test('trims barcode string', () => {
    expect(ozonCargoKeyFromUnit({ barcode: ' 1022086000854000 ' })).toBe('1022086000854000');
  });
});
