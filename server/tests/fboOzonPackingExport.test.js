import {
  ozonCargoTypeExportLabel,
  ozonPlacementZoneForExport,
} from '../src/constants/ozonPlacementZones.js';

describe('ozonPlacementZoneForExport', () => {
  test('sortable zone for Ozon template', () => {
    expect(ozonPlacementZoneForExport('SORTABLE', [])).toBe('Сортируемый товар');
  });

  test('empty when unknown', () => {
    expect(ozonPlacementZoneForExport(null, [])).toBe('');
  });
});

describe('ozonCargoTypeExportLabel', () => {
  test('box and pallet', () => {
    expect(ozonCargoTypeExportLabel('box')).toBe('Коробка');
    expect(ozonCargoTypeExportLabel('pallet')).toBe('Паллета');
  });
});
