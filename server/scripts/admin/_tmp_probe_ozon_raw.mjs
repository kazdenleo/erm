import { query, closePool } from '../../src/config/database.js';

const sample = await query(
  `SELECT id, operation_date, operation_type, order_id, posting_number, sku,
          retail_amount, commission_amount, logistics_amount, payout_amount,
          raw_json
     FROM marketplace_fbs_report_lines
    WHERE profile_id = 1 AND marketplace = 'ozon'
      AND operation_date >= '2026-10-01'
    ORDER BY id DESC
    LIMIT 3`
);

const older = await query(
  `SELECT operation_type, count(*)::int AS n,
          count(*) FILTER (WHERE ABS(COALESCE(retail_amount,0))>0)::int AS with_retail,
          count(*) FILTER (WHERE ABS(COALESCE(payout_amount,0))>0)::int AS with_payout,
          count(*) FILTER (WHERE NULLIF(TRIM(posting_number),'') IS NOT NULL)::int AS with_posting
     FROM marketplace_fbs_report_lines
    WHERE profile_id = 1 AND marketplace = 'ozon'
    GROUP BY operation_type
    ORDER BY n DESC
    LIMIT 40`
);

const olderGood = await query(
  `SELECT id, operation_date, operation_type, order_id, posting_number, sku,
          retail_amount, commission_amount, payout_amount,
          left(raw_json::text, 400) AS raw_head
     FROM marketplace_fbs_report_lines
    WHERE profile_id = 1 AND marketplace = 'ozon'
      AND operation_type = 'OperationAgentDeliveredToCustomer'
    ORDER BY operation_date DESC
    LIMIT 3`
);

console.log(
  JSON.stringify(
    {
      sampleOct: sample.rows.map((r) => ({
        ...r,
        raw_json: r.raw_json,
      })),
      allTypes: older.rows,
      goodSamples: olderGood.rows,
    },
    null,
    2
  )
);
await closePool();
