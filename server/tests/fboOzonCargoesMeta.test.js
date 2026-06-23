import {
  buildOzonEmptyCargoesBody,
  buildOzonCargoLabelsCreateBody,
  buildOzonPackingSubmitPreview,
  ozonCargoKindFromOzonType,
} from '../src/services/fboSuppliesOzonCargoes.service.js';

describe('buildOzonPackingSubmitPreview', () => {
  test('blocks api submit when ozon cargo already filled', () => {
    const preview = buildOzonPackingSubmitPreview(
      {
        cargoUnits: [
          {
            id: 1,
            barcode: '1022086000854000',
            contents: [{ productBarcode: '111', quantity: 2 }],
          },
        ],
      },
      [{ cargoId: '1022086000854000', contentType: 'MONO', bundleId: '' }]
    );
    expect(preview.canSubmitCompositionViaApi).toBe(false);
    expect(preview.filledInSubmitPlan).toEqual(['1022086000854000']);
    expect(preview.filledCargoWarning).toMatch(/Excel/);
  });

  test('allows api submit for empty ozon cargoes', () => {
    const preview = buildOzonPackingSubmitPreview(
      {
        cargoUnits: [
          {
            id: 1,
            barcode: '1022086000854000',
            contents: [{ productBarcode: '111', quantity: 2 }],
          },
        ],
      },
      [{ cargoId: '1022086000854000', contentType: 'NONE', bundleId: '' }]
    );
    expect(preview.canSubmitCompositionViaApi).toBe(true);
    expect(preview.filledCargoWarning).toBeNull();
  });
});

describe('buildOzonEmptyCargoesBody', () => {
  test('creates box slots without delete_current_version', () => {
    const body = buildOzonEmptyCargoesBody(12345, [{ key: 'erm-1', cargoKind: 'box' }]);
    expect(body.supply_id).toBe(12345);
    expect(body.delete_current_version).toBe(false);
    expect(body.cargoes[0].value.type).toBe('BOX');
    expect(body.cargoes[0].value.items).toBeUndefined();
  });

  test('can include empty items array when requested', () => {
    const body = buildOzonEmptyCargoesBody(
      12345,
      [{ key: 'erm-1', cargoKind: 'pallet' }],
      { includeEmptyItems: true }
    );
    expect(body.cargoes[0].value.type).toBe('PALLET');
    expect(body.cargoes[0].value.items).toEqual([]);
  });
});

describe('buildOzonCargoLabelsCreateBody', () => {
  test('includes BOX and PALLET types per cargo', () => {
    const body = buildOzonCargoLabelsCreateBody(999, [
      { cargoId: '1001', type: 'BOX' },
      { cargoId: '1002', cargoKind: 'pallet' },
    ]);
    expect(body.supply_id).toBe(999);
    expect(body.cargoes).toEqual([
      { cargo_id: 1001, type: 'BOX' },
      { cargo_id: 1002, type: 'PALLET' },
    ]);
  });
});

describe('ozonCargoKindFromOzonType', () => {
  test('maps Ozon types to erm kinds', () => {
    expect(ozonCargoKindFromOzonType('PALLET')).toBe('pallet');
    expect(ozonCargoKindFromOzonType('BOX')).toBe('box');
    expect(ozonCargoKindFromOzonType('')).toBe('box');
  });
});
