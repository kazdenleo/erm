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
import { buildOzonPriceImportEntry } from '../../marketplaceMinPricePush.service.js';
import { elasticBoostLevels } from '../../../utils/ozonElasticBoost.js';
import { restoreExitPrice } from '../../../utils/ozonPromoExit.js';
import { ozonApiPostWithRetry } from '../../../utils/ozonSellerApi.js';
import logger from '../../../utils/logger.js';

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
    selling_price: row.selling_price != null ? Number(row.selling_price) : null,
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
      : restoreExitPrice({
          selling_price: c.selling_price,
          price: c.list_price,
          list_price: c.list_price,
          floor: c.floor,
          max_action_price: c.max_action_price,
        });
  return {
    ozonProductId,
    ourProductId: c.our_product_id != null ? Number(c.our_product_id) : null,
    price: price != null ? price : (c.list_price != null ? Number(c.list_price) : null),
    floor: c.floor != null ? Number(c.floor) : null,
    selling_price: c.selling_price != null ? Number(c.selling_price) : null,
    max_action_price: c.max_action_price != null ? Number(c.max_action_price) : null,
    actionPrice: price,
    action_price: price,
  };
}

/**
 * После leave — зафиксировать витринную цену через import/prices
 * (selling ERP или пол), даже если deactivate сработал без raise.
 */
async function pushRestoredCatalogPrices(scope, leaveCommands) {
  if (!leaveCommands?.length) return { pushed: 0, errors: [] };
  const { client_id, api_key } = await pricesService._getOzonApiCredentials(scope);
  if (!client_id || !api_key) return { pushed: 0, errors: ['no_credentials'] };

  const ozonApiOpts = { ozonOverride: { client_id, api_key } };
  const prices = [];
  for (const c of leaveCommands) {
    const ozonProductId = Number(c.external_product_id);
    if (!Number.isFinite(ozonProductId) || ozonProductId < 1) continue;
    const floorRaw = c.floor != null ? Number(c.floor) : null;
    const sellingRaw =
      c.selling_price != null
        ? Number(c.selling_price)
        : c.price != null
          ? Number(c.price)
          : null;
    const floor =
      floorRaw != null && floorRaw > 0
        ? floorRaw
        : sellingRaw != null && sellingRaw > 0
          ? sellingRaw
          : null;
    const entry = buildOzonPriceImportEntry({
      floor,
      sellingTarget: sellingRaw,
      ozonProductId,
    });
    if (entry) prices.push(entry);
  }
  if (!prices.length) return { pushed: 0, errors: [] };

  const errors = [];
  let pushed = 0;
  const batchSize = 100;
  for (let i = 0; i < prices.length; i += batchSize) {
    const chunk = prices.slice(i, i + batchSize);
    try {
      await ozonApiPostWithRetry('/v1/product/import/prices', { prices: chunk }, ozonApiOpts);
      pushed += chunk.length;
    } catch (e) {
      const msg = `import/prices: ${e?.message || String(e)}`.substring(0, 220);
      errors.push(msg);
      logger.warn('[PromoPulse Ozon] restore import/prices failed', { message: msg });
    }
  }
  return { pushed, errors };
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
        let restore = { pushed: 0, errors: [] };
        if (res.ok === true) {
          restore = await pushRestoredCatalogPrices(scope, groups.leave);
        }
        for (const c of groups.leave) {
          const target =
            c.price != null
              ? Number(c.price)
              : c.selling_price != null
                ? Number(c.selling_price)
                : null;
          const restoreNote =
            res.ok && target != null
              ? `вышли, цена → ${Math.round(target)} ₽`
              : null;
          results.push({
            ...c,
            applied: res.ok === true,
            dryRun: false,
            ok: res.ok !== false,
            error: res.ok ? null : res.error || null,
            message:
              restoreNote ||
              res.notice ||
              (res.ok ? 'leave ok' : res.error),
            api: {
              deactivated: res.deactivated,
              rejected: res.rejected,
              raisedTo: res.raisedTo,
              restorePushed: restore.pushed,
              restoreErrors: restore.errors,
            },
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
