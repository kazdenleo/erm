import {
  buildOzonCertificateName,
  buildOzonV2CertificateParams,
  describeOzonV2CreateErrors,
  guessAccordanceTypeCode,
  isOzonCertificateFileAllowed,
  mapErpDocumentTypeToOzon,
  needsAccordanceType,
  normalizeOzonCertificateNumber,
  ozonCertificateCountry,
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
    expect(toOzonDateTime(new Date('2024-01-15T00:00:00.000Z'))).toBe('2024-01-15T00:00:00.000Z');
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

  test('builds name from categories and brand', () => {
    expect(
      buildOzonCertificateName({
        brand_name: 'Nordfil',
        user_categories: [{ id: 1, name: 'Фильтр воздушный' }, { id: 2, name: 'Фильтр салонный' }],
        certificate_number: 'ЕАЭС RU С-RU.АД50.В.05899/23',
      })
    ).toBe('Фильтр воздушный, Фильтр салонный Nordfil');
    expect(
      buildOzonCertificateName({ user_categories: [{ id: 1, name: 'x'.repeat(150) }], brand_name: 'B' }).length
    ).toBe(100);
  });

  test('parses create response id shapes', () => {
    expect(parseOzonCertificateCreateId({ result: 12345 })).toBe(12345);
    expect(parseOzonCertificateCreateId({ id: 99 })).toBe(99);
    expect(parseOzonCertificateCreateId({ result: { certificate_id: 7 } })).toBe(7);
    expect(parseOzonCertificateCreateId({})).toBeNull();
  });

  test('normalizes latin lookalike prefix to cyrillic', () => {
    expect(normalizeOzonCertificateNumber('TC RU C-CN.AB29.A.05694')).toBe('ТС RU C-CN.AB29.A.05694');
    expect(normalizeOzonCertificateNumber('EAEU RU C-RU.АД50.В.05899/23')).toBe('ЕАЭС RU C-RU.АД50.В.05899/23');
    expect(normalizeOzonCertificateNumber('POCC RU.АИ37.H00124')).toBe('РОСС RU.АИ37.H00124');
    expect(normalizeOzonCertificateNumber('ЕАЭС  RU C-CN.HA72.B.00775/24')).toBe('ЕАЭС RU C-CN.HA72.B.00775/24');
    expect(normalizeOzonCertificateNumber('ABC-123')).toBe('ABC-123');
  });

  test('builds v2 create params', () => {
    const params = buildOzonV2CertificateParams({
      typeCode: 'certificate_of_conformity',
      number: 'TC RU C-CN.AB29.A.05694',
      name: 'Сертификат Miles колодки',
      accordanceTypeCode: 'gost',
      issueDate: '2015-12-04',
      expireDate: null,
      files: [{ name: 'a.pdf', file_content: 'AAA' }],
    });
    expect(params).toEqual({
      certificate_type: 'CERTIFICATE_OF_CONFORMITY',
      certificate_country: 'RU',
      accordance_type: 'EAEU',
      name: 'Сертификат Miles колодки',
      number: 'ТС RU C-CN.AB29.A.05694',
      issue_date: '2015-12-04T00:00:00.000Z',
      expired_date: { infinite: true },
      files: [{ name: 'a.pdf', file_content: 'AAA' }],
    });
    const dated = buildOzonV2CertificateParams({
      typeCode: 'declaration',
      number: 'РОСС RU Д-RU.АБ12.В.00001/24',
      name: 'x',
      issueDate: '2024-01-15',
      expireDate: '2029-01-14',
    });
    expect(dated.accordance_type).toBe('NATIONAL');
    expect(dated.expired_date).toEqual({ date: { year: 2029, month: 1, day: 14 } });
    expect(dated.files).toBeUndefined();
  });

  test('extracts certification country from number', () => {
    expect(ozonCertificateCountry('ЕАЭС RU С-CN.НА72.В.00775/24')).toBe('RU');
    expect(ozonCertificateCountry('ЕАЭС KG417/039.RU.02.06810')).toBe('KG');
    expect(ozonCertificateCountry('ЕАЭС КG417/039.RU.02.06810')).toBe('KG');
    expect(ozonCertificateCountry('ЕАЭС.KZ.1234567.01.01.12345')).toBe('KZ');
    expect(ozonCertificateCountry('ЕАЭС № BY/112 02.01. ТР010 003 12345')).toBe('BY');
    expect(ozonCertificateCountry('ЕАЭС N RU Д-CN.РА01.В.12345/21')).toBe('RU');
    expect(ozonCertificateCountry('РОСС RU.АИ37.H00124')).toBe('RU');
    expect(ozonCertificateCountry('ABC-123')).toBe('RU');
  });

  test('describes v2 create validation errors', () => {
    const problems = describeOzonV2CreateErrors({
      params: [
        { name: 'CERTIFICATE_TYPE', state: 'VALID', error: null },
        { name: 'NUMBER', state: 'INVALID', error: 'Введите корректный номер', number_mask: ['^ТС RU …$'] },
        { name: 'ISSUE_DATE', state: 'MISSING', error: 'Это обязательное поле' },
      ],
      certificate_id: null,
      status: 'INCOMPLETE',
    });
    expect(problems).toHaveLength(2);
    expect(problems[0]).toContain('Номер: Введите корректный номер');
    expect(problems[0]).toContain('^ТС RU …$');
    expect(problems[1]).toBe('Дата выдачи: Это обязательное поле');
  });

  test('allows only ozon file extensions', () => {
    expect(isOzonCertificateFileAllowed('a.pdf')).toBe(true);
    expect(isOzonCertificateFileAllowed('a.JPG')).toBe(true);
    expect(isOzonCertificateFileAllowed('a.webp')).toBe(false);
  });
});
