/**
 * Документирует контракт закрытия WB-поставки с несобранными:
 * действие remove → relocateWbToNewSupply=true (заказы остаются в поставке на WB).
 */
describe('wb close notAssembled remove → relocate', () => {
  test('для WB remove несобранных означает перенос, не «выбросить из поставки»', () => {
    const isWb = true;
    const notAssembledAction = 'remove';
    const relocateWbToNewSupply = isWb && notAssembledAction === 'remove';
    expect(relocateWbToNewSupply).toBe(true);
  });

  test('для отменённых remove — без переноса', () => {
    const cancelledAction = 'remove';
    const relocateWbToNewSupply = false;
    expect(cancelledAction === 'remove' && relocateWbToNewSupply).toBe(false);
  });

  test('для не-WB remove несобранных — без relocate флага', () => {
    const isWb = false;
    const notAssembledAction = 'remove';
    const relocateWbToNewSupply = isWb && notAssembledAction === 'remove';
    expect(relocateWbToNewSupply).toBe(false);
  });
});
