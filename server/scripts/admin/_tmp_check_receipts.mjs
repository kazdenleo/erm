import { query, closePool } from '../../src/config/database.js';

const r = await query(`
  SELECT id, purchase_id, status, created_at, completed_at
  FROM purchase_receipts
  WHERE status IN ('in_progress','draft','open')
     OR (status = 'completed' AND completed_at > NOW() - INTERVAL '6 hours')
  ORDER BY id DESC
  LIMIT 20
`);
console.log(JSON.stringify(r.rows, null, 2));
await closePool();
