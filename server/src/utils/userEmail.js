const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export function parseOptionalEmail(value) {
  const em = String(value || '').trim().toLowerCase();
  if (!em) return { value: null };
  if (!EMAIL_RE.test(em)) {
    return { error: 'Укажите корректный email' };
  }
  return { value: em };
}

export async function ensureEmailAvailable(usersRepo, email, excludeUserId = null) {
  if (!email) return;
  const existing = await usersRepo.findByEmail(email);
  if (existing && (excludeUserId == null || Number(existing.id) !== Number(excludeUserId))) {
    const err = new Error('Пользователь с таким email уже существует');
    err.status = 400;
    err.statusCode = 400;
    throw err;
  }
}
