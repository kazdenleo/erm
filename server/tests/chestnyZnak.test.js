import {
  buildTrueApiBaseUrl,
  cisStatusLabel,
  extractGtinFromCis,
  isTokenPlaceholder,
  mapCisInfoResponse,
  normalizeCis,
  parseJwtPayload,
  splitCisList,
  toPublicChestnyZnakConfig,
  tokenExpiryIso,
  TRUE_API_PROD_V3,
  TRUE_API_PROD_V4,
  TRUE_API_SANDBOX_V3,
} from '../src/utils/chestnyZnak.js';

describe('chestnyZnak utils', () => {
  test('strips GS / FNC1 from CIS', () => {
    expect(normalizeCis('01\u001d04601234567890\u001d21ABC')).toBe('010460123456789021ABC');
    expect(normalizeCis('  010460123456789021ABC  ')).toBe('010460123456789021ABC');
  });

  test('splits and dedupes CIS list', () => {
    const list = splitCisList('010460123456789021AAA\n010460123456789021AAA\n010460123456789021BBB');
    expect(list).toEqual(['010460123456789021AAA', '010460123456789021BBB']);
  });

  test('extracts GTIN-14 from AI 01', () => {
    expect(extractGtinFromCis('010460123456789021SERIAL')).toBe('04601234567890');
    expect(extractGtinFromCis('not-a-cis')).toBeNull();
  });

  test('maps CIS status labels', () => {
    expect(cisStatusLabel('INTRODUCED')).toBe('В обороте');
    expect(cisStatusLabel('unknown')).toBe('unknown');
  });

  test('maps True API cises/info payload', () => {
    const items = mapCisInfoResponse([
      {
        cis: '010460123456789021AAA',
        cisInfo: { status: 'INTRODUCED', gtin: '04601234567890', ownerInn: '7700000000' },
        errorCode: '0',
      },
      { cis: 'bad', errorCode: '22', errorMessage: 'Не найден' },
    ]);
    expect(items[0].ok).toBe(true);
    expect(items[0].status_label).toBe('В обороте');
    expect(items[0].owner_inn).toBe('7700000000');
    expect(items[1].ok).toBe(false);
    expect(items[1].error_message).toBe('Не найден');
  });

  test('builds True API base URL', () => {
    expect(buildTrueApiBaseUrl({})).toBe(TRUE_API_PROD_V3);
    expect(buildTrueApiBaseUrl({ api_version: 'v4' })).toBe(TRUE_API_PROD_V4);
    expect(buildTrueApiBaseUrl({ sandbox: true })).toBe(TRUE_API_SANDBOX_V3);
    expect(buildTrueApiBaseUrl({ api_url: 'https://example.test/api/' })).toBe('https://example.test/api');
  });

  test('masks token in public config and keeps expiry', () => {
    const exp = Math.floor(Date.now() / 1000) + 3600;
    const payload = Buffer.from(JSON.stringify({ exp, inn: '7700000000' })).toString('base64url');
    const token = `eyJhbGciOiJub25lIn0.${payload}.sig`;
    const pub = toPublicChestnyZnakConfig({
      token,
      sandbox: true,
      product_groups: ['tires'],
    });
    expect(pub.token).toBeUndefined();
    expect(pub.token_set).toBe(true);
    expect(pub.token_preview).toMatch(/^••••/);
    expect(pub.sandbox).toBe(true);
    expect(pub.product_groups).toEqual(['tires']);
    expect(tokenExpiryIso(token)).toBe(new Date(exp * 1000).toISOString());
    expect(parseJwtPayload(token).inn).toBe('7700000000');
  });

  test('treats masked token as placeholder so save does not wipe the real one', () => {
    expect(isTokenPlaceholder('')).toBe(true);
    expect(isTokenPlaceholder('••••ab12')).toBe(true);
    expect(isTokenPlaceholder('eyJhbGciOiJub25lIn0.payload.sig')).toBe(false);
  });
});
