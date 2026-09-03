import {
  computeOzonReturnUnitAmount,
  resolveOzonReturnUnitAmount,
} from '../src/utils/ozonReturnAmount.js';

describe('ozonReturnAmount', () => {
  test('average logistics min/max as return unit', () => {
    expect(computeOzonReturnUnitAmount(75, 269, 269)).toBe(172);
  });

  test('resolveOzonReturnUnitAmount uses calculator logistics min/max', () => {
    const calculator = { logistics_cost: 75, logistics_cost_max: 269 };
    const commission = { return_amount: 269, direct_flow_trans_amount_max: 269 };
    const amount = resolveOzonReturnUnitAmount(269, calculator, commission, 'FBS');
    expect(amount).toBe(172);
  });

  test('returns API amount when max logistics unknown', () => {
    const calculator = { logistics_cost: 75 };
    expect(resolveOzonReturnUnitAmount(269, calculator, {}, 'FBS')).toBe(269);
  });

  test('uses rawCommissions max when commission lacks max', () => {
    const calculator = {
      logistics_cost: 78,
      rawCommissions: { fbs_direct_flow_trans_min_amount: 78, fbs_direct_flow_trans_max_amount: 349 },
    };
    expect(resolveOzonReturnUnitAmount(349, calculator, { return_amount: 349 }, 'FBS')).toBe(213.5);
  });
});
