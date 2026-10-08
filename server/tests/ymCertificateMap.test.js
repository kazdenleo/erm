import {
  isYmDocumentAlreadyExistsError,
  mapErpDocumentTypeToYm,
  parseYmCreateDocument,
  toYmDateOnly,
  toYmRegistryCertificateNumber,
  ymCreateErrors,
} from '../src/utils/ymCertificateMap.js';

describe('ymCertificateMap', () => {
  test('maps ERP document types', () => {
    expect(mapErpDocumentTypeToYm('certificate')).toBe('CONFORMITY_CERTIFICATE');
    expect(mapErpDocumentTypeToYm('declaration')).toBe('CONFORMITY_DECLARATION');
    expect(mapErpDocumentTypeToYm('registration')).toBe('STATE_REGISTRATION_CERTIFICATE');
    expect(mapErpDocumentTypeToYm('certificate', 'MEDICAL_DEVICE_CERTIFICATE')).toBe(
      'MEDICAL_DEVICE_CERTIFICATE'
    );
  });

  test('formats YM dates', () => {
    expect(toYmDateOnly('2024-01-15')).toBe('2024-01-15');
    expect(toYmDateOnly('2024-01-15T12:00:00Z')).toBe('2024-01-15');
    expect(toYmDateOnly(new Date('2024-01-15T00:00:00.000Z'))).toBe('2024-01-15');
    expect(toYmDateOnly('')).toBeNull();
  });

  test('parses create response', () => {
    const parsed = parseYmCreateDocument(
      {
        result: {
          documents: [{ id: 42, number: 'ЕАЭС-1', status: 'VALIDATING', type: 'CONFORMITY_CERTIFICATE' }],
        },
      },
      'ЕАЭС-1'
    );
    expect(parsed).toEqual({
      id: 42,
      number: 'ЕАЭС-1',
      status: 'VALIDATING',
      type: 'CONFORMITY_CERTIFICATE',
    });
  });

  test('converts number to FSA registry form', () => {
    expect(toYmRegistryCertificateNumber('TC RU C-CN.AB29.A.05694')).toBe('ТС RU С-CN.АВ29.А.05694');
    expect(toYmRegistryCertificateNumber('ЕАЭС RU С-CN.НА72.В.00775/24')).toBe('ЕАЭС RU С-CN.НА72.В.00775/24');
    expect(toYmRegistryCertificateNumber('EAEU RU C-CN.HA72.B.00775/24')).toBe('ЕАЭС RU С-CN.НА72.В.00775/24');
    expect(toYmRegistryCertificateNumber('ЕАЭС N RU Д-CN.PA01.B.12345/21')).toBe('ЕАЭС N RU Д-CN.РА01.В.12345/21');
    expect(toYmRegistryCertificateNumber('РОСС RU.АИ37.H00124')).toBe('РОСС RU.АИ37.H00124');
  });

  test('detects already exists errors', () => {
    expect(isYmDocumentAlreadyExistsError({ code: 'DOCUMENT_ALREADY_EXISTS' })).toBe(true);
    expect(ymCreateErrors({ result: { errors: [{ code: 'DOCUMENT_ALREADY_EXISTS' }] } })).toHaveLength(1);
  });
});
