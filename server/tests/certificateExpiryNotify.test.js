import {
  CERT_EXPIRY_WARN_DAYS,
  calendarDaysBetween,
  certificateExpiryPhaseLabel,
  certificateNotifyPeriodKey,
  daysUntilDate,
  shouldEmitCertificateExpiryNotification,
} from '../src/utils/certificateExpiryNotify.js';

describe('certificateExpiryNotify', () => {
  const now = new Date(2026, 5, 15); // 15.06.2026

  test('daysUntilDate counts calendar days', () => {
    expect(daysUntilDate('2026-06-15', now)).toBe(0);
    expect(daysUntilDate('2026-06-16', now)).toBe(1);
    expect(daysUntilDate('2026-06-14', now)).toBe(-1);
    expect(daysUntilDate('2026-12-12', now)).toBe(180);
  });

  test('outside 6 months — no notification', () => {
    expect(
      shouldEmitCertificateExpiryNotification({ daysLeft: CERT_EXPIRY_WARN_DAYS + 1, now })
    ).toBe(false);
  });

  test('first notify when entering 6-month window', () => {
    expect(
      shouldEmitCertificateExpiryNotification({ daysLeft: 180, lastNotifiedAt: null, now })
    ).toBe(true);
  });

  test('monthly cadence inside 6 months', () => {
    expect(
      shouldEmitCertificateExpiryNotification({
        daysLeft: 120,
        lastNotifiedAt: new Date(2026, 5, 1), // 14 days ago
        now,
      })
    ).toBe(false);
    expect(
      shouldEmitCertificateExpiryNotification({
        daysLeft: 120,
        lastNotifiedAt: new Date(2026, 4, 10), // 36 days ago
        now,
      })
    ).toBe(true);
  });

  test('last month — daily', () => {
    expect(
      shouldEmitCertificateExpiryNotification({
        daysLeft: 10,
        lastNotifiedAt: new Date(2026, 5, 15), // same day
        now,
      })
    ).toBe(false);
    expect(
      shouldEmitCertificateExpiryNotification({
        daysLeft: 10,
        lastNotifiedAt: new Date(2026, 5, 14),
        now,
      })
    ).toBe(true);
  });

  test('expired — daily', () => {
    expect(
      shouldEmitCertificateExpiryNotification({
        daysLeft: -3,
        lastNotifiedAt: new Date(2026, 5, 14),
        now,
      })
    ).toBe(true);
  });

  test('calendarDaysBetween and phase label', () => {
    expect(calendarDaysBetween(new Date(2026, 5, 10), now)).toBe(5);
    expect(certificateExpiryPhaseLabel(-1)).toBe('Истёк');
    expect(certificateExpiryPhaseLabel(5)).toMatch(/5 дн/);
    expect(certificateExpiryPhaseLabel(90)).toMatch(/мес/);
  });

  test('period key: daily in last month, monthly otherwise', () => {
    expect(certificateNotifyPeriodKey(10, now)).toBe('2026-06-15');
    expect(certificateNotifyPeriodKey(-1, now)).toBe('2026-06-15');
    expect(certificateNotifyPeriodKey(90, now)).toBe('2026-06');
    expect(certificateNotifyPeriodKey(CERT_EXPIRY_WARN_DAYS + 1, now)).toBeNull();
  });
});
