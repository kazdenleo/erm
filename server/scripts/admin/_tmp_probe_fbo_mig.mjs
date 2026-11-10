import 'dotenv/config';
import { query } from '../../src/config/database.js';

const tables = await query(
  `SELECT table_name FROM information_schema.tables
   WHERE table_schema='public' AND table_name LIKE '%migration%'`
);
console.log('mig_tables', tables.rows);

for (const t of tables.rows) {
  const cols = await query(
    `SELECT column_name FROM information_schema.columns WHERE table_name=$1`,
    [t.table_name]
  );
  console.log(t.table_name, cols.rows.map((c) => c.column_name));
  try {
    const rows = await query(
      `SELECT * FROM ${t.table_name} WHERE CAST(${cols.rows[0].column_name} AS text) ILIKE '%239%' OR CAST(${cols.rows[0].column_name} AS text) ILIKE '%198_fbo%' OR CAST(${cols.rows[0].column_name} AS text) ILIKE '%packed%' ORDER BY 1 DESC LIMIT 10`
    );
    console.log('sample', rows.rows);
  } catch (e) {
    console.log('skip', e.message);
  }
}

const cols = await query(
  `SELECT column_name FROM information_schema.columns
   WHERE table_name='fbo_supplies' AND column_name IN ('last_collect_at','last_pack_at')`
);
console.log('activity_cols', cols.rows);

const chk = await query(
  `SELECT pg_get_constraintdef(oid) AS def
   FROM pg_constraint
   WHERE conname='fbo_supplies_status_check'`
);
console.log('status_check', chk.rows);

process.exit(0);
