const { diffOrdersForTelegram, formatOrderEventMessages } = await import(
  '../src/services/telegramNotify.service.js'
);
const {
  mergeNotificationSettings,
  notificationSettingsForClient,
  parseNotificationSettings,
} = await import('../src/utils/notificationSettings.js');

const NOW = Date.parse('2026-10-26T12:00:00.000Z');
const hourAgo = new Date(NOW - 60 * 60 * 1000).toISOString();
const monthAgo = new Date(NOW - 30 * 24 * 60 * 60 * 1000).toISOString();

describe('telegram order diff', () => {
  test('свежий новый заказ попадает в уведомление, старый из истории — нет', () => {
    const diff = diffOrdersForTelegram(
      [
        {
          profileId: 6,
          marketplace: 'ozon',
          orderId: '0123-1',
          status: 'new',
          productName: 'Фильтр',
          quantity: 2,
          price: 450,
          createdAt: hourAgo,
        },
        {
          profileId: 6,
          marketplace: 'ozon',
          orderId: 'old-1',
          status: 'new',
          productName: 'Старый',
          quantity: 1,
          price: 10,
          createdAt: monthAgo,
        },
      ],
      [],
      { now: NOW, profileId: 6 }
    );
    expect(diff.new_order).toHaveLength(1);
    expect(diff.new_order[0].orderId).toBe('0123-1');
    expect(diff.new_order[0].lines[0].name).toBe('Фильтр');
    expect(diff.sale).toHaveLength(0);
  });

  test('несколько строк одного отправления склеиваются', () => {
    const diff = diffOrdersForTelegram(
      [
        {
          profileId: 1,
          marketplace: 'ozon',
          orderId: 'posting~1',
          status: 'new',
          productName: 'А',
          quantity: 1,
          price: 100,
          createdAt: hourAgo,
        },
        {
          profileId: 1,
          marketplace: 'ozon',
          orderId: 'posting~2',
          status: 'new',
          productName: 'Б',
          quantity: 1,
          price: 50,
          createdAt: hourAgo,
        },
      ],
      [],
      { now: NOW, profileId: 1 }
    );
    expect(diff.new_order).toHaveLength(1);
    expect(diff.new_order[0].orderId).toBe('posting');
    expect(diff.new_order[0].lines).toHaveLength(2);
  });

  test('переход в «Доставлен» — продажа, повторный синк молчит', () => {
    const row = {
      profileId: 6,
      marketplace: 'wildberries',
      orderId: '99',
      status: 'delivered',
      productName: 'Колодки <b>',
      quantity: 1,
      price: 1200,
      createdAt: monthAgo,
    };
    const first = diffOrdersForTelegram(
      [row],
      [{ profileId: 6, marketplace: 'wb', orderId: '99', status: 'shipped' }],
      { now: NOW, profileId: 6 }
    );
    expect(first.sale).toHaveLength(1);
    expect(first.new_order).toHaveLength(0);

    const second = diffOrdersForTelegram(
      [row],
      [{ profileId: 6, marketplace: 'wildberries', orderId: '99', status: 'delivered' }],
      { now: NOW, profileId: 6 }
    );
    expect(second.sale).toHaveLength(0);
    expect(second.order_cancelled).toHaveLength(0);
  });

  test('отмена уже известного заказа', () => {
    const diff = diffOrdersForTelegram(
      [
        {
          profileId: 6,
          marketplace: 'yandex',
          orderId: '55',
          status: 'cancelled',
          productName: 'Насос',
          quantity: 1,
          price: 300,
          createdAt: monthAgo,
        },
      ],
      [{ profileId: 6, marketplace: 'yandex', orderId: '55', status: 'new' }],
      { now: NOW, profileId: 6 }
    );
    expect(diff.order_cancelled).toHaveLength(1);
    expect(diff.new_order).toHaveLength(0);
  });

  test('текст экранирует название и считает сумму', () => {
    const [text] = formatOrderEventMessages('sale', [
      {
        marketplace: 'ozon',
        orderId: '1',
        lines: [{ name: 'Колодки <b>', quantity: 2, price: 100 }],
      },
    ]);
    expect(text).toContain('Продажа');
    expect(text).toContain('Колодки &lt;b&gt;');
    expect(text).toContain('200');
    expect(text).not.toContain('<b>Колодки');
  });
});

describe('telegram settings', () => {
  test('пустой токен при сохранении не затирает уже сохранённый', () => {
    const current = {
      channels: {},
      telegram: {
        enabled: true,
        botToken: '123456:SECRET',
        chatIds: ['42'],
        events: { new_order: true, sale: false },
      },
    };
    const next = mergeNotificationSettings(current, {
      telegram: {
        enabled: true,
        botToken: '',
        chatIds: ['42', '43'],
        events: { new_order: true, sale: true },
      },
    });
    expect(next.telegram.botToken).toBe('123456:SECRET');
    expect(next.telegram.chatIds).toEqual(['42', '43']);
    expect(next.telegram.events.sale).toBe(true);
    expect(next.telegram.events.order_cancelled).toBe(false);
  });

  test('в ответ клиенту токен не попадает', () => {
    const pub = notificationSettingsForClient({
      telegram: { enabled: true, botToken: '123456:SECRET', chatIds: ['42'], events: {} },
    });
    expect(pub.telegram.hasBotToken).toBe(true);
    expect(pub.telegram.botTokenHint).toBe('…CRET');
    expect(pub.telegram.botToken).toBeUndefined();
    const stored = parseNotificationSettings({
      telegram: { botToken: '123456:SECRET', chatIds: ['42'] },
    });
    expect(stored.telegram.botToken).toBe('123456:SECRET');
  });
});
