/**
 * Автовыдача демо-кабинета: профиль + админ + сид (орг, склад, товар) + письмо.
 * Без отдельных поддоменов — мультитенант в общем приложении.
 */
import crypto from 'crypto';
import bcrypt from 'bcrypt';
import config from '../config/index.js';
import { query, transaction } from '../config/database.js';
import { buildFullName, splitFullName } from '../utils/userName.js';
import { ensurePhoneAvailable, requirePhoneFields } from '../utils/userPhone.js';
import { ensureEmailAvailable, parseOptionalEmail } from '../utils/userEmail.js';
import { newAccountTrialFields } from '../utils/profileSubscription.js';
import { DEMO_PLAN_CODE, DEMO_TRIAL_DAYS } from '../constants/subscriptionPlans.js';
import { sendDemoAccessEmail } from './mail.service.js';
import logger from '../utils/logger.js';
import repositoryFactory from '../config/repository-factory.js';

function clientBaseUrl() {
  return String(config.clientUrl || process.env.CLIENT_URL || 'http://localhost:3000').replace(/\/+$/, '');
}

function generatePassword() {
  // Читаемый временный пароль без неоднозначных символов
  const raw = crypto.randomBytes(12).toString('base64url').replace(/[^a-zA-Z0-9]/g, '');
  return `D${raw.slice(0, 10)}!`;
}

function slugifyCompany(name) {
  const map = {
    а: 'a', б: 'b', в: 'v', г: 'g', д: 'd', е: 'e', ё: 'e', ж: 'zh', з: 'z', и: 'i', й: 'y',
    к: 'k', л: 'l', м: 'm', н: 'n', о: 'o', п: 'p', р: 'r', с: 's', т: 't', у: 'u', ф: 'f',
    х: 'h', ц: 'c', ч: 'ch', ш: 'sh', щ: 'sch', ъ: '', ы: 'y', ь: '', э: 'e', ю: 'yu', я: 'ya',
  };
  let s = String(name || '')
    .trim()
    .toLowerCase()
    .split('')
    .map((ch) => map[ch] ?? ch)
    .join('')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 32);
  return s || 'demo';
}

async function seedDemoCatalog({ profileId, accountName, client }) {
  const orgRes = await client.query(
    `INSERT INTO organizations (name, article_prefix, profile_id)
     VALUES ($1, $2, $3)
     RETURNING id`,
    [accountName, 'DEMO', profileId]
  );
  const organizationId = orgRes.rows[0].id;

  const whRes = await client.query(
    `INSERT INTO warehouses (type, name, address, organization_id, profile_id, is_fbo_stock)
     VALUES ('warehouse', $1, $2, $3, $4, false)
     RETURNING id`,
    ['Основной склад', 'Демо-склад', organizationId, profileId]
  );
  const warehouseId = whRes.rows[0].id;

  const productRes = await client.query(
    `INSERT INTO products (
       profile_id, sku, name, price, cost, additional_expenses, min_price,
       buyout_rate, weight, length, width, height, quantity, unit, description,
       product_type, organization_id
     ) VALUES (
       $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, 'product', $16
     )
     RETURNING id, sku, name`,
    [
      profileId,
      'DEMO-001',
      'Демо-товар: беспроводные наушники',
      2990,
      1200,
      80,
      50,
      95,
      0.25,
      18,
      10,
      6,
      25,
      'шт',
      'Пример карточки: себестоимость 1200 ₽ + доп. 80 ₽, витрина 2990 ₽. Откройте «Цены», чтобы увидеть пол и маржу. Остаток 25 шт на складе.',
      organizationId,
    ]
  );
  const product = productRes.rows[0];

  const product2Res = await client.query(
    `INSERT INTO products (
       profile_id, sku, name, price, cost, additional_expenses, min_price,
       buyout_rate, weight, length, width, height, quantity, unit, description,
       product_type, organization_id
     ) VALUES (
       $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, 'product', $16
     )
     RETURNING id, sku, name`,
    [
      profileId,
      'DEMO-002',
      'Демо-товар: чехол для наушников',
      590,
      120,
      20,
      50,
      90,
      0.05,
      12,
      8,
      3,
      80,
      'шт',
      'Второй пример — аксессуар с низкой себестоимостью. Сравните маржу с DEMO-001 в «Ценах».',
      organizationId,
    ]
  );
  const product2 = product2Res.rows[0];

  // Остатки по складу (products.quantity синхронизируется триггером)
  for (const row of [
    [product.id, 25],
    [product2.id, 80],
  ]) {
    try {
      await client.query(
        `INSERT INTO product_warehouse_stock (product_id, warehouse_id, quantity)
         VALUES ($1, $2, $3)
         ON CONFLICT (product_id, warehouse_id) DO UPDATE SET quantity = EXCLUDED.quantity`,
        [row[0], warehouseId, row[1]]
      );
    } catch {
      /* таблица может отсутствовать на старых стендах */
    }
  }

  // Черновые цены на МП — чтобы раздел «Цены» не был пустым
  const priceRows = [
    [product.id, 1890, 2990],
    [product2.id, 290, 590],
  ];
  for (const [pid, minP, sellP] of priceRows) {
    for (const mp of ['ozon', 'wb', 'ym']) {
      try {
        await client.query(
          `INSERT INTO product_marketplace_prices (product_id, marketplace, min_price, selling_price)
           VALUES ($1, $2, $3, $4)
           ON CONFLICT (product_id, marketplace) DO UPDATE
             SET min_price = EXCLUDED.min_price,
                 selling_price = EXCLUDED.selling_price,
                 updated_at = CURRENT_TIMESTAMP`,
          [pid, mp, minP, sellP]
        );
      } catch {
        /* схема может отличаться — сид товара уже полезен */
      }
    }
  }

  return { organizationId, warehouseId, product, product2 };
}

/**
 * @param {{
 *   companyName: string,
 *   fullName: string,
 *   email: string,
 *   phone: string,
 *   acceptOffer: boolean,
 *   turnstileToken?: string,
 *   website?: string,
 *   ip?: string,
 * }} input
 */
export async function provisionDemoAccess(input = {}) {
  if (config.auth?.demoRequestEnabled === false) {
    const err = new Error('Заявки на демо временно закрыты');
    err.statusCode = 403;
    err.code = 'DEMO_DISABLED';
    throw err;
  }
  if (!config.database.usePostgreSQL) {
    const err = new Error('Демо доступно только при PostgreSQL');
    err.statusCode = 503;
    throw err;
  }

  if (input.website != null && String(input.website).trim() !== '') {
    const err = new Error('Некорректный запрос');
    err.statusCode = 400;
    throw err;
  }

  const offerOk =
    input.acceptOffer === true ||
    input.acceptOffer === 1 ||
    String(input.acceptOffer).toLowerCase() === 'true' ||
    String(input.acceptOffer) === '1';
  if (!offerOk) {
    const err = new Error('Нужно принять оферту и политику конфиденциальности');
    err.statusCode = 400;
    throw err;
  }

  const turnstileSecret = config.auth?.turnstileSecretKey || '';
  if (turnstileSecret) {
    const token = String(input.turnstileToken || '').trim();
    if (!token) {
      const err = new Error('Пройдите проверку «я не робот»');
      err.statusCode = 400;
      throw err;
    }
    const form = new URLSearchParams();
    form.set('secret', turnstileSecret);
    form.set('response', token);
    if (input.ip) form.set('remoteip', String(input.ip).split(',')[0].trim());
    const tr = await fetch('https://challenges.cloudflare.com/turnstile/v0/siteverify', {
      method: 'POST',
      body: form,
    });
    const tj = await tr.json().catch(() => ({}));
    if (!tj?.success) {
      const err = new Error('Проверка «я не робот» не пройдена');
      err.statusCode = 400;
      throw err;
    }
  }

  const company = String(input.companyName || '').trim();
  const fn = String(input.fullName || '').trim();
  if (company.length < 2) {
    const err = new Error('Укажите название компании');
    err.statusCode = 400;
    throw err;
  }
  if (fn.length < 2) {
    const err = new Error('Укажите ФИО');
    err.statusCode = 400;
    throw err;
  }

  const emailParsed = parseOptionalEmail(input.email);
  if (emailParsed.error || !emailParsed.value) {
    const err = new Error(emailParsed.error || 'Укажите email — на него придут доступ и инструкция');
    err.statusCode = 400;
    throw err;
  }
  const phoneFields = requirePhoneFields(input.phone);
  if (phoneFields.error) {
    const err = new Error(phoneFields.error);
    err.statusCode = 400;
    throw err;
  }

  const usersRepo = repositoryFactory.getUsersRepository();
  try {
    await ensurePhoneAvailable(usersRepo, phoneFields.phone_normalized);
    await ensureEmailAvailable(usersRepo, emailParsed.value);
  } catch (e) {
    const err = new Error(e.message || 'Пользователь уже зарегистрирован');
    err.statusCode = 400;
    throw err;
  }

  const plainPassword = generatePassword();
  const passwordHash = await bcrypt.hash(plainPassword, 10);
  const names = splitFullName(fn);
  const trialDays = Number(config.auth?.demoTrialDays) || DEMO_TRIAL_DAYS;
  const trial = newAccountTrialFields({ days: trialDays, planCode: DEMO_PLAN_CODE });
  const accountName = company.slice(0, 120);
  const loginUrl = `${clientBaseUrl()}/login`;

  let created;
  try {
    created = await transaction(async (client) => {
      const pr = await client.query(
        `INSERT INTO profiles (
           name, contact_full_name, contact_email, contact_phone, tariff,
           subscription_status, plan_code, trial_ends_at, subscription_ends_at,
           kits_enabled, production_enabled, fbo_enabled, pricing_strategies_enabled,
           onboarding_completed_at
         )
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, CURRENT_TIMESTAMP)
         RETURNING id`,
        [
          accountName,
          fn,
          emailParsed.value,
          phoneFields.phone,
          trial.tariff,
          trial.subscription_status,
          trial.plan_code,
          trial.trial_ends_at,
          trial.subscription_ends_at,
          trial.kits_enabled,
          trial.production_enabled,
          trial.fbo_enabled,
          trial.pricing_strategies_enabled,
        ]
      );
      const profileId = pr.rows[0].id;

      const ur = await client.query(
        `INSERT INTO users (
           email, password_hash, full_name, last_name, first_name, middle_name,
           phone, phone_normalized, role, profile_id, is_profile_admin, must_change_password
         )
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, 'user', $9, true, true)
         RETURNING id`,
        [
          emailParsed.value,
          passwordHash,
          buildFullName(names),
          names.lastName,
          names.firstName,
          names.middleName,
          phoneFields.phone,
          phoneFields.phone_normalized,
          profileId,
        ]
      );

      const seed = await seedDemoCatalog({ profileId, accountName, client });
      return {
        profileId,
        userId: ur.rows[0].id,
        seed,
        slug: slugifyCompany(company),
      };
    });
  } catch (e) {
    if (e.code === '23505') {
      const detail = String(e.detail || e.constraint || '');
      const err = new Error(
        /phone/i.test(detail)
          ? 'Пользователь с таким телефоном уже зарегистрирован'
          : 'Пользователь с таким email уже зарегистрирован'
      );
      err.statusCode = 400;
      throw err;
    }
    throw e;
  }

  const mailResult = await sendDemoAccessEmail({
    to: emailParsed.value,
    fullName: fn,
    accountName,
    password: plainPassword,
    phone: phoneFields.phone,
    loginUrl,
    trialDays,
    maxProducts: 50,
    sampleSku: created.seed?.product?.sku || 'DEMO-001',
  });

  setImmediate(() => {
    import('./telegramNotify.service.js')
      .then((mod) =>
        mod.notifyPlatformPublicSignup?.({
          accountName: `[демо] ${accountName}`,
          fullName: fn,
          phone: phoneFields.phone,
          email: emailParsed.value,
          profileId: created.profileId,
        })
      )
      .catch((err) => logger.warn?.('[Telegram] demo notify:', err?.message || err));
  });

  return {
    profileId: created.profileId,
    accountName,
    email: emailParsed.value,
    phone: phoneFields.phone,
    loginUrl,
    trialDays,
    trialEndsAt: trial.trial_ends_at,
    maxProducts: 50,
    sampleSku: created.seed?.product?.sku || 'DEMO-001',
    mailSent: Boolean(mailResult?.sent),
    /** Пароль только в ответе API (если SMTP выключен) — для показа на экране успеха */
    temporaryPassword: mailResult?.sent ? undefined : plainPassword,
    mustChangePassword: true,
    slug: created.slug,
  };
}

export default { provisionDemoAccess };
