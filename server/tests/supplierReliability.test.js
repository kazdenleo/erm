/**
 * Надёжность поставщика: score, штраф к цене, классификация submit.
 */

import {
  reliabilityScoreFromCounts,
  effectiveProcurementPrice,
  reliabilityEventTypeFromSubmit,
  countsFromReliabilityEvents,
  DEFAULT_RELIABILITY_SCORE,
  DEFAULT_RELIABILITY_PENALTY_RUB,
} from '../src/utils/supplierReliability.js';
import { sortSupplierCandidatesByProcurementRules } from '../src/utils/supplierCandidateSort.js';

describe('supplierReliability', () => {
  test('нет событий → дефолтный score', () => {
    expect(reliabilityScoreFromCounts({})).toBe(DEFAULT_RELIABILITY_SCORE);
    expect(reliabilityScoreFromCounts({ rejects: 0, oks: 0 })).toBe(DEFAULT_RELIABILITY_SCORE);
  });

  test('только отказы → низкий score', () => {
    expect(reliabilityScoreFromCounts({ rejects: 10, oks: 0 })).toBe(0.3);
  });

  test('только успехи → 1', () => {
    expect(reliabilityScoreFromCounts({ rejects: 0, oks: 5 })).toBe(1);
  });

  test('countsFromReliabilityEvents суммирует типы', () => {
    expect(
      countsFromReliabilityEvents([
        { event_type: 'submit_ok' },
        { event_type: 'submit_reject' },
        { event_type: 'submit_partial' },
        { event_type: 'late_delivery' },
        { event_type: 'on_time_delivery' },
      ])
    ).toEqual({ rejects: 2, oks: 1, late: 1, onTime: 1 });
  });

  test('effectiveProcurementPrice добавляет штраф при низкой надёжности', () => {
    expect(effectiveProcurementPrice(1000, 1)).toBe(1000);
    expect(effectiveProcurementPrice(1000, 0)).toBe(1000 + DEFAULT_RELIABILITY_PENALTY_RUB);
    expect(effectiveProcurementPrice(1000, 0.5)).toBe(1000 + DEFAULT_RELIABILITY_PENALTY_RUB * 0.5);
  });

  test('reliabilityEventTypeFromSubmit', () => {
    expect(reliabilityEventTypeFromSubmit({ skipped: true })).toBeNull();
    expect(reliabilityEventTypeFromSubmit({ reason: 'already_submitted' })).toBeNull();
    expect(reliabilityEventTypeFromSubmit({ ambiguousSuccess: true })).toBeNull();
    expect(reliabilityEventTypeFromSubmit({ submitted: true })).toBe('submit_ok');
    expect(
      reliabilityEventTypeFromSubmit({
        submitted: true,
        partial: true,
        failedLines: [{ productId: 1 }],
      })
    ).toBe('submit_partial');
    expect(
      reliabilityEventTypeFromSubmit({
        submitted: false,
        reason: 'basket_rejected',
      })
    ).toBe('submit_reject');
  });

  test('sort предпочитает чуть более дорогого надёжного дешёвому с отказами', () => {
    const now = new Date('2026-10-29T10:00:00+03:00');
    const ranked = sortSupplierCandidatesByProcurementRules(
      [
        {
          price: 1000,
          deliveryDays: 1,
          stock: 10,
          reliability: 0.2,
          code: 'cheap',
          apiConfig: {},
        },
        {
          price: 1050,
          deliveryDays: 1,
          stock: 10,
          reliability: 1,
          code: 'stable',
          apiConfig: {},
        },
      ],
      { now }
    );
    expect(ranked[0].code).toBe('stable');
  });
});
