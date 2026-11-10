import { query, closePool } from '../../src/config/database.js';

const r = await query(
  `SELECT data_type, udt_name FROM information_schema.columns
   WHERE table_name='fbo_supplies' AND column_name='status'`
);
console.log('col', r.rows);
const c = await query(
  `SELECT conname, pg_get_constraintdef(oid) AS def
   FROM pg_constraint WHERE conrelid='fbo_supplies'::regclass AND contype='c'`
);
console.log('checks', c.rows);
await closePool();
