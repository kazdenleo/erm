/**
 * Нормализация телефона для входа и уникальности.
 * Российские номера: 8XXXXXXXXXX / 10 цифр → 7XXXXXXXXXX.
 */

export function phoneDigits(value) {
  return String(value || '').replace(/\D/g, '');
}

/**
 * Канонический номер: только цифры, 11–15 символов (для РФ — 7XXXXXXXXXX).
 * Пустая строка → null. Некорректный номер → { error }.
 */
export function normalizePhone(value) {
  const raw = value == null ? '' : String(value).trim();
  if (!raw) {
    return { value: null };
  }
  let digits = phoneDigits(raw);
  if (!digits) {
    return { error: 'Укажите корректный номер телефона' };
  }
  if (digits.length === 11 && digits.startsWith('8')) {
    digits = `7${digits.slice(1)}`;
  } else if (digits.length === 10) {
    digits = `7${digits}`;
  }
  if (digits.length < 11 || digits.length > 15) {
    return { error: 'Укажите корректный номер телефона' };
  }
  return { value: digits };
}

/** Телефон для хранения в профиле (с +). */
export function formatStoredPhone(normalized) {
  if (!normalized) return null;
  return `+${normalized}`;
}

export function looksLikeEmail(value) {
  return String(value || '').includes('@');
}

/**
 * Поля phone / phone_normalized для записи в БД.
 * @returns {{ phone: string|null, phone_normalized: string|null } | { error: string }}
 */
export function preparePhoneFields(value) {
  const parsed = normalizePhone(value);
  if (parsed.error) return parsed;
  if (!parsed.value) {
    return { phone: null, phone_normalized: null };
  }
  return {
    phone: formatStoredPhone(parsed.value),
    phone_normalized: parsed.value,
  };
}

export function requirePhoneFields(value) {
  const fields = preparePhoneFields(value);
  if (fields.error) return fields;
  if (!fields.phone_normalized) {
    return { error: 'Укажите номер телефона' };
  }
  return fields;
}

export async function ensurePhoneAvailable(usersRepo, phoneNormalized, excludeUserId = null) {
  if (!phoneNormalized) return;
  const existing = await usersRepo.findByNormalizedPhone(phoneNormalized);
  if (existing && (excludeUserId == null || Number(existing.id) !== Number(excludeUserId))) {
    const err = new Error('Пользователь с таким телефоном уже существует');
    err.status = 400;
    err.statusCode = 400;
    throw err;
  }
}
