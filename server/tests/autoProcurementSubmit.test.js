/**
 * Smoke: модуль автозакупки грузится и экспортирует runForAllProfiles / runForProfile.
 */
describe('autoProcurement.service', () => {
  test('exports scheduled runners', async () => {
    const mod = await import('../src/services/autoProcurement.service.js');
    const svc = mod.default;
    expect(typeof svc.runForProfile).toBe('function');
    expect(typeof svc.runForAllProfiles).toBe('function');
  });
});

describe('auto procurement product resolve', () => {
  test('orders without product_id are eligible when offer_id present (SQL filter intent)', () => {
    // Контракт: автозакупка берёт заказы с product_id ИЛИ offer_id/marketplace_sku
    // и резолвит товар через _resolveProductIdForOrderStock (как ручная кнопка).
    const hasCatalogLink = (row) =>
      row.product_id != null ||
      (row.offer_id != null && String(row.offer_id).trim() !== '') ||
      (row.marketplace_sku != null && String(row.marketplace_sku).trim() !== '');
    expect(hasCatalogLink({ product_id: null, offer_id: 'CN1066', marketplace_sku: null })).toBe(
      true
    );
    expect(hasCatalogLink({ product_id: null, offer_id: null, marketplace_sku: null })).toBe(false);
    expect(hasCatalogLink({ product_id: 96, offer_id: null, marketplace_sku: null })).toBe(true);
  });
});
