import { PHASES } from './types.js';

function num(v) {
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

function levelAllowed(level, policy, segment) {
  if (!level || level.price == null) return false;
  const stockBypass = policy.allow_below_floor_stock === true && segment === 'stock';
  if (level.join_block_reason === 'below_floor' || level.below_floor) {
    if (!stockBypass) return false;
  }
  if (level.join_block_reason === 'no_floor' || level.join_block_reason === 'no_entry_price') {
    return false;
  }
  if (policy.require_profit_ge_markup) {
    const profit = num(level.profit_rub);
    const markup = num(level.markup_rub);
    // markup на уровне может отсутствовать — тогда смотрим offer markup ниже
    if (markup != null && profit != null && profit + 0.009 < markup) return false;
  }
  return true;
}

function offerPassesFilters(offer, policy, segment, price, profit) {
  const stockBypass = policy.allow_below_floor_stock === true && segment === 'stock';
  const floor = num(offer.floor);
  const p = num(price);
  if (p == null || p <= 0) return false;
  if (floor != null && floor > 0 && p + 0.009 < floor && !stockBypass) return false;
  if (policy.require_profit_ge_markup) {
    const markup = num(offer.markup_rub);
    const pr = num(profit ?? offer.profit_rub);
    if (markup != null && pr != null && pr + 0.009 < markup && !stockBypass) return false;
  }
  return true;
}

/** Лучший уровень: max boost среди допустимых. */
export function pickBestLevel(offer, policy, segment) {
  const levels = Array.isArray(offer?.levels) ? offer.levels : [];
  let best = null;
  for (const raw of levels) {
    const level = {
      ...raw,
      markup_rub: raw.markup_rub ?? offer.markup_rub,
      profit_rub: raw.profit_rub,
    };
    if (!levelAllowed(level, policy, segment)) continue;
    if (!best || Number(level.boost) > Number(best.boost)) best = level;
  }
  return best;
}

/**
 * Сдвиг фазы по календарю политики.
 * @returns {{ phase: string, phase_started_at: string, changed: boolean }}
 */
export function advancePhase({
  phase,
  phaseStartedAt,
  now = new Date(),
  phaseADays,
  phaseBDays,
  phaseCDays = 1,
}) {
  let p = PHASES.includes(phase) ? phase : 'A';
  let started = phaseStartedAt ? new Date(phaseStartedAt) : now;
  if (Number.isNaN(started.getTime())) started = now;
  const aDays = Math.max(1, Number(phaseADays) || 14);
  const bDays = Math.max(1, Number(phaseBDays) || 7);
  const cDays = Math.max(1, Number(phaseCDays) || 1);
  const ms = now.getTime() - started.getTime();
  const days = ms / (24 * 60 * 60 * 1000);

  if (p === 'A' && days >= aDays) {
    return { phase: 'B', phase_started_at: now.toISOString(), changed: true };
  }
  if (p === 'B' && days >= bDays) {
    return { phase: 'C', phase_started_at: now.toISOString(), changed: true };
  }
  if (p === 'C' && days >= cDays) {
    return { phase: 'A', phase_started_at: now.toISOString(), changed: true };
  }
  return { phase: p, phase_started_at: started.toISOString(), changed: false };
}

function cmd(base, type, reason, extra = {}) {
  return {
    type,
    marketplace: base.marketplace,
    action_id: String(base.action_id),
    external_product_id: base.external_product_id,
    our_product_id: base.our_product_id ?? null,
    price: null,
    level: null,
    reason,
    phase: base.phase,
    ...extra,
  };
}

/**
 * Решение по одному офферу.
 * @param {object} args
 * @param {import('./types.js').PromoOffer} args.offer
 * @param {object} args.policy
 * @param {import('./types.js').PulseSegment} [args.segment]
 * @param {import('./types.js').PulsePhase} [args.phase]
 * @param {import('./types.js').PortCapabilities} args.capabilities
 * @param {number|null} [args.daysInB30d]
 * @param {boolean} [args.isNewProduct]
 */
export function evaluateOffer({
  offer,
  policy,
  segment = 'normal',
  phase = 'A',
  capabilities,
  daysInB30d = 0,
  isNewProduct = false,
}) {
  const base = { ...offer, phase };
  const maxShare = Number(policy.max_b_share_30d);
  const share = (Number(daysInB30d) || 0) / 30;
  let effectivePhase = phase;

  if ((isNewProduct || segment === 'new') && Number(policy.new_product_base_days) > 0) {
    effectivePhase = 'A';
  }
  // hero не режем по доле B — держим видимость в ударе
  if (
    Number.isFinite(maxShare) &&
    share > maxShare &&
    effectivePhase === 'B' &&
    segment !== 'hero'
  ) {
    effectivePhase = 'C';
  }

  const best = capabilities.levels ? pickBestLevel(offer, policy, segment) : null;
  const entry = num(offer.entry_price ?? offer.promo_price);
  const listPrice = num(offer.list_price);

  // Фаза C или принудительный выход: снять с акции
  if (effectivePhase === 'C') {
    if (offer.participating && capabilities.leave && offer.can_leave) {
      const exitPrice = listPrice != null && listPrice > 0 ? listPrice : (best ? Math.max(best.price, entry || 0) + 1 : null);
      return cmd(base, 'leave', 'фаза C: выход для восстановления базы', {
        phase: 'C',
        price: exitPrice,
      });
    }
    return cmd(base, 'skip', 'фаза C: не участвует или выход недоступен', { phase: 'C' });
  }

  // Фаза A: набор медианы — не углублять бустинг
  if (effectivePhase === 'A') {
    if (offer.participating) {
      if (offer.kind === 'elastic' || (Array.isArray(offer.levels) && offer.levels.length)) {
        // Уже в эластичном: выйти или оставить только если текущий уровень = мин. допустимый
        if (capabilities.leave && offer.can_leave) {
          const current = (offer.levels || []).find((l) => l.current);
          const minOk = best && current && Number(current.boost) <= Number(best.boost)
            && Number(current.boost) === Number((offer.levels || []).filter((l) => levelAllowed({ ...l, markup_rub: offer.markup_rub }, policy, segment))[0]?.boost);
          // Проще: в A всегда выходим из эластичного, чтобы не кормить медиану низкой ценой
          const exitPrice = listPrice != null && listPrice > 0 ? Math.round(listPrice) : null;
          return cmd(base, 'leave', 'фаза A: выход из эластичного для набора медианы', {
            phase: 'A',
            price: exitPrice,
          });
        }
        return cmd(base, 'skip', 'фаза A: участвует, выход недоступен', { phase: 'A' });
      }
      // %-акция в A: можно оставить, если проходит фильтры
      if (offerPassesFilters(offer, policy, segment, entry, offer.profit_rub)) {
        return cmd(base, 'skip', 'фаза A: уже в акции с допустимой ценой', { phase: 'A' });
      }
      if (capabilities.leave && offer.can_leave) {
        return cmd(base, 'leave', 'фаза A: цена акции не проходит фильтры', { phase: 'A', price: listPrice });
      }
    }
    // Кандидат в A: %-акции можно завести; эластичный — нет
    if (!offer.participating && offer.can_join && capabilities.join) {
      const kind = offer.kind || 'other';
      if (kind === 'elastic') {
        return cmd(base, 'skip', 'фаза A: эластичный отложен до фазы B', { phase: 'A' });
      }
      if (offerPassesFilters(offer, policy, segment, entry, offer.profit_rub)) {
        return cmd(base, 'join', 'фаза A: вход в %-акцию при цене ≥ пола', {
          phase: 'A',
          price: entry,
        });
      }
    }
    return cmd(base, 'skip', 'фаза A: без действия', { phase: 'A' });
  }

  // Фаза B: удар
  if (effectivePhase === 'B') {
    if (capabilities.levels && best) {
      if (offer.participating && capabilities.setLevel && offer.can_set_level !== false) {
        const current = (offer.levels || []).find((l) => l.current);
        if (current && Math.abs(Number(current.price) - Number(best.price)) < 1) {
          return cmd(base, 'skip', 'фаза B: уже на лучшем допустимом уровне', {
            phase: 'B',
            price: best.price,
            level: best.boost,
          });
        }
        return cmd(base, 'set_level', 'фаза B: поставить макс. допустимый бустинг', {
          phase: 'B',
          price: best.price,
          level: best.boost,
        });
      }
      if (!offer.participating && offer.can_join && capabilities.join) {
        return cmd(base, 'join', 'фаза B: вход на макс. допустимый бустинг', {
          phase: 'B',
          price: best.price,
          level: best.boost,
        });
      }
      if (offer.participating && !best) {
        if (capabilities.leave && offer.can_leave) {
          return cmd(base, 'leave', 'фаза B: нет допустимого уровня — выйти', { phase: 'B', price: listPrice });
        }
      }
      return cmd(base, 'skip', 'фаза B: нет допустимого уровня бустинга', { phase: 'B' });
    }

    // Без уровней — обычный join/leave
    if (!offer.participating && offer.can_join && capabilities.join) {
      if (offerPassesFilters(offer, policy, segment, entry, offer.profit_rub)) {
        return cmd(base, 'join', 'фаза B: вход в акцию', { phase: 'B', price: entry });
      }
      return cmd(base, 'skip', 'фаза B: вход закрыт фильтрами', { phase: 'B' });
    }
    if (offer.participating) {
      if (!offerPassesFilters(offer, policy, segment, entry, offer.profit_rub)) {
        if (capabilities.leave && offer.can_leave) {
          return cmd(base, 'leave', 'фаза B: участие не проходит фильтры', { phase: 'B', price: listPrice });
        }
      }
      return cmd(base, 'skip', 'фаза B: уже участвует', { phase: 'B' });
    }
  }

  return cmd(base, 'skip', 'нет решения', { phase: effectivePhase });
}

/**
 * Сколько суток товар провёл в фазе B за последние 30 дней
 * (по журналу phase_log + текущей открытой фазе B).
 */
export function daysInBOver30d({ states = [], now = new Date() } = {}) {
  const nowMs = now.getTime();
  const windowStart = nowMs - 30 * 24 * 60 * 60 * 1000;
  let ms = 0;
  for (const st of states || []) {
    const log = Array.isArray(st.phase_log)
      ? st.phase_log
      : Array.isArray(st.last_decision?.phase_log)
        ? st.last_decision.phase_log
        : [];
    for (const iv of log) {
      if (String(iv?.phase || '').toUpperCase() !== 'B') continue;
      const a = Date.parse(iv.start);
      const b = Date.parse(iv.end);
      if (!Number.isFinite(a) || !Number.isFinite(b)) continue;
      const from = Math.max(a, windowStart);
      const to = Math.min(b, nowMs);
      if (to > from) ms += to - from;
    }
    if (String(st.phase || '').toUpperCase() === 'B' && st.phase_started_at) {
      const a = Date.parse(st.phase_started_at);
      if (Number.isFinite(a)) {
        const from = Math.max(a, windowStart);
        if (nowMs > from) ms += nowMs - from;
      }
    }
  }
  return ms / (24 * 60 * 60 * 1000);
}

/** Закрыть интервал B в журнале при смене фазы. */
export function appendPhaseLog(prevLog, { fromPhase, fromStartedAt, toPhase, at = new Date() }) {
  const log = Array.isArray(prevLog) ? [...prevLog] : [];
  if (String(fromPhase || '').toUpperCase() === 'B' && String(toPhase || '').toUpperCase() !== 'B') {
    log.push({
      phase: 'B',
      start: fromStartedAt || at.toISOString(),
      end: at.toISOString(),
    });
  }
  const windowStart = at.getTime() - 40 * 24 * 60 * 60 * 1000;
  return log.filter((iv) => {
    const end = Date.parse(iv.end);
    return !Number.isFinite(end) || end >= windowStart;
  });
}
