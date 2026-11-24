# Закрытая бета SaaS — чеклист

Общий multi-tenant на одном VPS. Публичная регистрация **выключена** (`PUBLIC_SIGNUP_ENABLED` не задан или `0`). Аккаунты создаёт админ в `/platform`.

## Этап 0 — до первых клиентов (на VPS)

### Env в `server/.env`

```bash
NODE_ENV=production
JWT_SECRET=<минимум 32 символа, уникальный>
SECRETS_ENCRYPTION_KEY=<64 hex или base64 на 32 байта>
# DISABLE_AUTH=1  — ЗАПРЕЩЕНО в production (сервер не стартует)

# Закрытая бета: не включать, пока не готовы isolation + бэкапы
# PUBLIC_SIGNUP_ENABLED=1

LEGAL_BRAND=MySell
LEGAL_COMPANY=ИП Иванов И.И.
LEGAL_INN=ИНН 123456789012
LEGAL_OGRN=ОГРНИП ...
LEGAL_ADDRESS=...
LEGAL_EMAIL=support@ваш-домен.ru
LEGAL_TELEGRAM=@...
LEGAL_DOMAIN=ваш-домен.ru
LEGAL_REVISED_AT=2026-11-20

YOOKASSA_SHOP_ID=...
YOOKASSA_SECRET_KEY=...
YOOKASSA_RETURN_URL=https://ваш-домен.ru/pricing

SMTP_HOST=...
SMTP_PORT=587
SMTP_USER=...
SMTP_PASS=...
MAIL_FROM="MySell <noreply@ваш-домен.ru>"

# Опционально после открытия signup:
# TURNSTILE_SITE_KEY=...
# TURNSTILE_SECRET_KEY=...
# SENTRY_DSN=https://...@sentry.io/...
```

### Проверки

- [ ] `/offer` и `/privacy` показывают **реальные** реквизиты (не «Название» / example.com)
- [ ] ЮKassa: тестовый платёж + webhook + чеки 54-ФЗ в кабинете ЮKassa
- [ ] SMTP: сброс пароля доходит
- [ ] Цены на `/pricing` согласованы (Start 1490 / Business 2490 / Pro 3990 ₽)
- [ ] Список 3–5 кандидатов в бету

## Этап 1 — hardening (в коде)

Сделано в репозитории:

- Auth на этикетки заказов / QR поставок / этикетки товаров (`?access_token=` для Print Helper)
- Fail-closed `profileId` у suppliers/warehouses; labels только со своим профилем
- `/uploads` публично только `products`, `rich-content`, `video-covers`; остальное — `/api/secure-uploads/...`
- `PUBLIC_SIGNUP_ENABLED` по умолчанию выкл.; чекбокс оферты + honeypot + Turnstile (если ключи заданы)
- Prod-guards: `JWT_SECRET`, `SECRETS_ENCRYPTION_KEY`, запрет `DISABLE_AUTH`
- Бэкап: `scripts/backup-vps.sh`
- Гейты тарифа: ads, ai, promoPulse, fbo, purchases, production
- Опциональный Sentry (`SENTRY_DSN`)

### Бэкапы на VPS

```bash
chmod +x /opt/erm/scripts/backup-vps.sh
# cron, например 03:15 каждый день:
# 15 3 * * * /opt/erm/scripts/backup-vps.sh >> /var/log/erm-backup.log 2>&1

# Off-box (рекомендуется):
# BACKUP_REMOTE_DIR=user@backup-host:/backups/erm
```

Один раз проверить restore: `gunzip -c db.sql.gz | psql ...` на копии БД.

## Этап 2 — закрытая бета

1. Создать аккаунт клиента в `/platform` (план, trial/active, лимиты).
2. Выдать логин/временный пароль (или сброс по email).
3. Прогон: онбординг → org + API keys → заказы/остатки → оплата (ЮKassa или ручная заявка).
4. Собрать баги изоляции / лимитов / онбординга.

**Выход из беты:** неделя без инцидентов утечки + 1–2 оплаченных аккаунта.

## Этап 3 — открытая продажа (позже)

1. Заполнить Turnstile (`TURNSTILE_*`).
2. `PUBLIC_SIGNUP_ENABLED=1` и перезапуск API.
3. Вернуть CTA «Создать аккаунт» на лендинге при необходимости.
4. Включить `SENTRY_DSN` и алерты по SMTP/ЮKassa.
5. При необходимости — автопродление подписки (сейчас нет recurring).

## Быстрая диагностика

| Проверка | Ожидание |
|---|---|
| `GET /api/config` | `publicSignupEnabled: false` в бете |
| `GET /api/orders/ЧУЖОЙ/label` без токена | 401 |
| `GET /uploads/certificates/...` | 404 JSON |
| `GET /uploads/products/...` | файл (для МП) |
| Ops в `/platform` | legalPlaceholder = false после LEGAL_* |
