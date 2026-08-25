import { formatWbCertDate } from '../src/utils/wbCertDate.js';

describe('WB certificate dates', () => {
  test('formats ISO as DD.MM.YYYY and ignores truncated day numbers', () => {
    expect(formatWbCertDate('2025-11-03')).toBe('03.11.2025');
    expect(formatWbCertDate('2029-11-02T00:00:00.000Z')).toBe('02.11.2029');
    expect(formatWbCertDate('3.11.2025')).toBe('03.11.2025');
    expect(formatWbCertDate(3)).toBe('');
    expect(formatWbCertDate(2)).toBe('');
  });
});
