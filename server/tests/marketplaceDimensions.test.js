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

  test('WB: wb_draft.dimensions preferred over item attrs', () => {
    const product = {
      length: 260,
      width: 165,
      height: 67,
      wb_draft: { dimensions: { length: 260, width: 100, height: 100 } },
      wb_attributes: { 90652: 17, 90673: 10, 90630: 10 },
    };
    const dims = resolveMarketplaceDimensionsMm(product, 'wb');
    expect(dims.source).toBe('wb_draft.dimensions');
    expect(dims).toMatchObject({ length: 260, width: 100, height: 100 });
    expect(resolveMarketplaceVolumeLiters(product, 'wb')).toBe(2.6);
  });

  test('WB: pack attrs preferred over draft', () => {
    const product = {
      wb_draft: { dimensions: { length: 260, width: 100, height: 100 } },
      wb_attributes: { 90849: 21, 90745: 22.9, 90846: 4.5 },
    };
    expect(resolveMarketplaceDimensionsMm(product, 'wb').source).toBe('wb_attributes_pack');
  });

  test('WB: item attrs ignored (packaging only)', () => {
    const product = {
      length: 400,
      width: 250,
      height: 150,
      volume: 15,
      wb_attributes: { 12153433: 200, 7594048: 214, 7594043: 35 },
    };
    expect(resolveMarketplaceDimensionsMm(product, 'wb')).toBeNull();
    expect(resolveMarketplaceVolumeLiters(product, 'wb')).toBeNull();
  });

  test('YM: linked ERP preferred over stale ym_draft', () => {
    const product = {
      length: 260,
      width: 165,
      height: 67,
      volume: 2.874,
      mp_field_links: { dimensions: ['ozon', 'wb', 'ym'] },
      ym_draft: { weightDimensions: { length: 26, width: 17, height: 7 } },
    };
    const dims = resolveMarketplaceDimensionsMm(product, 'ym');
    expect(dims.source).toBe('product_linked');
    expect(dims).toMatchObject({ length: 260, width: 165, height: 67 });
    expect(resolveMarketplaceVolumeLiters(product, 'ym')).toBe(2.874);
  });

  test('YM: unlinked ym_draft.weightDimensions cm → 2.874 л', () => {
    const product = {
      length: 100,
      width: 100,
      height: 100,
      volume: 3.09,
      mp_field_links: { dimensions: [] },
      ym_draft: { weightDimensions: { length: 26, width: 16.5, height: 6.7 } },
    };
    const dims = resolveMarketplaceDimensionsMm(product, 'ym');
    expect(dims.source).toBe('ym_draft.weightDimensions');
    expect(dims.length).toBe(260);
    expect(dims.width).toBe(165);
    expect(dims.height).toBe(67);
    expect(resolveMarketplaceVolumeLiters(product, 'ym')).toBe(2.874);
  });

  test('YM: without packaging dims — null (no ERP when unlinked)', () => {
    const product = {
      length: 400,
      width: 250,
      height: 150,
      volume: 3.09,
      mp_field_links: { dimensions: [] },
    };
    expect(resolveMarketplaceDimensionsMm(product, 'ym')).toBeNull();
    expect(resolveMarketplaceVolumeLiters(product, 'ym')).toBeNull();
  });

  test('YM: linked without ERP falls back to ym_draft', () => {
    const product = {
      mp_field_links: { dimensions: ['ym'] },
      ym_draft: { weightDimensions: { length: 26, width: 16.5, height: 6.7 } },
    };
    expect(resolveMarketplaceDimensionsMm(product, 'ym').source).toBe('ym_draft.weightDimensions');
    expect(resolveMarketplaceVolumeLiters(product, 'ym')).toBe(2.874);
  });

  test('Ozon: draft.dimensions when attrs empty', () => {
    const product = {
      length: 400,
      width: 250,
      height: 150,
      mp_field_links: { dimensions: [] },
      ozon_draft: { dimensions: { length: 260, width: 165, height: 67 } },
    };
    const dims = resolveMarketplaceDimensionsMm(product, 'ozon');
    expect(dims.source).toBe('ozon_draft.dimensions');
    expect(dims).toMatchObject({ length: 260, width: 165, height: 67 });
  });

  test('Ozon: linked ERP packaging when attrs/draft empty', () => {
    const product = {
      length: 400,
      width: 250,
      height: 150,
      mp_field_links: { dimensions: ['ozon'] },
    };
    const dims = resolveMarketplaceDimensionsMm(product, 'ozon');
    expect(dims.source).toBe('product_linked');
    expect(resolveMarketplaceVolumeLiters(product, 'ozon')).toBe(15);
  });

  test('Ozon: unlinked without draft — null (no ERP)', () => {
    const product = {
      length: 400,
      width: 250,
      height: 150,
      volume: 15,
      mp_field_links: { dimensions: [] },
    };
    expect(resolveMarketplaceDimensionsMm(product, 'ozon')).toBeNull();
    expect(resolveMarketplaceVolumeLiters(product, 'ozon')).toBeNull();
  });

  test('Ozon/WB: no ERP fallback when mp attrs empty', () => {
    const product = {
      length: 400,
      width: 250,
      height: 150,
      volume: 15,
      mp_field_links: { dimensions: [] },
    };
    expect(resolveMarketplaceDimensionsMm(product, 'ozon')).toBeNull();
    expect(resolveMarketplaceVolumeLiters(product, 'ozon')).toBeNull();
    expect(resolveMarketplaceDimensionsMm(product, 'wb')).toBeNull();
    expect(resolveMarketplaceVolumeLiters(product, 'wb')).toBeNull();
  });

  test('allowGeneralFallback opt-in restores ERP', () => {
    const product = { length: 400, width: 250, height: 150, mp_field_links: { dimensions: [] } };
    expect(resolveMarketplaceDimensionsMm(product, 'ozon', { allowGeneralFallback: true }).source).toBe(
      'product'
    );
    expect(resolveMarketplaceVolumeLiters(product, 'wb', { allowGeneralFallback: true })).toBe(15);
  });
});
