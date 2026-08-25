/**
 * Справочник брендов маркетплейсов (локальная копия API МП).
 */

import { query } from '../config/database.js';
import {
  brandNameNorm,
  normalizeBrandName,
  normalizeMpBrandMarketplace,
} from '../utils/marketplaceBrandDirectory.js';

class MarketplaceBrandDirectoryRepositoryPG {
  async search({ profileId, marketplace, q, limit = 50 } = {}) {
    const pid = Number(profileId);
    const mp = normalizeMpBrandMarketplace(marketplace);
    if (!Number.isFinite(pid) || pid < 1 || !mp) return [];
    const nq = brandNameNorm(q);
    if (!nq) return [];
    const cap = Math.min(Math.max(Number(limit) || 50, 1), 80);
    const like = `%${nq.replace(/[%_\\]/g, '')}%`;
    const r = await query(
      `SELECT name, mp_brand_id AS id
       FROM marketplace_brand_directory
       WHERE profile_id = $1
         AND marketplace = $2
         AND name_norm LIKE $3
       ORDER BY
         CASE
           WHEN name_norm = $4 THEN 0
           WHEN name_norm LIKE $5 THEN 1
           ELSE 2
         END,
         name
       LIMIT $6`,
      [pid, mp, like, nq, `${nq}%`, cap]
    );
    return (r.rows || []).map((row) => ({
      name: String(row.name || '').trim(),
      id: row.id != null && String(row.id).trim() !== '' ? String(row.id) : null,
    }));
  }

  async upsertMany(profileId, marketplace, items = [], source = 'api') {
    const pid = Number(profileId);
    const mp = normalizeMpBrandMarketplace(marketplace);
    if (!Number.isFinite(pid) || pid < 1 || !mp) return 0;
    let saved = 0;
    for (const raw of items || []) {
      const name = normalizeBrandName(raw?.name);
      if (!name) continue;
      const nameNorm = brandNameNorm(name);
      const mpId =
        raw?.id != null && String(raw.id).trim() !== '' ? String(raw.id).trim() : null;
      const meta = raw?.meta != null ? JSON.stringify(raw.meta) : null;
      await query(
        `INSERT INTO marketplace_brand_directory
           (profile_id, marketplace, mp_brand_id, name, name_norm, source, meta, synced_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb, CURRENT_TIMESTAMP)
         ON CONFLICT (profile_id, marketplace, name_norm) DO UPDATE SET
           mp_brand_id = COALESCE(EXCLUDED.mp_brand_id, marketplace_brand_directory.mp_brand_id),
           name = EXCLUDED.name,
           source = EXCLUDED.source,
           meta = COALESCE(EXCLUDED.meta, marketplace_brand_directory.meta),
           synced_at = CURRENT_TIMESTAMP`,
        [pid, mp, mpId, name, nameNorm, source || 'api', meta]
      );
      saved += 1;
    }
    return saved;
  }
}

export default new MarketplaceBrandDirectoryRepositoryPG();
