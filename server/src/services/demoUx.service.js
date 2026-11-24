/**
 * UX демо/онбординга: чеклист, подсказки, бейджи, разовое продление демо.
 */
import { query } from '../config/database.js';
import { DEMO_PLAN_CODE } from '../constants/subscriptionPlans.js';
import { resolveSubscription } from '../utils/profileSubscription.js';

export const CHECKLIST_STEPS = [
  {
    id: 'change_password',
    title: 'Сменить пароль',
    path: '/first-login-change-password',
    hint: 'При первом входе задайте свой пароль',
  },
  {
    id: 'view_product',
    title: 'Открыть демо-товар',
    path: '/products',
    hint: 'В каталоге есть DEMO-001 — посмотрите карточку',
  },
  {
    id: 'open_prices',
    title: 'Заглянуть в цены',
    path: '/prices',
    hint: 'Минимальные цены и стратегии по товару',
  },
  {
    id: 'connect_mp',
    title: 'Подключить маркетплейс',
    path: '/integrations',
    hint: 'API-ключи Ozon / WB / Яндекс Маркет',
  },
];

const BADGE_DEFS = {
  password_changed: { title: 'Свой пароль', description: 'Сменили временный пароль' },
  product_explorer: { title: 'Знакомство с товаром', description: 'Открыли демо-карточку' },
  price_curious: { title: 'Цены под контролем', description: 'Зашли в раздел цен' },
  mp_linked: { title: 'Связь с площадкой', description: 'Подключили кабинет МП' },
  checklist_done: { title: 'Старт пройден', description: 'Закрыли чеклист первого входа' },
};

function emptyProgress() {
  return {
    checklist: {},
    hintsDismissed: [],
    badges: {},
    demoExtendedAt: null,
    checklistDismissed: false,
  };
}

function parseProgress(raw) {
  const base = emptyProgress();
  if (!raw || typeof raw !== 'object') return base;
  return {
    checklist: raw.checklist && typeof raw.checklist === 'object' ? { ...raw.checklist } : {},
    hintsDismissed: Array.isArray(raw.hintsDismissed) ? [...raw.hintsDismissed] : [],
    badges: raw.badges && typeof raw.badges === 'object' ? { ...raw.badges } : {},
    demoExtendedAt: raw.demoExtendedAt || null,
    checklistDismissed: Boolean(raw.checklistDismissed),
  };
}

function unlockBadge(progress, id) {
  if (!BADGE_DEFS[id] || progress.badges[id]) return;
  progress.badges[id] = { at: new Date().toISOString(), ...BADGE_DEFS[id] };
}

async function countMpCabinets(profileId) {
  try {
    const r = await query(
      `SELECT COUNT(*)::int AS n FROM marketplace_cabinets WHERE profile_id = $1`,
      [profileId]
    );
    return Number(r.rows?.[0]?.n) || 0;
  } catch {
    try {
      const r = await query(
        `SELECT COUNT(*)::int AS n FROM integrations WHERE profile_id = $1 AND marketplace IS NOT NULL`,
        [profileId]
      );
      return Number(r.rows?.[0]?.n) || 0;
    } catch {
      return 0;
    }
  }
}

async function loadUserProgress(userId) {
  const r = await query(`SELECT ux_progress, must_change_password, profile_id FROM users WHERE id = $1`, [
    userId,
  ]);
  const row = r.rows?.[0];
  if (!row) return null;
  return {
    progress: parseProgress(row.ux_progress),
    mustChangePassword: !!(row.must_change_password === true || row.must_change_password === 1),
    profileId: row.profile_id != null ? Number(row.profile_id) : null,
  };
}

async function saveProgress(userId, progress) {
  await query(`UPDATE users SET ux_progress = $2::jsonb, updated_at = CURRENT_TIMESTAMP WHERE id = $1`, [
    userId,
    JSON.stringify(progress),
  ]);
}

function syncDerived(progress, { mustChangePassword, mpCount }) {
  if (!mustChangePassword) {
    progress.checklist.change_password = true;
    unlockBadge(progress, 'password_changed');
  }
  if (mpCount > 0) {
    progress.checklist.connect_mp = true;
    unlockBadge(progress, 'mp_linked');
  }
  if (progress.checklist.view_product) unlockBadge(progress, 'product_explorer');
  if (progress.checklist.open_prices) unlockBadge(progress, 'price_curious');
  const allDone = CHECKLIST_STEPS.every((s) => progress.checklist[s.id]);
  if (allDone) unlockBadge(progress, 'checklist_done');
  return progress;
}

export async function getUxState({ userId, profile }) {
  const loaded = await loadUserProgress(userId);
  if (!loaded) {
    const err = new Error('Пользователь не найден');
    err.statusCode = 404;
    throw err;
  }
  const mpCount = loaded.profileId ? await countMpCabinets(loaded.profileId) : 0;
  const before = JSON.stringify(loaded.progress);
  const progress = syncDerived(loaded.progress, {
    mustChangePassword: loaded.mustChangePassword,
    mpCount,
  });
  if (JSON.stringify(progress) !== before) await saveProgress(userId, progress);

  const sub = profile ? resolveSubscription(profile) : null;
  const isDemo = String(profile?.plan_code || profile?.planCode || '').toLowerCase() === DEMO_PLAN_CODE;
  const steps = CHECKLIST_STEPS.map((s) => ({
    ...s,
    done: Boolean(progress.checklist[s.id]),
  }));
  const doneCount = steps.filter((s) => s.done).length;

  return {
    isDemo,
    trialEndsAt: sub?.trialEndsAt || null,
    subscriptionStatus: sub?.status || null,
    planCode: sub?.planCode || profile?.plan_code || null,
    checklist: {
      dismissed: progress.checklistDismissed,
      doneCount,
      total: steps.length,
      complete: doneCount >= steps.length,
      steps,
    },
    hintsDismissed: progress.hintsDismissed,
    badges: Object.entries(progress.badges).map(([id, meta]) => ({ id, ...meta })),
    demoExtendedAt: progress.demoExtendedAt,
    canExtendDemo: isDemo && !progress.demoExtendedAt && sub?.status === 'trial',
  };
}

export async function patchUxProgress({ userId, profile, patch = {} }) {
  const loaded = await loadUserProgress(userId);
  if (!loaded) {
    const err = new Error('Пользователь не найден');
    err.statusCode = 404;
    throw err;
  }
  const progress = loaded.progress;
  const mpCount = loaded.profileId ? await countMpCabinets(loaded.profileId) : 0;

  if (patch.completeStep) {
    const id = String(patch.completeStep);
    if (CHECKLIST_STEPS.some((s) => s.id === id)) progress.checklist[id] = true;
  }
  if (Array.isArray(patch.completeSteps)) {
    for (const raw of patch.completeSteps) {
      const id = String(raw);
      if (CHECKLIST_STEPS.some((s) => s.id === id)) progress.checklist[id] = true;
    }
  }
  if (patch.dismissHint) {
    const key = String(patch.dismissHint);
    if (key && !progress.hintsDismissed.includes(key)) progress.hintsDismissed.push(key);
  }
  if (patch.checklistDismissed === true) progress.checklistDismissed = true;
  if (patch.checklistDismissed === false) progress.checklistDismissed = false;

  syncDerived(progress, {
    mustChangePassword: loaded.mustChangePassword,
    mpCount,
  });
  await saveProgress(userId, progress);
  return getUxState({ userId, profile });
}

/** Разово +3 дня к trial для демо-плана. */
export async function extendDemoTrial({ userId, profile }) {
  if (!profile?.id) {
    const err = new Error('Профиль не найден');
    err.statusCode = 400;
    throw err;
  }
  const planCode = String(profile.plan_code || profile.planCode || '').toLowerCase();
  if (planCode !== DEMO_PLAN_CODE) {
    const err = new Error('Продление доступно только для демо-кабинета');
    err.statusCode = 400;
    throw err;
  }
  const loaded = await loadUserProgress(userId);
  if (!loaded) {
    const err = new Error('Пользователь не найден');
    err.statusCode = 404;
    throw err;
  }
  if (loaded.progress.demoExtendedAt) {
    const err = new Error('Демо уже продлевали один раз');
    err.statusCode = 400;
    throw err;
  }
  const sub = resolveSubscription(profile);
  if (sub.status !== 'trial') {
    const err = new Error('Продление доступно только пока идёт демо');
    err.statusCode = 400;
    throw err;
  }

  const base = profile.trial_ends_at ? new Date(profile.trial_ends_at) : new Date();
  const from = Number.isFinite(base.getTime()) && base.getTime() > Date.now() ? base : new Date();
  from.setUTCDate(from.getUTCDate() + 3);
  const nextIso = from.toISOString();

  await query(
    `UPDATE profiles SET trial_ends_at = $2, updated_at = CURRENT_TIMESTAMP WHERE id = $1`,
    [profile.id, nextIso]
  );

  loaded.progress.demoExtendedAt = new Date().toISOString();
  await saveProgress(userId, loaded.progress);

  return {
    trialEndsAt: nextIso,
    extendedDays: 3,
    demoExtendedAt: loaded.progress.demoExtendedAt,
  };
}

export default {
  getUxState,
  patchUxProgress,
  extendDemoTrial,
  CHECKLIST_STEPS,
  BADGE_DEFS,
};
