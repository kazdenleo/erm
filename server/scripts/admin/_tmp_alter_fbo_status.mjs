import { query, closePool } from '../../src/config/database.js';

await query(`ALTER TABLE fbo_supplies DROP CONSTRAINT IF EXISTS fbo_supplies_status_check`);
await query(`
  ALTER TABLE fbo_supplies
  ADD CONSTRAINT fbo_supplies_status_check
  CHECK (status::text = ANY (ARRAY[
    'new'::varchar,
    'collecting'::varchar,
    'packing'::varchar,
    'packed'::varchar,
    'ready_for_supply'::varchar,
    'shipped'::varchar,
    'closed'::varchar,
    'return'::varchar
  ]::text[]))
`);
console.log('status check updated');
const c = await query(
  `SELECT pg_get_constraintdef(oid) AS def
   FROM pg_constraint WHERE conname='fbo_supplies_status_check'`
);
console.log(c.rows[0]?.def);
await closePool();
