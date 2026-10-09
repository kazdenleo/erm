import { jest } from '@jest/globals';

let store = [];
jest.unstable_mockModule('../src/utils/storage.js', () => ({
  readData: async () => store,
  writeData: async (_key, value) => {
    store = value;
  },
}));

const { addRuntimeNotification, resolveRuntimeNotificationsForOrders } = await import(
  '../src/utils/runtime-notifications.js'
);

const failed = (orderIds, extra = {}) => ({
  type: 'supplier_order_submit_failed',
  severity: 'error',
  title: 'Заказы не отправлены поставщику',
  message: 'Mikado: Неопознанная ошибка.',
  profileId: 6,
  dedupeKey: `supplier_order_submit_failed|Mikado|${orderIds.join(',')}`,
  meta: { order_ids: orderIds },
  ...extra,
});

describe('runtime notifications dedupe', () => {
  beforeEach(() => {
    store = [];
  });

  test('повтор с тем же dedupeKey обновляет одно уведомление', async () => {
    const first = await addRuntimeNotification(failed(['5989593374']));
    await addRuntimeNotification(failed(['5989593374']));
    const third = await addRuntimeNotification(failed(['5989593374']));
    expect(store).toHaveLength(1);
    expect(third.id).toBe(first.id);
    expect(third.repeat_count).toBe(3);
    expect(third.first_created_at).toBe(first.created_at);
  });

  test('разные заказы и аккаунты не склеиваются', async () => {
    await addRuntimeNotification(failed(['1']));
    await addRuntimeNotification(failed(['2']));
    await addRuntimeNotification(failed(['1'], { profileId: 7 }));
    expect(store).toHaveLength(3);
  });

  test('без dedupeKey — как раньше, каждое отдельно', async () => {
    await addRuntimeNotification({ ...failed(['1']), dedupeKey: undefined });
    await addRuntimeNotification({ ...failed(['1']), dedupeKey: undefined });
    expect(store).toHaveLength(2);
  });

  test('успешная отправка снимает уведомления только по полностью отправленным заказам', async () => {
    await addRuntimeNotification(failed(['1']));
    await addRuntimeNotification(failed(['1', '2']));
    await addRuntimeNotification(failed(['1'], { profileId: 7 }));
    const res = await resolveRuntimeNotificationsForOrders({
      type: 'supplier_order_submit_failed',
      profileId: 6,
      orderIds: ['1'],
    });
    expect(res.removed).toBe(1);
    expect(store.map((n) => [n.profile_id, n.meta.order_ids.join(',')])).toEqual([
      [7, '1'],
      [6, '1,2'],
    ]);
  });
});
