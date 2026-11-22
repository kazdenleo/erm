import {
  isPlatformTelegramEventEnabled,
  parsePlatformTelegram,
  platformTelegramForClient,
  resolvePlatformTelegramSendTarget,
} from '../src/utils/platformTelegramSettings.js';

describe('platform telegram settings', () => {
  const prevToken = process.env.PLATFORM_TELEGRAM_BOT_TOKEN;
  const prevChats = process.env.PLATFORM_TELEGRAM_CHAT_IDS;

  afterEach(() => {
    if (prevToken == null) delete process.env.PLATFORM_TELEGRAM_BOT_TOKEN;
    else process.env.PLATFORM_TELEGRAM_BOT_TOKEN = prevToken;
    if (prevChats == null) delete process.env.PLATFORM_TELEGRAM_CHAT_IDS;
    else process.env.PLATFORM_TELEGRAM_CHAT_IDS = prevChats;
  });

  test('пустой токен не затирает сохранённый', () => {
    const next = parsePlatformTelegram(
      { enabled: true, botToken: '', chatIds: ['42'], events: { public_signup: true } },
      { enabled: false, botToken: '123:SECRET', chatIds: ['1'], events: { public_signup: false } }
    );
    expect(next.botToken).toBe('123:SECRET');
    expect(next.enabled).toBe(true);
    expect(next.chatIds).toEqual(['42']);
    expect(next.events.public_signup).toBe(true);
  });

  test('клиенту токен не отдаём', () => {
    const pub = platformTelegramForClient({
      enabled: true,
      botToken: '123456:SECRET',
      chatIds: ['42'],
      events: { public_signup: true },
    });
    expect(pub.hasBotToken).toBe(true);
    expect(pub.botToken).toBeUndefined();
    expect(pub.botTokenHint).toBe('…CRET');
  });

  test('событие public_signup включается только при enabled + token + chat', () => {
    delete process.env.PLATFORM_TELEGRAM_BOT_TOKEN;
    delete process.env.PLATFORM_TELEGRAM_CHAT_IDS;
    expect(
      isPlatformTelegramEventEnabled(
        { enabled: true, botToken: 't', chatIds: ['1'], events: { public_signup: true } },
        'public_signup'
      )
    ).toBe(true);
    expect(
      isPlatformTelegramEventEnabled(
        { enabled: false, botToken: 't', chatIds: ['1'], events: { public_signup: true } },
        'public_signup'
      )
    ).toBe(false);
  });

  test('env fallback, если в UI ещё нет токена', () => {
    process.env.PLATFORM_TELEGRAM_BOT_TOKEN = 'env-token';
    process.env.PLATFORM_TELEGRAM_CHAT_IDS = '99';
    expect(
      isPlatformTelegramEventEnabled({ enabled: false, botToken: '', chatIds: [], events: { public_signup: true } }, 'public_signup')
    ).toBe(true);
    const target = resolvePlatformTelegramSendTarget({
      enabled: false,
      botToken: '',
      chatIds: [],
      events: { public_signup: true },
    });
    expect(target.token).toBe('env-token');
    expect(target.chatIds).toEqual(['99']);
    expect(target.source).toBe('env');
  });
});
