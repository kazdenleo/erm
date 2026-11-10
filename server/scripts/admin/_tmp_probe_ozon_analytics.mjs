import { query, closePool } from '../../src/config/database.js';

const period = await query(
  `SELECT count(*)::int AS n,
          min(operation_date) AS dmin,
          max(operation_date) AS dmax,
          count(*) FILTER (WHERE operation_date >= '2026-10-01' AND operation_date <= '2026-10-28')::int AS in_oct
     FROM marketplace_fbs_report_lines
    WHERE profile_id = 1 AND marketplace = 'ozon'`
);

const types = await query(
  `SELECT operation_type, count(*)::int AS n
     FROM marketplace_fbs_report_lines
    WHERE profile_id = 1 AND marketplace = 'ozon'
      AND operation_date >= '2026-10-01' AND operation_date <= '2026-10-28'
    GROUP BY operation_type
    ORDER BY n DESC
    LIMIT 30`
);

const sample = await query(
  `SELECT id, operation_date, order_id, posting_number, sku, product_name, operation_type,
          quantity, retail_amount, commission_amount, logistics_amount, payout_amount,
          product_id
     FROM marketplace_fbs_report_lines
    WHERE profile_id = 1 AND marketplace = 'ozon'
      AND operation_date >= '2026-10-01' AND operation_date <= '2026-10-28'
    ORDER BY operation_date DESC, id DESC
    LIMIT 15`
);

const saleLike = await query(
  `SELECT count(*)::int AS n
     FROM marketplace_fbs_report_lines
    WHERE profile_id = 1 AND marketplace = 'ozon'
      AND operation_date >= '2026-10-01' AND operation_date <= '2026-10-28'
      AND (
        operation_type = 'OperationAgentDeliveredToCustomer'
        OR operation_type ILIKE '%DeliveredToCustomer%'
        OR operation_type ILIKE '%продажа%'
        OR operation_type ILIKE '%sale%'
      )`
);

const profiles = await query(
  `SELECT profile_id, marketplace, count(*)::int AS n,
          min(operation_date) AS dmin, max(operation_date) AS dmax
     FROM marketplace_fbs_report_lines
    WHERE marketplace IN ('ozon','wb','wildberries','ym','yandex')
    GROUP BY profile_id, marketplace
    ORDER BY profile_id, marketplace`
);

const fbo = await query(
  `SELECT count(*)::int AS n,
          min(operation_date) AS dmin, max(operation_date) AS dmax
     FROM marketplace_fbo_report_lines
    WHERE profile_id = 1 AND marketplace = 'ozon'
      AND operation_date >= '2026-10-01' AND operation_date <= '2026-10-28'`
).catch((e) => ({ rows: [{ err: e.message }] }));

console.log(
  JSON.stringify(
    {
      period: period.rows[0],
      typesOct: types.rows,
      saleLike: saleLike.rows[0],
      sample: sample.rows,
      byProfileMp: profiles.rows,
      fboOct: fbo.rows[0],
    },
    null,
    2
  )
);
await closePool();
