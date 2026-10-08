import {
  certificateNumberKey,
  dateOnlyOrNull,
  inferBrandAndCategories,
  mergeMarketplaceCertificates,
  ozonTypeToErp,
  ymTypeToErp,
} from '../src/utils/certificateImportMap.js';

describe('certificateImportMap', () => {
  test('number key ignores latin/cyrillic lookalikes and spaces', () => {
    const key = certificateNumberKey('ТС RU С-CN.АВ29.А.05694');
    expect(certificateNumberKey('TC RU C-CN.AB29.A.05694')).toBe(key);
    expect(certificateNumberKey('ТС  RU С-CN.АВ29.А.05694 ')).toBe(key);
    expect(certificateNumberKey('EAEU RU C-CN.HA72.B.00775/24')).toBe(certificateNumberKey('ЕАЭС RU С-CN.НА72.В.00775/24'));
    expect(certificateNumberKey('ЕАЭС RU С-CN.НА72.В.00775/24')).not.toBe(certificateNumberKey('ЕАЭС RU С-CN.НА72.В.00776/24'));
    expect(certificateNumberKey('')).toBe('');
  });

  test('maps marketplace types', () => {
    expect(ozonTypeToErp('certificate_of_conformity')).toBe('certificate');
    expect(ozonTypeToErp('declaration')).toBe('declaration');
    expect(ozonTypeToErp('registration_certificate')).toBe('registration');
    expect(ozonTypeToErp('refused_letter')).toBe('certificate');
    expect(ymTypeToErp('CONFORMITY_DECLARATION')).toBe('declaration');
    expect(ymTypeToErp('MEDICAL_DEVICE_CERTIFICATE')).toBe('certificate');
  });

  test('normalizes dates', () => {
    expect(dateOnlyOrNull('2023-07-31T00:00:00Z')).toBe('2023-07-31');
    expect(dateOnlyOrNull('2028-04-01')).toBe('2028-04-01');
    expect(dateOnlyOrNull('0001-01-01T00:00:00Z')).toBeNull();
    expect(dateOnlyOrNull(null)).toBeNull();
  });

  test('merges same document from both marketplaces', () => {
    const merged = mergeMarketplaceCertificates(
      [
        { certificate_id: 1, certificate_number: 'ЕАЭС RU С-CN.НА72.В.00775/24', type_code: 'certificate_of_conformity', issue_date: '2024-04-02T00:00:00Z', expire_date: '2028-04-01T00:00:00Z' },
        { certificate_id: 2, certificate_number: 'ТС RU С-CN.АВ29.А.05694', type_code: 'certificate_of_conformity', issue_date: '2015-12-04T00:00:00Z' },
      ],
      [
        { id: 10, number: 'EAEU RU C-CN.HA72.B.00775/24', type: 'CONFORMITY_CERTIFICATE', activeFromDate: '2024-04-02' },
        { id: 11, number: 'ЕАЭС RU С-DE.АД58.В.02612/25', type: 'CONFORMITY_CERTIFICATE', activeFromDate: '2024-04-02', activeToDate: '2028-04-01' },
      ]
    );
    expect(merged).toHaveLength(3);
    const shared = merged.find((e) => e.ozon?.certificate_id === 1);
    expect(shared.ym.id).toBe(10);
    expect(shared.number).toBe('ЕАЭС RU С-CN.НА72.В.00775/24');
    expect(shared.validTo).toBe('2028-04-01');
    const ymOnly = merged.find((e) => e.ym?.id === 11);
    expect(ymOnly.ozon).toBeNull();
    expect(ymOnly.validTo).toBe('2028-04-01');
  });

  test('infers most frequent brand and its categories', () => {
    expect(
      inferBrandAndCategories([
        { brand_id: 5, user_category_id: 2 },
        { brand_id: 5, user_category_id: 3 },
        { brand_id: 5, user_category_id: 2 },
        { brand_id: 7, user_category_id: 9 },
        { brand_id: null, user_category_id: 4 },
      ])
    ).toEqual({ brandId: 5, categoryIds: [2, 3] });
    expect(inferBrandAndCategories([])).toEqual({ brandId: null, categoryIds: [] });
  });
});
