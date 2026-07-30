/**
 * Контракт: при обязательной отправке API отказ поставщика = откат локальной закупки.
 */

describe('supplier submit rollback contract', () => {
  function needsRollback(supplierSubmit, apiSubmitRequired) {
    if (!apiSubmitRequired) return false;
    if (!supplierSubmit || supplierSubmit.skipped) return false;
    if (supplierSubmit.reason === 'already_submitted') return false;
    if (supplierSubmit.submitted === true && !supplierSubmit.partial) return false;
    if (supplierSubmit.submitted !== true) return true;
    return Boolean(supplierSubmit.partial && Array.isArray(supplierSubmit.failedLines));
  }

  test('full reject from any supplier triggers rollback', () => {
    expect(
      needsRollback(
        {
          submitted: false,
          reason: 'basket_rejected',
          message: 'Блокировка покупки у поставщика',
        },
        true
      )
    ).toBe(true);
    expect(
      needsRollback(
        {
          submitted: false,
          reason: 'submit_error',
          message: 'Moskvorechie HTTP 500',
        },
        true
      )
    ).toBe(true);
  });

  test('success does not rollback', () => {
    expect(needsRollback({ submitted: true, message: 'ok' }, true)).toBe(false);
  });

  test('skipped (API not required path) does not rollback', () => {
    expect(
      needsRollback({ submitted: false, skipped: true, reason: 'submit_disabled' }, true)
    ).toBe(false);
  });

  test('without API requirement never rollbacks', () => {
    expect(needsRollback({ submitted: false, reason: 'all_failed' }, false)).toBe(false);
  });

  test('partial with failedLines triggers rollback of failed', () => {
    expect(
      needsRollback(
        {
          submitted: true,
          partial: true,
          failedLines: [{ productId: 1, reason: 'basket_rejected' }],
        },
        true
      )
    ).toBe(true);
  });
});
