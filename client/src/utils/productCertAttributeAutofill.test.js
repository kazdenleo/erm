import { applyCertAutofillToAttributes } from './productCertAttributeAutofill.js';

describe('applyCertAutofillToAttributes', () => {
  const attrs = [
    { id: '15001136', name: 'Номер сертификата соответствия' },
    { id: '15001137', name: 'Дата регистрации сертификата/декларации' },
    { id: '15001138', name: 'Дата окончания действия сертификата/декларации' },
  ];
  const certSource = {
    certificate: {
      number: 'ЕАЭС RU С-DE.АД58.В.02612/25',
      validFrom: '2025-10-30',
      validTo: '2029-10-29',
    },
    primaryDocType: 'certificate',
  };
  const opts = {
    getAttrKey: (a) => String(a.id),
    getAttrName: (a) => a.name,
    formatDate: (d) => {
      const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(String(d || ''));
      return m ? `${m[3]}.${m[2]}.${m[1]}` : String(d || '');
    },
  };

  test('overwrites previously filled certificate dates from registry', () => {
    const next = applyCertAutofillToAttributes(
      attrs,
      certSource,
      {
        15001136: 'ЕАЭС RU С-DE.АД58.В.02612/25',
        15001137: '02.04.2024',
        15001138: '01.04.2028',
      },
      opts
    );
    expect(next['15001137']).toBe('30.10.2025');
    expect(next['15001138']).toBe('29.10.2029');
  });
});
