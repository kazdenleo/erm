/**
 * Run on VPS from /opt/erm/server
 */
import fs from 'fs';
import pg from 'pg';

function loadEnv(path) {
  const out = {};
  for (const line of fs.readFileSync(path, 'utf8').split(/\n/)) {
    const t = line.trim();
    if (!t || t.startsWith('#')) continue;
    const i = t.indexOf('=');
    if (i < 0) continue;
    out[t.slice(0, i).trim()] = t.slice(i + 1).trim();
  }
  return out;
}

const env = loadEnv('/opt/erm/server/.env');
const pool = new pg.Pool({
  host: env.DB_HOST || '127.0.0.1',
  port: Number(env.DB_PORT || 5432),
  database: env.DB_NAME,
  user: env.DB_USER,
  password: env.DB_PASSWORD,
});

const counts = await pool.query(`
  SELECT profile_id, marketplace,
         COUNT(*)::int AS total,
         COUNT(*) FILTER (WHERE answer_text IS NULL OR TRIM(COALESCE(answer_text,'')) = '')::int AS needing_reply,
         MAX(synced_at) AS last_synced,
         MAX(source_created_at) AS last_review_at
  FROM marketplace_reviews
  GROUP BY profile_id, marketplace
  ORDER BY profile_id, marketplace
`);
console.log('marketplace_reviews counts', counts.rows);

const recent = await pool.query(`
  SELECT id, profile_id, marketplace, external_id, rating,
         LEFT(COALESCE(body,''), 60) AS body,
         synced_at, source_created_at, created_at
  FROM marketplace_reviews
  ORDER BY synced_at DESC NULLS LAST, id DESC
  LIMIT 15
`);
console.log('recent', recent.rows);

const envFlags = {
  REVIEWS_SYNC_ENABLED: env.REVIEWS_SYNC_ENABLED ?? '(default on)',
  REVIEWS_SYNC_CRON: env.REVIEWS_SYNC_CRON ?? '(default hourly)',
  NODE_ENV: env.NODE_ENV,
};
console.log('env', envFlags);

await pool.end();
