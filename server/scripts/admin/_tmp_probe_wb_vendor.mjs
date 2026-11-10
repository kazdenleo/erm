import 'dotenv/config';
import { query, closePool } from '../../src/config/database.js';
const r = await query(`SELECT id, sku, mp_wb_vendor_code FROM products WHERE id=822`);
console.log(r.rows[0]);
await closePool();
