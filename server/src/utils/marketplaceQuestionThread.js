/**
 * Ветка сообщений вопроса (покупатель / продавец) из сырых данных API и строки БД.
 */

function parseIso(v) {
  if (v == null || v === '') return null;
  const d = new Date(v);
  return Number.isNaN(d.getTime()) ? null : d.toISOString();
}

/** USER / CUSTOMER / BUYER → buyer; BUSINESS / SHOP / PARTNER → seller */
export function inferYandexAnswerAuthor(answer) {
  const t = String(
    answer?.author?.type ?? answer?.authorType ?? answer?.author_type ?? answer?.source ?? ''
  ).toUpperCase();
  if (t.includes('USER') || t.includes('CUSTOMER') || t.includes('BUYER')) return 'buyer';
  if (t.includes('BUSINESS') || t.includes('SHOP') || t.includes('PARTNER')) return 'seller';
  return 'seller';
}

export function sortYandexAnswers(answers) {
  return [...(answers || [])].sort((a, b) => {
    const ta = parseIso(a?.createdAt ?? a?.created_at) || '';
    const tb = parseIso(b?.createdAt ?? b?.created_at) || '';
    if (ta !== tb) return ta.localeCompare(tb);
    return (Number(a?.id) || 0) - (Number(b?.id) || 0);
  });
}

/**
 * @param {object} opts
 * @param {string} opts.marketplace — ozon | wildberries | yandex
 * @param {object|null} opts.rawPayload — camelCase/snake_case как в API
 * @param {string} opts.body — текст вопроса из колонки body
 * @param {string|null} opts.answerText — последний ответ продавца из колонки (для WB fallback)
 * @param {string|null} opts.sourceCreatedAt
 * @returns {Array<{ role: 'buyer'|'seller', text: string, at: string|null, externalId?: string|null }>}
 */
export function buildThreadMessagesFromRow(opts) {
  const mp = String(opts.marketplace || '').toLowerCase();
  const raw = opts.rawPayload && typeof opts.rawPayload === 'object' ? opts.rawPayload : {};
  const body = String(opts.body ?? '').trim() || '—';
  const answerText =
    opts.answerText != null && String(opts.answerText).trim() !== '' ? String(opts.answerText).trim() : null;
  const qAt = parseIso(opts.sourceCreatedAt ?? raw.createdAt ?? raw.created_at);

  if (mp === 'yandex') {
    const out = [];
    const qText = String(raw.text ?? body).trim() || '—';
    out.push({ role: 'buyer', text: qText, at: parseIso(raw.createdAt ?? raw.created_at) ?? qAt, externalId: null });
    const answers = sortYandexAnswers(raw.answers);
    for (const a of answers) {
      const txt = String(a.text ?? a.body ?? '').trim();
      if (!txt) continue;
      const role = inferYandexAnswerAuthor(a);
      const at = parseIso(a.createdAt ?? a.created_at);
      const ext = a.id != null ? String(a.id) : null;
      const dup = out.some((m) => m.text === txt && m.role === role && m.at === at);
      if (!dup) out.push({ role, text: txt, at: at ?? null, externalId: ext });
    }
    return out;
  }

  if (mp === 'wildberries' || mp === 'wb') {
    const out = [{ role: 'buyer', text: body, at: qAt, externalId: null }];
    const ans = raw.answer ?? {};
    const at = parseIso(ans.createdDate ?? ans.created_at ?? raw.answerDate);
    const t = String(ans.text ?? ans.message ?? answerText ?? '').trim();
    if (t) out.push({ role: 'seller', text: t, at: at ?? null, externalId: null });
    else if (answerText) out.push({ role: 'seller', text: answerText, at: null, externalId: null });
    return out;
  }

  /* ozon */
  const out = [{ role: 'buyer', text: body, at: qAt, externalId: null }];
  const answers = Array.isArray(raw.answers) ? raw.answers : [];
  if (answers.length === 0 && answerText) {
    out.push({ role: 'seller', text: answerText, at: null, externalId: null });
    return out;
  }
  for (const a of answers) {
    const txt = String(a.text ?? a.message ?? a.answer_text ?? '').trim();
    if (!txt) continue;
    const authorType = String(a.author?.type ?? a.author_type ?? '').toUpperCase();
    const role =
      authorType.includes('CUSTOMER') || authorType.includes('USER') || authorType.includes('BUYER')
        ? 'buyer'
        : 'seller';
    const at = parseIso(a.created_at ?? a.createdAt ?? a.date);
    const ext = a.id != null ? String(a.id) : null;
    out.push({ role, text: txt, at: at ?? null, externalId: ext });
  }
  return out;
}

/**
 * Последнее сообщение в ветке — от покупателя (нужен новый CREATE ответа на Яндексе).
 * @param {Array<{ role: string }>} thread
 */
/** Последний ответ продавца в raw.answers (для UPDATE в API Яндекса). */
export function getYandexLastSellerAnswerId(raw) {
  const sorted = sortYandexAnswers(raw?.answers);
  for (let i = sorted.length - 1; i >= 0; i--) {
    if (inferYandexAnswerAuthor(sorted[i]) === 'seller' && sorted[i].id != null) {
      const n = Number(sorted[i].id);
      if (Number.isFinite(n) && n >= 1) return n;
    }
  }
  return null;
}

export function threadLastMessageIsBuyer(thread) {
  if (!Array.isArray(thread) || thread.length === 0) return true;
  return String(thread[thread.length - 1]?.role || '') === 'buyer';
}
