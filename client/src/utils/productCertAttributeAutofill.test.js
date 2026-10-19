import { filterBrandCertsForProduct } from './productCertAttributeAutofill.js';

describe('filterBrandCertsForProduct', () => {
  test('keeps only certificates linked to the product', () => {
    const certs = [
      { id: 1, product_ids: [10, 20] },
      { id: 2, product_ids: [30] },
      { id: 3, products: [{ id: 10, sku: 'A' }] },
      { id: 4, product_ids: [] },
    ];
    expect(filterBrandCertsForProduct(certs, 10).map((c) => c.id)).toEqual([1, 3]);
    expect(filterBrandCertsForProduct(certs, 99)).toEqual([]);
    expect(filterBrandCertsForProduct(certs, null)).toEqual([]);
  });
});
