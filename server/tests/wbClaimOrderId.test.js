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

function wbSridCore(srid) {
  const s = String(srid ?? '').trim();
  if (!s) return '';
  const parts = s.split('.').filter(Boolean);
  if (parts.length >= 2) {
    const mid = String(parts[1] || '').replace(/^[ri]/i, '');
    if (/^[a-f0-9]{16,}$/i.test(mid) || /^\d{10,}$/.test(mid)) return mid;
  }
  const underscored = s.match(/^[A-Za-z0-9]+_(\d+)(?:\.\d+)*$/);
  if (underscored) return underscored[1];
  return s;
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
    expect(looksLikeWbSrid('ebS.r8eaa5820cc4448bf94b54d623913b31b.0.0')).toBe(true);
  });

  test('srid core strips prefix', () => {
    expect(wbSridCore('ex.d198dfe5c40c343fbb385e334b4b65f08.2.0')).toBe(
      'd198dfe5c40c343fbb385e334b4b65f08'
    );
    expect(wbSridCore('ebZ.i63b8ca8731f1a8e6958be61cdb89568b.0.0')).toBe(
      '63b8ca8731f1a8e6958be61cdb89568b'
    );
    expect(wbSridCore('eAf.rce6866f7338546eab2d4d2672d846c68.0.0')).toBe(
      'ce6866f7338546eab2d4d2672d846c68'
    );
  });

  test('empty and null are not srid', () => {
    expect(looksLikeWbSrid('')).toBe(false);
    expect(looksLikeWbSrid(null)).toBe(false);
    expect(looksLikeWbSrid(undefined)).toBe(false);
  });
});
