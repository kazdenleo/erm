/**
 * Заявки на возврат с маркетплейсов (PostgreSQL)
 */

import { query } from '../config/database.js';

function parseJson(value, fallback) {
  if (value == null) return fallback;
  if (typeof value === 'object') return value;
  if (typeof value === 'string') {
    try {
      return JSON.parse(value);
    } catch {
      return fallback;
    }
  }
  return fallback;
}

function rowToApi(row) {
  if (!row) return null;
  return {
    id: row.id != null ? String(row.id) : null,
    profileId: row.profile_id != null ? Number(row.profile_id) : null,
    marketplace: row.marketplace,
    externalId: row.external_id,
    status: row.status ?? null,
    needsDecision: Boolean(row.needs_decision),
    buyerComment: row.buyer_comment ?? null,
    sellerComment: row.seller_comment ?? null,
    reason: row.reason ?? null,
    productName: row.product_name ?? null,
    skuOrOffer: row.sku_or_offer ?? null,
    orderId: row.order_id ?? null,
    price: row.price != null ? Number(row.price) : null,
    currency: row.currency ?? null,
    photos: parseJson(row.photos, []),
    availableActions: parseJson(row.available_actions, []),
    rejectionReasons: parseJson(row.rejection_reasons, []),
    items: parseJson(row.items, []),
    campaignId: row.campaign_id ?? null,
    meta: parseJson(row.meta, {}),
    sourceCreatedAt: row.source_created_at ?? null,
    sourceUpdatedAt: row.source_updated_at ?? null,
    syncedAt: row.synced_at ?? null,
    createdAt: row.created_at ?? null,
    updatedAt: row.updated_at ?? null,
  };
}

function toJsonParam(value, fallback) {
  if (value == null) return JSON.stringify(fallback);
  if (typeof value === 'string') return value;
  return JSON.stringify(value);
}

class MarketplaceReturnClaimsRepositoryPG {
  async findRowByIdAndProfile(id, profileId) {
    const nid = Number(id);
    if (!Number.isFinite(nid) || nid < 1) return null;
    const result = await query(
      'SELECT * FROM marketplace_return_claims WHERE id = $1 AND profile_id = $2',
      [nid, profileId]
    );
    return result.rows[0] || null;
  }

  async findOneApiByIdAndProfile(id, profileId) {
    const row = await this.findRowByIdAndProfile(id, profileId);
    return rowToApi(row);
  }

  async upsertRow(row) {
    const {
      profile_id,
      marketplace,
      external_id,
      status,
      needs_decision,
      buyer_comment,
      seller_comment,
      reason,
      product_name,
      sku_or_offer,
      order_id,
      price,
      currency,
      photos,
      available_actions,
      rejection_reasons,
      items,
      campaign_id,
      meta,
      raw_payload,
      source_created_at,
      source_updated_at,
    } = row;

    const result = await query(
      `INSERT INTO marketplace_return_claims (
        profile_id, marketplace, external_id, status, needs_decision,
        buyer_comment, seller_comment, reason, product_name, sku_or_offer,
        order_id, price, currency, photos, available_actions, rejection_reasons,
        items, campaign_id, meta, raw_payload, source_created_at, source_updated_at,
        synced_at, updated_at
      ) VALUES (
        $1, $2, $3, $4, $5,
        $6, $7, $8, $9, $10,
        $11, $12, $13, $14::jsonb, $15::jsonb, $16::jsonb,
        $17::jsonb, $18, $19::jsonb, $20::jsonb, $21, $22,
        CURRENT_TIMESTAMP, CURRENT_TIMESTAMP
      )
      ON CONFLICT (profile_id, marketplace, external_id) DO UPDATE SET
        status = EXCLUDED.status,
        needs_decision = EXCLUDED.needs_decision,
        buyer_comment = EXCLUDED.buyer_comment,
        seller_comment = COALESCE(EXCLUDED.seller_comment, marketplace_return_claims.seller_comment),
        reason = EXCLUDED.reason,
        product_name = EXCLUDED.product_name,
        sku_or_offer = EXCLUDED.sku_or_offer,
        order_id = EXCLUDED.order_id,
        price = EXCLUDED.price,
        currency = EXCLUDED.currency,
        photos = EXCLUDED.photos,
        available_actions = EXCLUDED.available_actions,
        rejection_reasons = EXCLUDED.rejection_reasons,
        items = EXCLUDED.items,
        campaign_id = COALESCE(EXCLUDED.campaign_id, marketplace_return_claims.campaign_id),
        meta = EXCLUDED.meta,
        raw_payload = EXCLUDED.raw_payload,
        source_created_at = COALESCE(EXCLUDED.source_created_at, marketplace_return_claims.source_created_at),
        source_updated_at = EXCLUDED.source_updated_at,
        synced_at = CURRENT_TIMESTAMP,
        updated_at = CURRENT_TIMESTAMP
      RETURNING *`,
      [
        profile_id,
        marketplace,
        String(external_id),
        status ?? null,
        needs_decision !== false,
        buyer_comment ?? null,
        seller_comment ?? null,
        reason ?? null,
        product_name ?? null,
        sku_or_offer ?? null,
        order_id != null ? String(order_id) : null,
        price != null && Number.isFinite(Number(price)) ? Number(price) : null,
        currency ?? null,
        toJsonParam(photos, []),
        toJsonParam(available_actions, []),
        toJsonParam(rejection_reasons, []),
        toJsonParam(items, []),
        campaign_id != null ? String(campaign_id) : null,
        toJsonParam(meta, {}),
        toJsonParam(raw_payload, null),
        source_created_at ?? null,
        source_updated_at ?? null,
      ]
    );
    return rowToApi(result.rows[0]);
  }

  async markDecided(id, profileId, { status, sellerComment, availableActions } = {}) {
    const nid = Number(id);
    if (!Number.isFinite(nid) || nid < 1) return null;
    const result = await query(
      `UPDATE marketplace_return_claims SET
        needs_decision = FALSE,
        status = COALESCE($3, status),
        seller_comment = COALESCE($4, seller_comment),
        available_actions = COALESCE($5::jsonb, available_actions),
        updated_at = CURRENT_TIMESTAMP
       WHERE id = $1 AND profile_id = $2
       RETURNING *`,
      [
        nid,
        profileId,
        status ?? null,
        sellerComment ?? null,
        availableActions != null ? JSON.stringify(availableActions) : null,
      ]
    );
    return rowToApi(result.rows[0]);
  }

  async findByProfile(profileId, opts = {}) {
    const params = [profileId];
    const where = ['profile_id = $1'];
    let i = 2;

    const mp = opts.marketplace != null ? String(opts.marketplace).trim().toLowerCase() : null;
    if (mp && mp !== 'all') {
      const norm = mp === 'wb' ? 'wildberries' : mp === 'ym' ? 'yandex' : mp;
      where.push(`marketplace = $${i++}`);
      params.push(norm);
    }

    const decision = opts.decision != null ? String(opts.decision).trim().toLowerCase() : 'pending';
    if (decision === 'pending' || decision === 'new' || decision === 'open') {
      where.push('needs_decision = TRUE');
    } else if (decision === 'done' || decision === 'closed' || decision === 'answered') {
      where.push('needs_decision = FALSE');
    }

    const limit = Number.isFinite(Number(opts.limit)) ? Math.min(Math.max(Number(opts.limit), 1), 500) : 200;
    const offset = Number.isFinite(Number(opts.offset)) ? Math.max(Number(opts.offset), 0) : 0;

    params.push(limit, offset);
    const result = await query(
      `SELECT * FROM marketplace_return_claims
       WHERE ${where.join(' AND ')}
       ORDER BY source_created_at DESC NULLS LAST, id DESC
       LIMIT $${i++} OFFSET $${i}`,
      params
    );
    return result.rows.map(rowToApi);
  }

  async countPendingByProfile(profileId, opts = {}) {
    const params = [profileId];
    const where = ['profile_id = $1', 'needs_decision = TRUE'];
    const mp = opts.marketplace != null ? String(opts.marketplace).trim().toLowerCase() : null;
    if (mp && mp !== 'all') {
      const norm = mp === 'wb' ? 'wildberries' : mp === 'ym' ? 'yandex' : mp;
      where.push('marketplace = $2');
      params.push(norm);
    }
    const result = await query(
      `SELECT COUNT(*)::int AS cnt FROM marketplace_return_claims WHERE ${where.join(' AND ')}`,
      params
    );
    return Number(result.rows[0]?.cnt) || 0;
  }

  async countBreakdownByProfile(profileId, opts = {}) {
    const params = [profileId];
    const where = ['profile_id = $1'];
    const mp = opts.marketplace != null ? String(opts.marketplace).trim().toLowerCase() : null;
    if (mp && mp !== 'all') {
      const norm = mp === 'wb' ? 'wildberries' : mp === 'ym' ? 'yandex' : mp;
      where.push('marketplace = $2');
      params.push(norm);
    }
    const result = await query(
      `SELECT
         COUNT(*)::int AS all_cnt,
         COUNT(*) FILTER (WHERE needs_decision)::int AS pending_cnt,
         COUNT(*) FILTER (WHERE NOT needs_decision)::int AS done_cnt
       FROM marketplace_return_claims
       WHERE ${where.join(' AND ')}`,
      params
    );
    const r = result.rows[0] || {};
    return {
      all: Number(r.all_cnt) || 0,
      pending: Number(r.pending_cnt) || 0,
      done: Number(r.done_cnt) || 0,
    };
  }

  async countPendingByMarketplace(profileId) {
    const result = await query(
      `SELECT marketplace, COUNT(*)::int AS cnt
       FROM marketplace_return_claims
       WHERE profile_id = $1 AND needs_decision = TRUE
       GROUP BY marketplace`,
      [profileId]
    );
    const out = { ozon: 0, wildberries: 0, yandex: 0 };
    for (const row of result.rows) {
      const mp = String(row.marketplace || '').toLowerCase();
      if (mp in out) out[mp] = Number(row.cnt) || 0;
    }
    return out;
  }
}

export default new MarketplaceReturnClaimsRepositoryPG();
export { rowToApi };
