import {
  isYmDocumentAlreadyExistsError,
  mapErpDocumentTypeToYm,
  parseYmCreateDocument,
  toYmDateOnly,
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

  test('detects already exists errors', () => {
    expect(isYmDocumentAlreadyExistsError({ code: 'DOCUMENT_ALREADY_EXISTS' })).toBe(true);
    expect(ymCreateErrors({ result: { errors: [{ code: 'DOCUMENT_ALREADY_EXISTS' }] } })).toHaveLength(1);
  });
});
