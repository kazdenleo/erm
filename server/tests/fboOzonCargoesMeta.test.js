import {
  buildOzonEmptyCargoesBody,
  buildOzonPackingSubmitPreview,
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
  test('creates empty box slots without delete_current_version', () => {
    const body = buildOzonEmptyCargoesBody(12345, [{ key: 'erm-1', cargoKind: 'box' }]);
    expect(body.supply_id).toBe(12345);
    expect(body.delete_current_version).toBe(false);
    expect(body.cargoes[0].value.items).toEqual([]);
    expect(body.cargoes[0].value.type).toBe('BOX');
  });
});
