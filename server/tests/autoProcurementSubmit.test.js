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
