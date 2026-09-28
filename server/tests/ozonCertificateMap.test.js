import {
  buildOzonCertificateName,
  guessAccordanceTypeCode,
  isOzonCertificateFileAllowed,
  mapErpDocumentTypeToOzon,
  needsAccordanceType,
  parseOzonCertificateCreateId,
  toOzonDateTime,
} from '../src/utils/ozonCertificateMap.js';

describe('ozonCertificateMap', () => {
  test('maps ERP document types', () => {
    expect(mapErpDocumentTypeToOzon('certificate')).toBe('certificate_of_conformity');
    expect(mapErpDocumentTypeToOzon('declaration')).toBe('declaration');
    expect(mapErpDocumentTypeToOzon('registration')).toBe('certificate_of_registration');
    expect(mapErpDocumentTypeToOzon('unknown')).toBe('certificate_of_conformity');
  });

  test('guesses accordance type from number', () => {
    expect(guessAccordanceTypeCode('ЕАЭС RU C-RU.АД50.В.05899/23')).toBe('technical_regulations_cu');
    expect(guessAccordanceTypeCode('ГОСТ Р 51201')).toBe('gost');
    expect(guessAccordanceTypeCode('something', 'gost')).toBe('gost');
  });

  test('needs accordance for cert/declaration', () => {
    expect(needsAccordanceType('certificate_of_conformity')).toBe(true);
    expect(needsAccordanceType('declaration')).toBe(true);
    expect(needsAccordanceType('refused_letter')).toBe(false);
  });

  test('formats Ozon datetime', () => {
    expect(toOzonDateTime('2024-01-15')).toBe('2024-01-15T00:00:00.000Z');
    expect(toOzonDateTime('2024-01-15T12:00:00Z')).toBe('2024-01-15T00:00:00.000Z');
    expect(toOzonDateTime('')).toBeNull();
  });

  test('builds name within 100 chars', () => {
    const name = buildOzonCertificateName({
      brand_name: 'Miles',
      certificate_number: 'ЕАЭС RU C-CN.HA72.B.00775/24',
      document_type: 'certificate',
    });
    expect(name.length).toBeLessThanOrEqual(100);
    expect(name).toContain('Miles');
  });

  test('parses create response id shapes', () => {
    expect(parseOzonCertificateCreateId({ result: 12345 })).toBe(12345);
    expect(parseOzonCertificateCreateId({ id: 99 })).toBe(99);
    expect(parseOzonCertificateCreateId({ result: { certificate_id: 7 } })).toBe(7);
    expect(parseOzonCertificateCreateId({})).toBeNull();
  });

  test('allows only ozon file extensions', () => {
    expect(isOzonCertificateFileAllowed('a.pdf')).toBe(true);
    expect(isOzonCertificateFileAllowed('a.JPG')).toBe(true);
    expect(isOzonCertificateFileAllowed('a.webp')).toBe(false);
  });
});
