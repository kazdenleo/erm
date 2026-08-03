/**
 * Ozon закрепляет габариты/вес после складского замера (SKU_VWC_IS_NOT_EDITABLE).
 * Флаг храним в products.ozon_draft.dimensionsLocked.
 */

export const OZON_VWC_LOCK_CODE = 'SKU_VWC_IS_NOT_EDITABLE';

function parseDraft(raw) {
  if (raw == null) return {};
  if (typeof raw === 'object' && !Array.isArray(raw)) return { ...raw };
  if (typeof raw === 'string') {
    try {
      const p = JSON.parse(raw);
      return p && typeof p === 'object' && !Array.isArray(p) ? { ...p } : {};
    } catch {
      return {};
    }
  }
  return {};
}

/** Текст/код ошибки указывает на закреплённые ОВХ. */
export function errorIndicatesOzonVwcLock(err) {
  if (err == null) return false;
  if (typeof err === 'string') {
    const s = err;
    return /SKU_VWC_IS_NOT_EDITABLE/i.test(s) || /изменить габариты и вес нельзя/i.test(s);
  }
  if (typeof err !== 'object') return false;
  const code = String(err.code || err.hint_code || err.error_code || '').trim();
  if (/SKU_VWC_IS_NOT_EDITABLE/i.test(code)) return true;
  const blob = [
    err.message,
    err.description,
    err.attribute_name,
    err.texts?.description,
    err.texts?.message,
    err.texts?.short_description,
  ]
    .filter((x) => x != null)
    .map((x) => String(x))
    .join(' ');
  return /SKU_VWC_IS_NOT_EDITABLE/i.test(blob) || /изменить габариты и вес нельзя/i.test(blob);
}

export function errorsIndicateOzonVwcLock(errors) {
  if (!Array.isArray(errors) || errors.length === 0) return false;
  return errors.some((e) => errorIndicatesOzonVwcLock(e));
}

/** Есть ли в ответе /v3/product/info/list признак закреплённых габаритов. */
export function detectOzonDimensionsLockedFromInfo(infoItem) {
  if (!infoItem || typeof infoItem !== 'object') return false;
  const raw = [];
  if (Array.isArray(infoItem.errors)) raw.push(...infoItem.errors);
  if (Array.isArray(infoItem.statuses)) {
    for (const st of infoItem.statuses) {
      if (Array.isArray(st?.errors)) raw.push(...st.errors);
      const msg = String(
        st?.message || st?.description || st?.status_description || st?.status_tooltip || ''
      ).trim();
      if (msg) raw.push(msg);
    }
  }
  return errorsIndicateOzonVwcLock(raw);
}

export function isOzonPackagingDimensionsLocked(formOrProduct) {
  const d = parseDraft(formOrProduct?.ozon_draft);
  return d.dimensionsLocked === true;
}

/**
 * @param {object|string|null} prevDraft
 * @param {boolean} locked
 * @returns {object}
 */
export function withOzonDraftDimensionsLock(prevDraft, locked) {
  const next = parseDraft(prevDraft);
  if (locked) {
    next.dimensionsLocked = true;
    next.dimensionsLockedAt = new Date().toISOString();
    next.dimensionsLockedCode = OZON_VWC_LOCK_CODE;
  } else {
    delete next.dimensionsLocked;
    delete next.dimensionsLockedAt;
    delete next.dimensionsLockedCode;
  }
  return next;
}
