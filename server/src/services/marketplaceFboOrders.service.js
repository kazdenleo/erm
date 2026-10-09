/**
 * Заказы FBO почти в реальном времени (в отличие от finance-отчётов, которые запаздывают на недели):
 * Ozon /v2/posting/fbo/list, WB Statistics /api/v1/supplier/orders (только «Склад WB»),
 * Яндекс FBY /v2/campaigns/{id}/stats/orders.
 */

import { query } from '../config/database.js';
import repositoryFactory from '../config/repository-factory.js';
import integrationsService from './integrations.service.js';
import logger from '../utils/logger.js';
import { ozonApiPostWithRetry } from '../utils/ozonSellerApi.js';
import { getFetchProxyAgent } from '../utils/fetchAgent.js';
import { getYandexHttpsAgent, formatYandexNetworkError } from '../utils/yandex-https-agent.js';
import {
  mapOzonPostings,
  mapWbOrders,
  mapYmOrders,
  ymdChunks,
} from '../utils/marketplaceFboOrdersMap.js';

const BACKFILL_DAYS = 90;
/** Окно повторной загрузки после backfill — чтобы подтянуть отмены и смену статусов. */
const REFRESH_DAYS = { ozon: 14, wb: 3, ym: 30 };
const CHUNK_DAYS = 30;
const OZON_PAGE = 1000;
const WB_STATS_API = 'https://statistics-api.wildberries.ru';
const WB_PAGE_MAX_ROWS = 80000;
const YM_API = 'https://api.partner.market.yandex.ru';
const YM_PAGE = 200;
const UPSERT_BATCH = 500;
const DAY_MS = 86400000;

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

function ymdMsk(d) {
  return d.toLocaleDateString('en-CA', { timeZone: 'Europe/Moscow' });
}

/** WB Statistics принимает dateFrom в МСК без смещения. */
function wbDateTimeMsk(d) {
  return d.toLocaleString('sv-SE', { timeZone: 'Europe/Moscow' }).replace(' ', 'T');
}

function dateChunks(from, to, days) {
  const out = [];
  let a = new Date(from);
  while (a < to) {
    const b = new Date(Math.min(a.getTime() + days * DAY_MS, to.getTime()));
    out.push([a, b]);
    a = b;
  }
  return out;
}

async function fetchOzonFboPostings({ profileId, organizationId, since, to }) {
  const postings = [];
  for (const [a, b] of dateChunks(since, to, CHUNK_DAYS)) {
    for (let offset = 0; offset < 100 * OZON_PAGE; offset += OZON_PAGE) {
      const r = await ozonApiPostWithRetry(
        '/v2/posting/fbo/list',
        {
          dir: 'ASC',
          filter: { since: a.toISOString(), to: b.toISOString() },
          limit: OZON_PAGE,
          offset,
          with: { analytics_data: true, financial_data: false },
        },
        { profileId, organizationId }
      );
      const list = Array.isArray(r?.result) ? r.result : r?.result?.postings || [];
      postings.push(...list);
      if (list.length < OZON_PAGE) break;
    }
  }
  return postings;
}

/** dateFrom у WB — по lastChangeDate: в ответ попадают и старые заказы, если у них сменился статус. */
async function fetchWbOrdersChangedSince(token, since) {
  const agent = getFetchProxyAgent();
  const rows = [];
  let cursor = wbDateTimeMsk(since);
  for (let page = 0; page < 10; page += 1) {
    const url = `${WB_STATS_API}/api/v1/supplier/orders?dateFrom=${encodeURIComponent(cursor)}&flag=0`;
    const resp = await fetch(url, {
      headers: { Authorization: token, Accept: 'application/json' },
      signal: AbortSignal.timeout(120000),
      ...(agent && { agent }),
    });
    if (resp.status === 429) {
      throw new Error('WB Statistics: лимит 1 запрос в минуту, повтор в следующий прогон');
    }
    if (!resp.ok) {
      const text = await resp.text().catch(() => '');
      throw new Error(`WB Statistics ${resp.status}${text ? `: ${text.slice(0, 200)}` : ''}`);
    }
    const data = await resp.json().catch(() => []);
    if (!Array.isArray(data) || !data.length) break;
    rows.push(...data);
    if (data.length < WB_PAGE_MAX_ROWS) break;
    cursor = data[data.length - 1].lastChangeDate;
    await sleep(61000);
  }
  return rows;
}

async function ymFetch(path, apiKey, { method = 'GET', body = null } = {}) {
  const agent = getYandexHttpsAgent();
  const url = `${YM_API}${path}`;
  let resp;
  try {
    resp = await fetch(url, {
      method,
      headers: {
        'Api-Key': apiKey,
        Accept: 'application/json',
        ...(body ? { 'Content-Type': 'application/json' } : {}),
      },
      signal: AbortSignal.timeout(60000),
      ...(agent && { agent }),
      ...(body ? { body: JSON.stringify(body) } : {}),
    });
  } catch (e) {
    throw new Error(formatYandexNetworkError(e, url));
  }
  if (!resp.ok) {
    const text = await resp.text().catch(() => '');
    throw new Error(`Яндекс.Маркет API ${resp.status}${text ? `: ${text.slice(0, 200)}` : ''}`);
  }
  return resp.json().catch(() => ({}));
}

async function resolveYmFbyCampaignIds(apiKey) {
  const data = await ymFetch('/v2/campaigns', apiKey);
  const campaigns = data?.campaigns ?? data?.result?.campaigns ?? [];
  return campaigns
    .filter((c) => String(c?.placementType ?? '').trim().toUpperCase() === 'FBY')
    .map((c) => Number(c?.id ?? c?.campaignId))
    .filter((id) => Number.isFinite(id) && id > 0);
}

async function fetchYmFbyOrders(apiKey, campaignId, fromYmd, toYmd) {
  const orders = [];
  for (const [a, b] of ymdChunks(fromYmd, toYmd, CHUNK_DAYS)) {
    let pageToken = null;
    for (let page = 0; page < 500; page += 1) {
      const qs = new URLSearchParams({ limit: String(YM_PAGE) });
      if (pageToken) qs.set('page_token', pageToken);
      const data = await ymFetch(`/v2/campaigns/${campaignId}/stats/orders?${qs}`, apiKey, {
        method: 'POST',
        body: { dateFrom: a, dateTo: b },
      });
      orders.push(...(data?.result?.orders || []));
      pageToken = data?.result?.paging?.nextPageToken || null;
      if (!pageToken) break;
    }
  }
  return orders;
}

async function upsertLines(profileId, organizationId, marketplace, lines) {
  for (let i = 0; i < lines.length; i += UPSERT_BATCH) {
    const batch = lines.slice(i, i + UPSERT_BATCH);
    const params = [];
    const values = batch.map((l) => {
      const base = params.length;
      params.push(
        profileId,
        organizationId,
        marketplace,
        l.order_id,
        l.line_key,
        l.offer_id,
        l.sku,
        l.product_name,
        l.quantity,
        Math.round(l.price * 100) / 100,
        l.status,
        l.is_cancelled,
        l.ordered_at,
        l.warehouse_name
      );
      return `(${Array.from({ length: 14 }, (_, k) => `$${base + k + 1}`).join(', ')})`;
    });
    await query(
      `INSERT INTO marketplace_fbo_orders
         (profile_id, organization_id, marketplace, order_id, line_key, offer_id, sku, product_name,
          quantity, price, status, is_cancelled, ordered_at, warehouse_name)
       VALUES ${values.join(', ')}
       ON CONFLICT (profile_id, marketplace, order_id, line_key) DO UPDATE SET
         organization_id = EXCLUDED.organization_id,
         offer_id = EXCLUDED.offer_id,
         sku = EXCLUDED.sku,
         product_name = EXCLUDED.product_name,
         quantity = EXCLUDED.quantity,
         price = EXCLUDED.price,
         status = EXCLUDED.status,
         is_cancelled = EXCLUDED.is_cancelled,
         ordered_at = EXCLUDED.ordered_at,
         warehouse_name = EXCLUDED.warehouse_name,
         updated_at = CURRENT_TIMESTAMP`,
      params
    );
  }
}

async function loadState(profileId, orgKey, marketplace) {
  const r = await query(
    `SELECT backfill_from FROM marketplace_fbo_orders_sync_state
      WHERE profile_id = $1 AND organization_id = $2 AND marketplace = $3`,
    [profileId, orgKey, marketplace]
  );
  return r.rows?.[0] || null;
}

async function saveState(profileId, orgKey, marketplace, { backfillFrom, status, error = null, rows = null }) {
  await query(
    `INSERT INTO marketplace_fbo_orders_sync_state
       (profile_id, organization_id, marketplace, backfill_from, last_synced_at, last_status, last_error, rows_last_sync)
     VALUES ($1, $2, $3, $4::date, CURRENT_TIMESTAMP, $5, $6, $7)
     ON CONFLICT (profile_id, organization_id, marketplace) DO UPDATE SET
       backfill_from = COALESCE(marketplace_fbo_orders_sync_state.backfill_from, EXCLUDED.backfill_from),
       last_synced_at = EXCLUDED.last_synced_at,
       last_status = EXCLUDED.last_status,
       last_error = EXCLUDED.last_error,
       rows_last_sync = EXCLUDED.rows_last_sync`,
    [profileId, orgKey, marketplace, backfillFrom, status, error ? String(error).slice(0, 1000) : null, rows]
  );
}

class MarketplaceFboOrdersService {
  constructor() {
    this.inProgress = false;
  }

  /** fetchLines возвращает null, если у МП нет ключей / FBY-кампании — тогда это не ошибка. */
  async _syncMarketplace(profileId, organizationId, marketplace, fetchLines) {
    const orgKey = organizationId ?? 0;
    const state = await loadState(profileId, orgKey, marketplace);
    const backfilled = state?.backfill_from != null;
    const now = new Date();
    const since = new Date(now.getTime() - (backfilled ? REFRESH_DAYS[marketplace] : BACKFILL_DAYS) * DAY_MS);
    try {
      const lines = await fetchLines({ since, now });
      if (lines == null) {
        await saveState(profileId, orgKey, marketplace, { backfillFrom: null, status: 'not_configured' });
        return { marketplace, skipped: true };
      }
      await upsertLines(profileId, organizationId, marketplace, lines);
      await saveState(profileId, orgKey, marketplace, {
        backfillFrom: backfilled ? null : ymdMsk(since),
        status: 'ok',
        rows: lines.length,
      });
      return { marketplace, rows: lines.length, backfill: !backfilled };
    } catch (e) {
      logger.warn(`[FBO Orders] ${marketplace} profile ${profileId} org ${orgKey}: ${e?.message || e}`);
      await saveState(profileId, orgKey, marketplace, { backfillFrom: null, status: 'error', error: e?.message || e });
      return { marketplace, error: e?.message || String(e) };
    }
  }

  async syncTarget({ profileId, organizationId = null }) {
    const opts = { profileId, organizationId };
    const results = [];

    results.push(
      await this._syncMarketplace(profileId, organizationId, 'ozon', async ({ since, now }) => {
        const cfg = await integrationsService.getMarketplaceConfig('ozon', opts);
        if (!(cfg?.client_id || cfg?.clientId) || !(cfg?.api_key || cfg?.apiKey)) return null;
        return mapOzonPostings(await fetchOzonFboPostings({ ...opts, since, to: now }));
      })
    );

    results.push(
      await this._syncMarketplace(profileId, organizationId, 'wb', async ({ since }) => {
        const cfg = await integrationsService.getMarketplaceConfig('wildberries', opts);
        const token = String(cfg?.api_key || cfg?.apiKey || '').trim();
        if (!token) return null;
        return mapWbOrders(await fetchWbOrdersChangedSince(token, since));
      })
    );

    results.push(
      await this._syncMarketplace(profileId, organizationId, 'ym', async ({ since, now }) => {
        const cfg = await integrationsService.getMarketplaceConfig('yandex', opts);
        const apiKey = integrationsService._normalizeYandexApiKey(cfg?.api_key ?? cfg?.apiKey);
        if (!apiKey) return null;
        const campaignIds = await resolveYmFbyCampaignIds(apiKey);
        if (!campaignIds.length) return null;
        const lines = [];
        for (const cid of campaignIds) {
          lines.push(...mapYmOrders(await fetchYmFbyOrders(apiKey, cid, ymdMsk(since), ymdMsk(now))));
        }
        return lines;
      })
    );

    return results;
  }

  async syncProfile(profileId) {
    const orgIds = await integrationsService.getOrganizationIdsWithMarketplaceIntegrations(profileId);
    const targets = orgIds.length ? orgIds : [null];
    const out = [];
    for (const organizationId of targets) {
      out.push({ organizationId, results: await this.syncTarget({ profileId, organizationId }) });
    }
    return out;
  }

  async syncAllProfiles() {
    if (!repositoryFactory.isUsingPostgreSQL()) return { skipped: true, reason: 'no_postgres' };
    if (this.inProgress) return { skipped: true, reason: 'in_progress' };
    this.inProgress = true;
    const started = Date.now();
    try {
      const profiles = await repositoryFactory.getProfilesRepository().findAll();
      let rows = 0;
      let errors = 0;
      for (const p of profiles || []) {
        const pid = Number(p?.id);
        if (!Number.isFinite(pid) || pid < 1) continue;
        try {
          for (const t of await this.syncProfile(pid)) {
            for (const r of t.results) {
              rows += r.rows || 0;
              if (r.error) errors += 1;
            }
          }
        } catch (e) {
          errors += 1;
          logger.warn(`[FBO Orders] profile ${pid} failed: ${e?.message || e}`);
        }
      }
      return { rows, errors, durationMs: Date.now() - started };
    } finally {
      this.inProgress = false;
    }
  }

  /** С какой даты по каждому МП живые данные полные и когда был последний успешный прогон. */
  async getCoverage(profileId) {
    const r = await query(
      `SELECT marketplace,
              to_char(MIN(backfill_from), 'YYYY-MM-DD') AS live_from,
              MAX(last_synced_at) FILTER (WHERE last_status = 'ok') AS last_synced_at
         FROM marketplace_fbo_orders_sync_state
        WHERE profile_id = $1 AND backfill_from IS NOT NULL
        GROUP BY marketplace`,
      [profileId]
    );
    const out = {};
    for (const row of r.rows || []) {
      out[row.marketplace] = { liveFrom: row.live_from, lastSyncedAt: row.last_synced_at };
    }
    return out;
  }
}

export default new MarketplaceFboOrdersService();
