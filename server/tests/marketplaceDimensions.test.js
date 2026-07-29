import {
  resolveMarketplaceDimensionsMm,
  resolveMarketplaceVolumeLiters,
} from '../src/utils/marketplaceDimensions.js';

describe('resolveMarketplaceDimensionsMm / volume', () => {
  test('Ozon: attrs mm over ERP dims', () => {
    const product = {
      length: 210,
      width: 229,
      height: 45,
      ozon_attributes: { 9802: 200, 6605: 214, 6606: 35 },
    };
    const dims = resolveMarketplaceDimensionsMm(product, 'ozon');
    expect(dims).toMatchObject({ length: 200, width: 214, height: 35, source: 'ozon_attributes' });
    expect(resolveMarketplaceVolumeLiters(product, 'ozon')).toBe(
      Math.round((200 * 214 * 35) / 1000) / 1000
    );
  });

  test('WB: pack cm attrs preferred', () => {
    const product = {
      length: 210,
      width: 229,
      height: 45,
      wb_attributes: { 90849: 21, 90745: 22.9, 90846: 4.5 },
    };
    const dims = resolveMarketplaceDimensionsMm(product, 'wb');
    expect(dims.source).toBe('wb_attributes_pack');
    expect(dims.length).toBe(210);
    expect(dims.width).toBe(229);
    expect(dims.height).toBe(45);
  });

  test('WB: item mm when pack missing', () => {
    const product = {
      length: 210,
      width: 229,
      height: 45,
      wb_attributes: { 12153433: 200, 7594048: 214, 7594043: 35 },
    };
    const dims = resolveMarketplaceDimensionsMm(product, 'wb');
    expect(dims).toMatchObject({
      length: 200,
      width: 214,
      height: 35,
      source: 'wb_attributes_item_mm',
    });
  });

  test('YM: ym_draft.weightDimensions cm', () => {
    const product = {
      length: 100,
      width: 100,
      height: 100,
      ym_draft: { weightDimensions: { length: 26, width: 16.5, height: 6.7 } },
    };
    const dims = resolveMarketplaceDimensionsMm(product, 'ym');
    expect(dims.source).toBe('ym_draft.weightDimensions');
    expect(dims.length).toBe(260);
    expect(dims.width).toBe(165);
    expect(dims.height).toBe(67);
  });

  test('fallback to ERP dims when mp attrs empty', () => {
    const product = { length: 400, width: 250, height: 150 };
    expect(resolveMarketplaceDimensionsMm(product, 'ozon').source).toBe('product');
    expect(resolveMarketplaceVolumeLiters(product, 'wb')).toBe(15);
  });
});
