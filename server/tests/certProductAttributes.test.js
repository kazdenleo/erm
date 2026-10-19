import {
  mergeExistingCertKeys,
  wbCertAttributePatch,
} from '../src/utils/certProductAttributes.js';

describe('certProductAttributes', () => {
  test('builds WB patch with DD.MM.YYYY dates', () => {
    expect(
      wbCertAttributePatch({
        certificate_number: 'ЕАЭС RU С-DE.АД58.В.02612/25',
        document_type: 'certificate',
        valid_from: '2025-10-30',
        valid_to: '2029-10-29',
      })
    ).toEqual({
      15001136: 'ЕАЭС RU С-DE.АД58.В.02612/25',
      15001137: '30.10.2025',
      15001138: '29.10.2029',
    });
  });

  test('accepts Date objects from PostgreSQL', () => {
    expect(
      wbCertAttributePatch({
        certificate_number: 'X',
        valid_from: new Date('2025-10-30T00:00:00.000Z'),
        valid_to: new Date('2029-10-29T00:00:00.000Z'),
      })
    ).toMatchObject({
      15001137: '30.10.2025',
      15001138: '29.10.2029',
    });
  });

  test('merges only keys already present on the product card', () => {
    const { next, changed } = mergeExistingCertKeys(
      {
        15001136: 'OLD',
        15001137: '02.04.2024',
        15001138: '01.04.2028',
        5023: 'CN1266K',
      },
      {
        15001136: 'ЕАЭС RU С-DE.АД58.В.02612/25',
        15001137: '30.10.2025',
        15001138: '29.10.2029',
        999999: 'should-skip',
      }
    );
    expect(changed).toBe(true);
    expect(next['15001137']).toBe('30.10.2025');
    expect(next['15001138']).toBe('29.10.2029');
    expect(next['5023']).toBe('CN1266K');
    expect(next['999999']).toBeUndefined();
  });
});
