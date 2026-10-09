import {
  summarizeOzonBinding,
  summarizeYmBinding,
  ymOfferMappingErrors,
} from '../src/utils/certificateBindingReport.js';

describe('certificateBindingReport', () => {
  test('Ozon: bound, declined and missing held by another certificate', () => {
    const report = summarizeOzonBinding({
      expected: [
        { sku: 'A1', ozonProductId: 1 },
        { sku: 'A2', ozonProductId: 2 },
        { sku: 'A3', ozonProductId: 3 },
        { sku: 'A4', ozonProductId: 4 },
      ],
      bound: [
        { product_id: 1, product_status_code: 'approved' },
        { product_id: 2, product_status_code: 'declined' },
        { product_id: 99, product_status_code: 'approved' },
      ],
      heldBy: new Map([[3, { certificateId: 555, number: 'ЕАЭС RU С-DE.АД58.В.02612/25' }]]),
    });
    expect(report.expected).toBe(4);
    expect(report.bound).toBe(2);
    expect(report.bound_total).toBe(3);
    expect(report.statuses).toEqual({ approved: 1, declined: 1 });
    expect(report.declined).toEqual([{ sku: 'A2', ozon_product_id: 2 }]);
    expect(report.missing_count).toBe(2);
    expect(report.held_by_other_count).toBe(1);
    expect(report.missing[0]).toMatchObject({
      sku: 'A3',
      held_by_certificate_id: 555,
      reason: 'привязан к другому сертификату на Ozon: ЕАЭС RU С-DE.АД58.В.02612/25',
    });
    expect(report.missing[1]).toMatchObject({ sku: 'A4', reason: 'Ozon не привязал товар' });
  });

  test('YM: number spelled differently counts as bound; absent offers and errors explained', () => {
    const report = summarizeYmBinding({
      expected: [
        { sku: 'S1', offerId: 'O1' },
        { sku: 'S2', offerId: 'O2' },
        { sku: 'S3', offerId: 'O3' },
        { sku: 'S4', offerId: 'O4' },
      ],
      certificatesByOffer: new Map([
        ['O1', ['ТС RU С-CN.АВ29.А.05694']],
        ['O2', []],
        ['O4', []],
      ]),
      number: 'TC RU C-CN.AB29.A.05694',
      offerErrors: new Map([['O4', 'Invalid document']]),
    });
    expect(report.bound).toBe(1);
    expect(report.missing_count).toBe(3);
    expect(report.not_on_marketplace_count).toBe(1);
    expect(report.missing.map((m) => m.reason)).toEqual([
      'документ не привязан к офферу',
      'оффера нет на Маркете',
      'Маркет отклонил: Invalid document',
    ]);
  });

  test('ymOfferMappingErrors keeps only errors, not warnings', () => {
    const errs = ymOfferMappingErrors({
      status: 'OK',
      results: [
        { offerId: 'O1', errors: [{ type: 'UNKNOWN_CATEGORY', message: 'bad' }] },
        { offerId: 'O2', warnings: [{ type: 'X', message: 'warn' }] },
      ],
    });
    expect([...errs.entries()]).toEqual([['O1', 'bad']]);
    expect(ymOfferMappingErrors(null).size).toBe(0);
  });
});
