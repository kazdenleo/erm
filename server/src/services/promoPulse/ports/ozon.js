/**
 * Адаптер Ozon → нормализованные PromoAction / PromoOffer.
 * apply: dry-run или join / leave / set_level через marketplacePromotions.
 */

import pricesService from '../../prices.service.js';
import {
  joinOzonAction,
  leaveOzonAction,
  setOzonActionPrice,
} from '../../marketplacePromotions.service.js';
import { elasticBoostLevels } from '../../../utils/ozonElasticBoost.js';
import { exitActionPrice } from '../../../utils/ozonPromoExit.js';

function actionKind(action) {
  const t = String(action?.action_type || action?.discount_type || '').toUpperCase();
  if (t.includes('ELASTIC') || t.includes('BOOST')) return 'elastic';
  if (t.includes('STOCK')) return 'stock';
  if (t.includes('DISCOUNT') || t.includes('ADDITIONAL')) return 'percent_off';
  return 'other';
}

function mapOffer(row, actionId, { participating }) {
  const levelsRaw = Array.isArray(row.boost_levels) ? row.boost_levels : elasticBoostLevels(row);
  const levels = levelsRaw.map((level) => ({
    boost: level.boost,
    price: level.price,
    profit_rub: level.profit_rub ?? null,
    below_floor: level.below_floor === true,
    join_block_reason: level.join_block_reason ?? null,
    current: level.current === true,
  }));
  const hasLevels = levels.length > 0;
  const maxActionPrice =
    row.max_action_price != null ? Number(row.max_action_price) : null;
  return {
    marketplace: 'ozon',
    action_id: String(actionId),
    external_product_id: row.id,
    our_product_id: row.our_product_id != null ? Number(row.our_product_id) : null,
    list_price: row.price != null ? Number(row.price) : null,
    promo_price: row.action_price != null ? Number(row.action_price) : null,
    entry_price: row.entry_price != null ? Number(row.entry_price) : null,
    floor: row.floor != null ? Number(row.floor) : null,
    markup_rub: row.markup_rub != null ? Number(row.markup_rub) : null,
    profit_rub: row.profit_rub != null ? Number(row.profit_rub) : null,
    max_action_price: Number.isFinite(maxActionPrice) ? maxActionPrice : null,
    levels: hasLevels ? levels : undefined,
    participating,
    can_join: !participating && !row.join_block_reason,
    can_leave: participating,
    can_set_level: hasLevels,
    kind: hasLevels ? 'elastic' : 'other',
    meta: {
      offer_id: row.offer_id ?? row.our_sku ?? null,
      name: row.our_product_name ?? null,
      add_mode: row.add_mode ?? null,
      current_boost: row.current_boost ?? null,
      join_block_reason: row.join_block_reason ?? null,
      max_action_price: Number.isFinite(maxActionPrice) ? maxActionPrice : null,
    },
  };
}

function groupByAction(commands) {
  const map = new Map();
  for (const c of commands) {
    const aid = String(c.action_id);
    if (!map.has(aid)) map.set(aid, { join: [], leave: [], set_level: [] });
    const g = map.get(aid);
    if (c.type === 'join') g.join.push(c);
    else if (c.type === 'leave') g.leave.push(c);
    else if (c.type === 'set_level') g.set_level.push(c);
  }
  return map;
}

function leaveProductPayload(c) {
  const ozonProductId = Number(c.external_product_id);
  const price =
    c.price != null
      ? Number(c.price)
      : exitActionPrice({
          price: c.list_price,
          floor: c.floor,
          max_action_price: c.max_action_price,
        });
  return {
    ozonProductId,
    ourProductId: c.our_product_id != null ? Number(c.our_product_id) : null,
    price: c.list_price != null ? Number(c.list_price) : price,
    floor: c.floor != null ? Number(c.floor) : null,
    max_action_price: c.max_action_price != null ? Number(c.max_action_price) : null,
    actionPrice: price,
    action_price: price,
  };
}

export const ozonPromoPort = {
  id: 'ozon',
  label: 'Ozon',
  ready: true,
  capabilities() {
    return { join: true, leave: true, setLevel: true, levels: true, percentOffJoin: true };
  },

  async listActions(scope = {}) {
    const res = await pricesService.getOzonActions(scope);
    const list = Array.isArray(res?.result)
      ? res.result
      : Array.isArray(res?.data)
        ? res.data
        : Array.isArray(res)
          ? res
          : [];
    return list.map((a) => ({
      marketplace: 'ozon',
      external_id: String(a.id),
      title: a.title || String(a.id),
      kind: actionKind(a),
      starts_at: a.date_start || null,
      ends_at: a.date_end || null,
      meta: {
        action_type: a.action_type ?? null,
        discount_type: a.discount_type ?? null,
        participating_products_count: a.participating_products_count ?? null,
        potential_products_count: a.potential_products_count ?? null,
      },
    }));
  },

  async listParticipating(scope, actionId) {
    const res = await pricesService.getOzonActionProducts(actionId, scope);
    const list = Array.isArray(res?.products) ? res.products : Array.isArray(res?.data) ? res.data : [];
    return list.map((row) => mapOffer(row, actionId, { participating: true }));
  },

  async listCandidates(scope, actionId) {
    const res = await pricesService.getOzonActionCandidates(actionId, scope);
    const list = Array.isArray(res?.products) ? res.products : Array.isArray(res?.data) ? res.data : [];
    return list.map((row) => mapOffer(row, actionId, { participating: false }));
  },

  async apply(scope = {}, commands = [], { dryRun = true } = {}) {
    if (dryRun !== false) {
      return {
        ok: true,
        results: commands.map((c) => ({
          ...c,
          applied: false,
          dryRun: true,
          message: 'dry-run: в Ozon не отправляли',
        })),
      };
    }

    const results = [];
    const byAction = groupByAction(commands);

    for (const [actionId, groups] of byAction) {
      if (groups.leave.length) {
        const res = await leaveOzonAction(
          {
            actionId,
            products: groups.leave.map(leaveProductPayload),
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
            message: res.notice || (res.ok ? 'leave ok' : res.error),
            api: { deactivated: res.deactivated, rejected: res.rejected, raisedTo: res.raisedTo },
          });
        }
      }

      if (groups.join.length) {
        const res = await joinOzonAction(
          {
            actionId,
            products: groups.join.map((c) => ({
              ozonProductId: Number(c.external_product_id),
              ourProductId: c.our_product_id != null ? Number(c.our_product_id) : null,
              actionPrice: c.price != null ? Number(c.price) : null,
              action_price: c.price != null ? Number(c.price) : null,
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

      if (groups.set_level.length) {
        const res = await setOzonActionPrice(
          {
            actionId,
            products: groups.set_level.map((c) => ({
              ozonProductId: Number(c.external_product_id),
              ourProductId: c.our_product_id != null ? Number(c.our_product_id) : null,
              actionPrice: c.price != null ? Number(c.price) : null,
              action_price: c.price != null ? Number(c.price) : null,
              boost: c.level != null ? Number(c.level) : null,
            })),
          },
          scope
        );
        for (const c of groups.set_level) {
          results.push({
            ...c,
            applied: res.ok === true,
            dryRun: false,
            ok: res.ok !== false,
            error: res.ok ? null : res.error || null,
            message: res.notice || (res.ok ? 'set_level ok' : res.error),
            api: { rejected: res.rejected, blocked: res.blocked },
          });
        }
      }
    }

    // Команды без join/leave/set_level (на всякий случай)
    for (const c of commands) {
      if (c.type === 'join' || c.type === 'leave' || c.type === 'set_level') continue;
      results.push({ ...c, applied: false, dryRun: false, ok: true, message: 'no-op' });
    }

    const ok = results.every((r) => r.ok !== false);
    return { ok, results };
  },
};
