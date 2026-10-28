/**
 * Адаптер Wildberries → PromoAction / PromoOffer.
 * WB calendar API: join есть, leave отдельного метода нет (capabilities.leave=false).
 */

import pricesService from '../../prices.service.js';
import { joinWbPromotion } from '../../marketplacePromotions.service.js';

function actionKind(promo) {
  const t = String(promo?.type || promo?.promotionType || promo?.rangingType || '').toUpperCase();
  if (t.includes('AUTO')) return 'other';
  if (t.includes('STOCK')) return 'stock';
  return 'percent_off';
}

function mapOffer(row, actionId, { participating }) {
  const entry = row.entry_price != null ? Number(row.entry_price) : (row.planPrice != null ? Number(row.planPrice) : null);
  return {
    marketplace: 'wb',
    action_id: String(actionId),
    external_product_id: row.id,
    our_product_id: row.our_product_id != null ? Number(row.our_product_id) : null,
    list_price: row.price != null ? Number(row.price) : null,
    promo_price: entry,
    entry_price: entry,
    floor: row.floor != null ? Number(row.floor) : null,
    markup_rub: row.markup_rub != null ? Number(row.markup_rub) : null,
    profit_rub: row.profit_rub != null ? Number(row.profit_rub) : null,
    participating,
    can_join: !participating && !row.join_block_reason && row.our_product_id != null,
    can_leave: false,
    can_set_level: false,
    kind: 'percent_off',
    meta: {
      offer_id: row.our_sku ?? null,
      name: row.our_product_name ?? null,
      plan_discount: row.planDiscount ?? null,
      join_block_reason: row.join_block_reason ?? null,
    },
  };
}

async function fetchAllNomenclatures(actionId, inAction, scope) {
  const out = [];
  const pageSize = 1000;
  for (let page = 0; page < 20; page++) {
    const res = await pricesService.getWBPromotionNomenclatures(
      actionId,
      inAction,
      pageSize,
      page * pageSize,
      scope
    );
    if (!res?.ok) {
      if (page === 0 && res?.notApplicable) return { ok: true, list: [], notApplicable: true };
      if (page === 0) return { ok: false, error: res?.error || 'WB nomenclatures', list: [] };
      break;
    }
    if (res.notApplicable) return { ok: true, list: [], notApplicable: true };
    const chunk = Array.isArray(res.nomenclatures) ? res.nomenclatures : [];
    out.push(...chunk);
    if (chunk.length < pageSize) break;
  }
  return { ok: true, list: out };
}

function groupJoins(commands) {
  const map = new Map();
  for (const c of commands) {
    if (c.type !== 'join') continue;
    const aid = String(c.action_id);
    if (!map.has(aid)) map.set(aid, []);
    map.get(aid).push(c);
  }
  return map;
}

export const wbPromoPort = {
  id: 'wb',
  label: 'Wildberries',
  ready: true,
  capabilities() {
    return { join: true, leave: false, setLevel: false, levels: false, percentOffJoin: true };
  },

  async listActions(scope = {}) {
    const res = await pricesService.getWBActions(scope);
    if (!res?.ok) throw new Error(res?.error || 'Не удалось загрузить акции WB');
    const list = Array.isArray(res.data) ? res.data : Array.isArray(res.promotions) ? res.promotions : [];
    return list.map((p) => ({
      marketplace: 'wb',
      external_id: String(p.id),
      title: p.name || p.title || String(p.id),
      kind: actionKind(p),
      starts_at: p.startDateTime || p.startDate || null,
      ends_at: p.endDateTime || p.endDate || null,
      meta: {
        type: p.type ?? p.promotionType ?? null,
        inPromoActionTotal: p.inPromoActionTotal ?? null,
        notInPromoActionTotal: p.notInPromoActionTotal ?? null,
      },
    }));
  },

  async listParticipating(scope, actionId) {
    const res = await fetchAllNomenclatures(actionId, true, scope);
    if (!res.ok) throw new Error(res.error || 'WB participating');
    return res.list
      .filter((row) => row.our_product_id != null)
      .map((row) => mapOffer(row, actionId, { participating: true }));
  },

  async listCandidates(scope, actionId) {
    const res = await fetchAllNomenclatures(actionId, false, scope);
    if (!res.ok) throw new Error(res.error || 'WB candidates');
    return res.list
      .filter((row) => row.our_product_id != null)
      .map((row) => mapOffer(row, actionId, { participating: false }));
  },

  async apply(scope = {}, commands = [], { dryRun = true } = {}) {
    if (dryRun !== false) {
      return {
        ok: true,
        results: commands.map((c) => ({
          ...c,
          applied: false,
          dryRun: true,
          message: 'dry-run: в WB не отправляли',
        })),
      };
    }

    const results = [];
    const joins = groupJoins(commands);

    for (const [promotionId, batch] of joins) {
      const res = await joinWbPromotion(
        {
          promotionId,
          items: batch.map((c) => ({
            nmId: Number(c.external_product_id),
            planPrice: c.price != null ? Number(c.price) : c.entry_price,
            ourProductId: c.our_product_id != null ? Number(c.our_product_id) : null,
          })),
        },
        scope
      );
      for (const c of batch) {
        results.push({
          ...c,
          applied: res.ok === true || (res.added || 0) > 0,
          dryRun: false,
          ok: res.ok !== false,
          error: res.ok ? null : res.error || null,
          message: res.ok ? `join ok (+${res.added || 0})` : res.error,
          api: { added: res.added, blocked: res.blocked, uploadId: res.uploadId },
        });
      }
    }

    for (const c of commands) {
      if (c.type === 'join') continue;
      results.push({
        ...c,
        applied: false,
        dryRun: false,
        ok: true,
        message: c.type === 'leave' ? 'WB: выход из акции API не поддерживает' : 'no-op',
      });
    }

    return { ok: results.every((r) => r.ok !== false), results };
  },
};
