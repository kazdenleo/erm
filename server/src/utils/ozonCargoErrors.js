/**
 * Человекочитаемые ошибки Ozon FBO cargoes/create и cargoes-label.
 */

const OZON_CARGO_ERROR_REASON_RU = {
  WAREHOUSE_LIMITS_EXCEED:
    'Превышен лимит грузомест на складе Ozon для этой поставки. Удалите лишние короба в кабинете Ozon или нажмите «Подтянуть из Ozon», если короба уже созданы.',
  SUPPLY_IS_NOT_EDITABLE:
    'Поставку в Ozon уже нельзя менять — грузоместа создавайте в личном кабинете.',
  CARGO_ALREADY_EXISTS: 'Такое грузоместо уже есть в Ozon.',
};

/** Разобрать errors из cargoes/create/info или cargoes-label/get. */
export function formatOzonCargoErrorReasons(errors) {
  if (errors == null) return null;
  if (typeof errors === 'string' && errors.trim()) return errors.trim();
  if (errors?.message) return String(errors.message);
  const reasons = errors?.error_reasons ?? errors?.errorReasons;
  if (Array.isArray(reasons) && reasons.length) {
    return reasons
      .map((code) => {
        const key = String(code || '').trim().toUpperCase();
        return OZON_CARGO_ERROR_REASON_RU[key] || key;
      })
      .join('; ');
  }
  if (Array.isArray(errors) && errors.length) {
    return errors.map((e) => e?.message || e?.description || JSON.stringify(e)).join('; ');
  }
  return null;
}
