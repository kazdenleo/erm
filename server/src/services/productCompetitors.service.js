/**
 * Сервис конкурентов товара: CRUD + обновление с витрины + алерты.
 */
import { query } from '../config/database.js';
import logger from '../utils/logger.js';
import { addRuntimeNotification } from '../utils/runtime-notifications.js';
import {
  COMPETITOR_MARKETPLACES,
  MAX_COMPETITORS_PER_MARKETPLACE,
  parseCompetitorUrl,
  fetchCompetitorSnapshot,
} from './productCompetitors.fetch.js';

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

function cleanText(value, max) {
  const s = String(value || '').replace(/\s+/g, ' ').trim();
  if (!s) return null;
  return s.slice(0, max);
}

function parseClientPrice(value) {
  if (value == null || value === '') return null;
  const n = Number(String(value).replace(/\s/g, '').replace(',', '.'));
  if (!Number.isFinite(n) || n <= 0 || n > 100000000) return null;
  return Math.round(n * 100) / 100;
}

function parseClientRating(value) {
  if (value == null || value === '') return null;
  const n = Number(String(value).replace(',', '.'));
  if (!Number.isFinite(n) || n <= 0 || n > 5) return null;
  return Math.round(n * 100) / 100;
}

function parseClientReviews(value) {
  if (value == null || value === '') return null;
  const n = Number(String(value).replace(/\s/g, ''));
  if (!Number.isFinite(n) || n < 0 || n > 100000000) return null;
  return Math.round(n);
}

function parseClientStock(value) {
  if (value == null || value === '') return null;
  const n = Number(value);
  if (!Number.isFinite(n) || n < 0 || n > 100000000) return null;
  return Math.round(n);
}

function mapRow(row) {
  if (!row) return null;
  return {
    id: Number(row.id),
    product_id: Number(row.product_id),
    marketplace: row.marketplace,
    url: row.url,
    external_id: row.external_id,
    title: row.title,
    price: row.price != null ? Number(row.price) : null,
    rating: row.rating != null ? Number(row.rating) : null,
    reviews_count: row.reviews_count != null ? Number(row.reviews_count) : null,
    stock_qty: row.stock_qty != null ? Number(row.stock_qty) : null,
    last_checked_at: row.last_checked_at,
    last_error: row.last_error,
    alert_sent_at: row.alert_sent_at,
    created_at: row.created_at,
    updated_at: row.updated_at,
    below_cost:
      row.product_cost != null &&
      row.price != null &&
      Number(row.price) < Number(row.product_cost),
    product_cost: row.product_cost != null ? Number(row.product_cost) : null,
    product_sku: row.product_sku || null,
    product_name: row.product_name || null,
  };
}

class ProductCompetitorsService {
  async listByProductId(productId) {
    const r = await query(
      `SELECT c.*, p.cost AS product_cost, p.sku AS product_sku, p.name AS product_name
       FROM product_competitors c
       JOIN products p ON p.id = c.product_id
       WHERE c.product_id = $1
       ORDER BY c.marketplace, c.id`,
      [productId]
    );
    return (r.rows || []).map(mapRow);
  }

  async countByMarketplace(productId, marketplace) {
    const r = await query(
      `SELECT COUNT(*)::int AS cnt FROM product_competitors
       WHERE product_id = $1 AND marketplace = $2`,
      [productId, marketplace]
    );
    return Number(r.rows?.[0]?.cnt || 0);
  }

  async add(productId, rawUrl) {
    const parsed = parseCompetitorUrl(rawUrl);
    if (!COMPETITOR_MARKETPLACES.includes(parsed.marketplace)) {
      const err = new Error('Неподдерживаемый маркетплейс');
      err.statusCode = 400;
      throw err;
    }

    const prod = await query(`SELECT id, cost, sku, name FROM products WHERE id = $1`, [productId]);
    if (!prod.rows?.length) {
      const err = new Error('Товар не найден');
      err.statusCode = 404;
      throw err;
    }

    const cnt = await this.countByMarketplace(productId, parsed.marketplace);
    if (cnt >= MAX_COMPETITORS_PER_MARKETPLACE) {
      const err = new Error(
        `Лимит: не больше ${MAX_COMPETITORS_PER_MARKETPLACE} конкурентов на ${parsed.marketplace.toUpperCase()}`
      );
      err.statusCode = 400;
      throw err;
    }

    let inserted;
    try {
      const ins = await query(
        `INSERT INTO product_competitors (product_id, marketplace, url, external_id)
         VALUES ($1, $2, $3, $4)
         RETURNING *`,
        [productId, parsed.marketplace, parsed.url, parsed.externalId]
      );
      inserted = ins.rows[0];
    } catch (e) {
      if (String(e?.code) === '23505') {
        const err = new Error('Такая ссылка уже добавлена');
        err.statusCode = 409;
        throw err;
      }
      throw e;
    }

    if (parsed.marketplace === 'ozon') {
      await query(
        `UPDATE product_competitors
         SET last_error = $2, updated_at = CURRENT_TIMESTAMP
         WHERE id = $1`,
        [inserted.id, 'Цена запишется расширением, когда карточка открыта в браузере']
      );
      const list = await this.listByProductId(productId);
      return list.find((x) => x.id === Number(inserted.id)) || mapRow(inserted);
    }

    // Сразу обновляем снимок (с лимитом времени — иначе proxy отдаёт 502)
    try {
      const refreshed = await Promise.race([
        this.refreshOne(inserted.id),
        sleep(45000).then(() => null),
      ]);
      if (refreshed) return refreshed;
      const list = await this.listByProductId(productId);
      return list.find((x) => x.id === Number(inserted.id)) || mapRow(inserted);
    } catch (e) {
      logger.warn('[Competitors] refresh after add failed', { id: inserted.id, message: e?.message });
      return mapRow({ ...inserted, product_cost: prod.rows[0].cost, product_sku: prod.rows[0].sku, product_name: prod.rows[0].name });
    }
  }

  async remove(productId, competitorId) {
    const r = await query(
      `DELETE FROM product_competitors WHERE id = $1 AND product_id = $2 RETURNING id`,
      [competitorId, productId]
    );
    if (!r.rows?.length) {
      const err = new Error('Конкурент не найден');
      err.statusCode = 404;
      throw err;
    }
    return { ok: true };
  }

  async refreshOne(competitorId) {
    const r = await query(
      `SELECT c.*, p.cost AS product_cost, p.sku AS product_sku, p.name AS product_name
       FROM product_competitors c
       JOIN products p ON p.id = c.product_id
       WHERE c.id = $1`,
      [competitorId]
    );
    const row = r.rows?.[0];
    if (!row) {
      const err = new Error('Конкурент не найден');
      err.statusCode = 404;
      throw err;
    }

    if (row.marketplace === 'ozon') {
      return mapRow(row);
    }

    const snap = await fetchCompetitorSnapshot(row.marketplace, {
      externalId: row.external_id,
      url: row.url,
    });

    const now = new Date().toISOString();
    let title = row.title;
    let price = row.price != null ? Number(row.price) : null;
    let rating = row.rating != null ? Number(row.rating) : null;
    let reviews_count = row.reviews_count != null ? Number(row.reviews_count) : null;
    let last_error = null;

    if (snap.ok) {
      if (snap.title) title = snap.title;
      if (snap.price != null) price = snap.price;
      // Не затираем уже сохранённый рейтинг/отзывы нулём; 0 считаем «нет данных»
      if (snap.rating != null && Number(snap.rating) > 0) {
        rating = Number(snap.rating);
      } else if ((rating == null || Number(rating) === 0) && snap.rating != null && Number(snap.rating) > 0) {
        rating = Number(snap.rating);
      }
      if (snap.reviews_count != null) {
        const next = Number(snap.reviews_count);
        const prev = reviews_count != null ? Number(reviews_count) : null;
        if (Number.isFinite(next) && next >= 0 && (prev == null || prev === 0 || next > prev)) {
          reviews_count = next;
        }
      }
      last_error = snap.warning || null;
    } else {
      last_error = snap.error || 'Ошибка обновления';
    }

    const cost = row.product_cost != null ? Number(row.product_cost) : null;
    let alert_sent_at = row.alert_sent_at;
    const belowCost = cost != null && price != null && price < cost;

    if (belowCost) {
      if (!alert_sent_at) {
        await addRuntimeNotification({
          type: 'competitor_price_below_cost',
          severity: 'warn',
          source: 'product_competitors',
          marketplace: row.marketplace,
          title: 'Цена конкурента ниже себестоимости',
          message:
            `${row.product_sku || row.product_id}: конкурент ${row.marketplace.toUpperCase()} ` +
            `${price} ₽ < себестоимость ${cost} ₽` +
            (title ? ` («${String(title).slice(0, 80)}»)` : ''),
          meta: {
            product_id: Number(row.product_id),
            competitor_id: Number(row.id),
            url: `/products/${row.product_id}?tab=competitors`,
          },
        });
        alert_sent_at = now;
      }
    } else if (alert_sent_at) {
      // Цена снова выше/равна себестоимости — можно снова алертить при следующем падении
      alert_sent_at = null;
    }

    const upd = await query(
      `UPDATE product_competitors SET
         title = $2,
         price = $3,
         rating = $4,
         reviews_count = $5,
         last_checked_at = $6::timestamptz,
         last_error = $7,
         alert_sent_at = $8::timestamptz,
         updated_at = CURRENT_TIMESTAMP
       WHERE id = $1
       RETURNING *`,
      [
        competitorId,
        title,
        price,
        rating,
        reviews_count,
        now,
        last_error,
        alert_sent_at,
      ]
    );

    return mapRow({
      ...upd.rows[0],
      product_cost: row.product_cost,
      product_sku: row.product_sku,
      product_name: row.product_name,
    });
  }

  async refreshProduct(productId) {
    const list = await query(
      `SELECT id FROM product_competitors
       WHERE product_id = $1 AND marketplace IN ('wb', 'ym')
       ORDER BY id`,
      [productId]
    );
    const results = [];
    for (const row of list.rows || []) {
      try {
        results.push(await this.refreshOne(row.id));
      } catch (e) {
        logger.warn('[Competitors] refreshOne failed', { id: row.id, message: e?.message });
        results.push({ id: row.id, error: e?.message || String(e) });
      }
      await sleep(400);
    }
    return results;
  }

  /**
   * Цена с уже открытой карточки (расширение). Сервер страницу маркетплейса не запрашивает.
   * WB и Яндекс Маркет дальше обновляет почасовой обход. Ozon — только так.
   */
  async ingestFromExtension(productId, body, { profileId = null } = {}) {
    const parsed = parseCompetitorUrl(body?.url);
    const price = parseClientPrice(body?.price);
    if (price == null) {
      const err = new Error('На странице не найдена цена');
      err.statusCode = 400;
      throw err;
    }
    const title = cleanText(body?.title, 500);
    const rating = parseClientRating(body?.rating);
    const reviewsCount = parseClientReviews(body?.reviews_count);
    const stockQty = parseClientStock(body?.stock_qty);

    const prod = await query(
      `SELECT id, cost, sku, name, profile_id FROM products WHERE id = $1`,
      [productId]
    );
    if (!prod.rows?.length) {
      const err = new Error('Товар не найден');
      err.statusCode = 404;
      throw err;
    }
    const product = prod.rows[0];
    if (
      profileId != null &&
      product.profile_id != null &&
      Number(product.profile_id) !== Number(profileId)
    ) {
      const err = new Error('Товар не найден');
      err.statusCode = 404;
      throw err;
    }

    const existing = await query(
      `SELECT id FROM product_competitors
       WHERE product_id = $1 AND marketplace = $2
         AND (
           url = $3
           OR ($4::text IS NOT NULL AND external_id = $4)
         )
       ORDER BY id
       LIMIT 1`,
      [productId, parsed.marketplace, parsed.url, parsed.externalId]
    );

    let competitorId;
    let created = false;
    if (existing.rows?.length) {
      competitorId = existing.rows[0].id;
      if (parsed.url) {
        await query(`UPDATE product_competitors SET url = $2 WHERE id = $1 AND url IS DISTINCT FROM $2`, [
          competitorId,
          parsed.url,
        ]);
      }
    } else {
      const cnt = await this.countByMarketplace(productId, parsed.marketplace);
      if (cnt >= MAX_COMPETITORS_PER_MARKETPLACE) {
        const err = new Error(
          `Лимит: не больше ${MAX_COMPETITORS_PER_MARKETPLACE} конкурентов на ${parsed.marketplace.toUpperCase()}`
        );
        err.statusCode = 400;
        throw err;
      }
      try {
        const ins = await query(
          `INSERT INTO product_competitors (product_id, marketplace, url, external_id)
           VALUES ($1, $2, $3, $4)
           RETURNING id`,
          [productId, parsed.marketplace, parsed.url, parsed.externalId]
        );
        competitorId = ins.rows[0].id;
        created = true;
      } catch (e) {
        if (String(e?.code) === '23505') {
          const again = await query(
            `SELECT id FROM product_competitors
             WHERE product_id = $1 AND marketplace = $2 AND url = $3`,
            [productId, parsed.marketplace, parsed.url]
          );
          if (!again.rows?.length) throw e;
          competitorId = again.rows[0].id;
        } else {
          throw e;
        }
      }
    }

    const item = await this.applyClientSnapshot(competitorId, {
      title,
      price,
      rating,
      reviews_count: reviewsCount,
      stock_qty: stockQty,
    });
    return { created, item };
  }

  async ingestManyFromExtension(productId, items, opts = {}) {
    const list = Array.isArray(items) ? items.slice(0, 80) : [];
    const results = [];
    for (const item of list) {
      try {
        const out = await this.ingestFromExtension(productId, item, opts);
        results.push({
          ok: true,
          created: out.created,
          url: out.item?.url || item?.url || null,
          title: out.item?.title || null,
          price: out.item?.price ?? null,
        });
      } catch (e) {
        results.push({
          ok: false,
          url: item?.url || null,
          message: e?.message || String(e),
        });
      }
    }
    return {
      saved: results.filter((r) => r.ok).length,
      failed: results.filter((r) => !r.ok).length,
      results,
    };
  }

  async applyClientSnapshot(competitorId, snap) {
    const r = await query(
      `SELECT c.*, p.cost AS product_cost, p.sku AS product_sku, p.name AS product_name
       FROM product_competitors c
       JOIN products p ON p.id = c.product_id
       WHERE c.id = $1`,
      [competitorId]
    );
    const row = r.rows?.[0];
    if (!row) {
      const err = new Error('Конкурент не найден');
      err.statusCode = 404;
      throw err;
    }

    const now = new Date().toISOString();
    const title = snap.title || row.title;
    const price = snap.price != null ? Number(snap.price) : row.price != null ? Number(row.price) : null;
    let rating = row.rating != null ? Number(row.rating) : null;
    if (snap.rating != null && Number(snap.rating) > 0) rating = Number(snap.rating);
    let reviews_count = row.reviews_count != null ? Number(row.reviews_count) : null;
    if (snap.reviews_count != null && Number(snap.reviews_count) >= 0) {
      reviews_count = Number(snap.reviews_count);
    }
    const stock_qty =
      snap.stock_qty != null && Number.isFinite(Number(snap.stock_qty))
        ? Number(snap.stock_qty)
        : row.stock_qty != null
          ? Number(row.stock_qty)
          : null;

    const cost = row.product_cost != null ? Number(row.product_cost) : null;
    let alert_sent_at = row.alert_sent_at;
    const belowCost = cost != null && price != null && price < cost;
    if (belowCost) {
      if (!alert_sent_at) {
        await addRuntimeNotification({
          type: 'competitor_price_below_cost',
          severity: 'warn',
          source: 'product_competitors',
          marketplace: row.marketplace,
          title: 'Цена конкурента ниже себестоимости',
          message:
            `${row.product_sku || row.product_id}: конкурент ${row.marketplace.toUpperCase()} ` +
            `${price} ₽ < себестоимость ${cost} ₽` +
            (title ? ` («${String(title).slice(0, 80)}»)` : ''),
          meta: {
            product_id: Number(row.product_id),
            competitor_id: Number(row.id),
            url: `/products/${row.product_id}?tab=competitors`,
          },
        });
        alert_sent_at = now;
      }
    } else if (alert_sent_at) {
      alert_sent_at = null;
    }

    const upd = await query(
      `UPDATE product_competitors SET
         title = $2,
         price = $3,
         rating = $4,
         reviews_count = $5,
         stock_qty = $6,
         last_checked_at = $7::timestamptz,
         last_error = NULL,
         alert_sent_at = $8::timestamptz,
         updated_at = CURRENT_TIMESTAMP
       WHERE id = $1
       RETURNING *`,
      [competitorId, title, price, rating, reviews_count, stock_qty, now, alert_sent_at]
    );
    return mapRow({
      ...upd.rows[0],
      product_cost: row.product_cost,
      product_sku: row.product_sku,
      product_name: row.product_name,
    });
  }

  /**
   * Фоновый прогон всех ссылок (почасовой cron).
   */
  async refreshAll({ limit = 500, delayMs = 500 } = {}) {
    const r = await query(
      `SELECT id FROM product_competitors
       WHERE marketplace IN ('wb', 'ym')
       ORDER BY last_checked_at NULLS FIRST, id
       LIMIT $1`,
      [limit]
    );
    let ok = 0;
    let fail = 0;
    for (const row of r.rows || []) {
      try {
        const out = await this.refreshOne(row.id);
        if (out?.last_error && out.price == null) fail += 1;
        else ok += 1;
      } catch (e) {
        fail += 1;
        logger.warn('[Competitors] refreshAll item failed', {
          id: row.id,
          message: e?.message || String(e),
        });
      }
      await sleep(delayMs);
    }
    return { total: (r.rows || []).length, ok, fail };
  }
}

export default new ProductCompetitorsService();
