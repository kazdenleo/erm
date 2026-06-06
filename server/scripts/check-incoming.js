import { query } from '../src/config/database.js';

const p = await query('SELECT id, incoming_quantity, quantity FROM products WHERE id=100');
const pi = await query('SELECT * FROM purchase_items WHERE purchase_id=92');
console.log('product', p.rows[0]);
console.log('items', pi.rows);
process.exit(0);
