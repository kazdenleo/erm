/**
 * Можно ли войти в акцию по цене входа и сохранённому полу (мин. цене).
 * Пол неизвестен — не входим: иначе можно продать в минус.
 */
export function promoJoinDecision({ entryPrice, floor } = {}) {
  const entry = Number(entryPrice);
  const fl = Number(floor);
  if (!Number.isFinite(entry) || entry <= 0) {
    return { ok: false, reason: 'no_entry_price' };
  }
  if (!Number.isFinite(fl) || fl <= 0) {
    return { ok: false, reason: 'no_floor' };
  }
  if (entry + 0.009 < fl) {
    return { ok: false, reason: 'below_floor', gap: Math.round(entry - fl) };
  }
  return { ok: true, gap: Math.round(entry - fl) };
}

export function joinBlockMessage(reason) {
  if (reason === 'below_floor') return 'Цена входа ниже минимальной. Вход в акцию закрыт';
  if (reason === 'no_floor') return 'Минимальная цена не посчитана. Вход в акцию закрыт';
  if (reason === 'no_entry_price') return 'Нет цены входа в акцию';
  return reason ? String(reason) : 'Вход в акцию закрыт';
}

/** Цена, по которой товар войдёт в акцию Ozon. */
export function ozonEntryPrice(p) {
  if (!p) return null;
  const action = Number(p.action_price);
  if (Number.isFinite(action) && action > 0) return action;
  const alert = Number(p.alert_max_action_price);
  if (Number.isFinite(alert) && alert > 0) return alert;
  const maxAction = Number(p.max_action_price);
  if (Number.isFinite(maxAction) && maxAction > 0) return maxAction;
  const minElastic = Number(p.price_min_elastic);
  if (Number.isFinite(minElastic) && minElastic > 0) return minElastic;
  return null;
}
