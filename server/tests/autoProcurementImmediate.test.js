import {
  isSchedulerDbJobRunning,
  runSchedulerDbJob,
} from '../src/utils/schedulerDbMutex.js';
import { computeProcurementDeficit } from '../src/utils/orderProcurementCoverage.js';

describe('schedulerDbMutex coalesce/priority', () => {
  test('coalesce skips duplicate while job queued/running', async () => {
    let started = 0;
    let release;
    const gate = new Promise((resolve) => {
      release = resolve;
    });

    const first = runSchedulerDbJob(
      'test-coalesce',
      async () => {
        started += 1;
        await gate;
        return 'ok';
      },
      { coalesce: true }
    );

    // Give first tick to start
    await new Promise((r) => setTimeout(r, 20));
    expect(isSchedulerDbJobRunning()).toBe(true);

    const second = await runSchedulerDbJob(
      'test-coalesce',
      async () => {
        started += 1;
        return 'dup';
      },
      { coalesce: true }
    );
    expect(second).toEqual({ skipped: true, reason: 'coalesced' });

    release();
    await expect(first).resolves.toBe('ok');
    expect(started).toBe(1);
  });

  test('priority runs before later non-priority queued jobs', async () => {
    const order = [];
    let release;
    const gate = new Promise((resolve) => {
      release = resolve;
    });

    const blocker = runSchedulerDbJob('blocker', async () => {
      order.push('blocker-start');
      await gate;
      order.push('blocker-end');
    });

    await new Promise((r) => setTimeout(r, 20));

    const low = runSchedulerDbJob('low', async () => {
      order.push('low');
    });
    const high = runSchedulerDbJob(
      'high',
      async () => {
        order.push('high');
      },
      { priority: true }
    );

    release();
    await Promise.all([blocker, low, high]);
    expect(order).toEqual(['blocker-start', 'blocker-end', 'high', 'low']);
  });
});

describe('procurement deficit ignores incoming-only reserve', () => {
  test('on_hand covers, incoming alone does not', () => {
    expect(
      computeProcurementDeficit({
        quantityNeeded: 1,
        quantityReserved: 1, // on_hand
        quantityPurchased: 0,
      }).deficit
    ).toBe(0);

    // Если в автозакупке передаём только on_hand=0 — дефицит остаётся
    expect(
      computeProcurementDeficit({
        quantityNeeded: 1,
        quantityReserved: 0,
        quantityPurchased: 0,
      }).deficit
    ).toBe(1);
  });
});
