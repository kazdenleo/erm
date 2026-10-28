/**
 * Адаптер Яндекс Маркета → PromoAction / PromoOffer.
 * join + leave через marketplacePromotions; уровней бустинга нет.
 */

import {
  listYmPromos,
  listYmPromoOffers,
  joinYmPromo,
  leaveYmPromo,
} from '../../marketplacePromotions.service.js';

function actionKind(promo) {
  const t = String(promo?.type || promo?.mechanica || promo?.mechanicaType || '').toUpperCase();
  if (t.includes('STOCK') || t.includes('FLASH')) return 'stock';
  if (t.includes('DISCOUNT') || t.includes('DIRECT')) return 'percent_off';
  return 'percent_off';
}

/** Кэш офферов на один прогон (participating + candidates без двойного API). */
const offersCache = new Map();

async function loadYmOffers(scope, actionId) {
  const profile = scope?.integrationScope?.profileId ?? scope?.profileId ?? '';
  const key = `${profile}:${actionId}`;
  const hit = offersCache.get(key);
  if (hit && Date.now() - hit.at < 90_000) return hit.offers;
  const res = await listYmPromoOffers(actionId, scope);
  if (!res?.ok) throw new Error(res?.error || 'YM offers');
  const offers = res.offers || [];
  offersCache.set(key, { at: Date.now(), offers });
  if (offersCache.size > 200) {
    const oldest = offersCache.keys().next().value;
    offersCache.delete(oldest);
  }
  return offers;
}

function mapOffer(row, actionId) {
  const participating = row.participating === true;
  const entry =
    row.entry_price != null
      ? Number(row.entry_price)
      : row.max_promo_price != null
        ? Number(row.max_promo_price)
        : row.promo_price != null
          ? Number(row.promo_price)
          : null;
  return {
    marketplace: 'ym',
    action_id: String(actionId),
    external_product_id: row.offer_id,
    our_product_id: row.our_product_id != null ? Number(row.our_product_id) : null,
    list_price: row.price != null ? Number(row.price) : null,
    promo_price: row.promo_price != null ? Number(row.promo_price) : null,
    entry_price: entry,
    floor: row.floor != null ? Number(row.floor) : null,
    markup_rub: row.markup_rub != null ? Number(row.markup_rub) : null,
    profit_rub: row.profit_rub != null ? Number(row.profit_rub) : null,
    participating,
    can_join: !participating && !row.join_block_reason && row.offer_id != null,
    can_leave: participating,
    can_set_level: false,
    kind: 'percent_off',
    meta: {
      offer_id: row.offer_id ?? row.our_sku ?? null,
      name: row.our_product_name ?? null,
      status: row.status ?? null,
      max_promo_price: row.max_promo_price ?? null,
      join_block_reason: row.join_block_reason ?? null,
    },
  };
}

function groupByAction(commands) {
  const map = new Map();
  for (const c of commands) {
    const aid = String(c.action_id);
    if (!map.has(aid)) map.set(aid, { join: [], leave: [] });
    const g = map.get(aid);
    if (c.type === 'join') g.join.push(c);
    else if (c.type === 'leave') g.leave.push(c);
  }
  return map;
}

export const ymPromoPort = {
  id: 'ym',
  label: 'Яндекс Маркет',
  ready: true,
  capabilities() {
    return { join: true, leave: true, setLevel: false, levels: false, percentOffJoin: true };
  },

  async listActions(scope = {}) {
    const res = await listYmPromos(scope);
    if (!res?.ok) throw new Error(res?.error || 'Не удалось загрузить акции YM');
    const list = Array.isArray(res.promos) ? res.promos : [];
    return list.map((p) => ({
      marketplace: 'ym',
      external_id: String(p.id || p.promoId),
      title: p.name || p.title || String(p.id || p.promoId),
      kind: actionKind(p),
      starts_at: p.startDate || p.startsAt || null,
      ends_at: p.endDate || p.endsAt || null,
      meta: {
        type: p.type ?? null,
        status: p.status ?? null,
      },
    }));
  },

  async listParticipating(scope, actionId) {
    const offers = await loadYmOffers(scope, actionId);
    return offers
      .filter((row) => row.participating === true && row.our_product_id != null)
      .map((row) => mapOffer(row, actionId));
  },

  async listCandidates(scope, actionId) {
    const offers = await loadYmOffers(scope, actionId);
    return offers
      .filter((row) => row.participating !== true && row.our_product_id != null)
      .map((row) => mapOffer(row, actionId));
  },

  async apply(scope = {}, commands = [], { dryRun = true } = {}) {
    if (dryRun !== false) {
      return {
        ok: true,
        results: commands.map((c) => ({
          ...c,
          applied: false,
          dryRun: true,
          message: 'dry-run: в YM не отправляли',
        })),
      };
    }

    const results = [];
    const byAction = groupByAction(commands);

    for (const [promoId, groups] of byAction) {
      if (groups.leave.length) {
        const res = await leaveYmPromo(
          {
            promoId,
            offerIds: groups.leave.map((c) => String(c.external_product_id)),
          },
          scope
        );
        for (const c of groups.leave) {
          results.push({
            ...c,
            applied: res.ok === true,
            dryRun: false,
            ok: res.ok !== false,
            error: res.ok ? null : res.error || null,
            message: res.ok ? `leave ok (−${res.removed || 0})` : res.error,
            api: { removed: res.removed, rejected: res.rejected },
          });
        }
      }

      if (groups.join.length) {
        const res = await joinYmPromo(
          {
            promoId,
            offers: groups.join.map((c) => ({
              offerId: String(c.external_product_id),
              promoPrice: c.price != null ? Number(c.price) : null,
              promo_price: c.price != null ? Number(c.price) : null,
            })),
          },
          scope
        );
        for (const c of groups.join) {
          results.push({
            ...c,
            applied: res.ok === true || (res.added || 0) > 0,
            dryRun: false,
            ok: res.ok !== false,
            error: res.ok ? null : res.error || null,
            message: res.ok ? `join ok (+${res.added || 0})` : res.error,
            api: { added: res.added, rejected: res.rejected, blocked: res.blocked },
          });
        }
      }
    }

    for (const c of commands) {
      if (c.type === 'join' || c.type === 'leave') continue;
      results.push({ ...c, applied: false, dryRun: false, ok: true, message: 'no-op' });
    }

    return { ok: results.every((r) => r.ok !== false), results };
  },
};
