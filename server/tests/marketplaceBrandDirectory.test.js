import {
  brandNameNorm,
  normalizeDirectoryBrandEntries,
  normalizeMpBrandMarketplace,
  pickDirectoryBrandName,
  rankDirectoryBrands,
} from '../src/utils/marketplaceBrandDirectory.js';

describe('marketplaceBrandDirectory', () => {
  test('normalizes marketplace keys', () => {
    expect(normalizeMpBrandMarketplace('wildberries')).toBe('wb');
    expect(normalizeMpBrandMarketplace('yandexmarket')).toBe('ym');
    expect(normalizeMpBrandMarketplace('Ozon')).toBe('ozon');
  });

  test('ranks Miles → MILES without regard to case', () => {
    const list = rankDirectoryBrands(
      [
        { name: 'Michelin', id: '1' },
        { name: 'MILES', id: '2' },
        { name: 'Miles Sport', id: '3' },
      ],
      'Miles'
    );
    expect(list[0].name).toBe('MILES');
    expect(pickDirectoryBrandName(list, 'miles')).toBe('MILES');
  });

  test('normalizes Ozon dictionary values', () => {
    const list = normalizeDirectoryBrandEntries({
      result: [{ id: 123, value: 'Miles' }, { id: 123, value: 'Miles' }],
    });
    expect(list).toEqual([{ name: 'Miles', id: '123' }]);
    expect(brandNameNorm('  Miles  ')).toBe('miles');
  });
});
