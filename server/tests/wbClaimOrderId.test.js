/**
 * Резолв номера заказа WB из srid в заявках на возврат.
 * Хелперы не экспортируются — проверяем поведение через публичный map-паттерн
 * (looksLikeWbSrid) дублируя правило здесь синхронно с сервисом.
 */

function looksLikeWbSrid(value) {
  const s = String(value ?? '').trim();
  if (!s) return false;
  if (/^\d+$/.test(s)) return false;
  return /[._]/.test(s);
}

describe('WB claim order id (srid vs assembly)', () => {
  test('assembly id is not treated as srid', () => {
    expect(looksLikeWbSrid('608731836')).toBe(false);
    expect(looksLikeWbSrid('1234567890')).toBe(false);
  });

  test('claim srid formats are detected', () => {
    expect(looksLikeWbSrid('ex.d198dfe5c40c343fbb385e334b4b65f08.2.0')).toBe(true);
    expect(looksLikeWbSrid('obr.d3ed5f125263d41818a847efda84b2ddd8.0.0')).toBe(true);
    expect(looksLikeWbSrid('v5o_7143225816503318733.0.0')).toBe(true);
  });

  test('empty and null are not srid', () => {
    expect(looksLikeWbSrid('')).toBe(false);
    expect(looksLikeWbSrid(null)).toBe(false);
    expect(looksLikeWbSrid(undefined)).toBe(false);
  });
});
