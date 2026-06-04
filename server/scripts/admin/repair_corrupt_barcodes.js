/**
 * Удалить битые штрихкоды ([object Object] и т.п.) из barcodes.
 * Запуск из server/: node scripts/admin/repair_corrupt_barcodes.js
 */

import { query } from '../../src/config/database.js';
import { coerceBarcodeString, isCorruptBarcodeString } from '../../src/utils/productBarcodes.js';

async function main() {
  const r = await query(`SELECT id, product_id, barcode FROM barcodes ORDER BY id`);
  const toDelete = [];
  const toFix = [];

  for (const row of r.rows || []) {
    const fixed = coerceBarcodeString(row.barcode);
    const raw = String(row.barcode ?? '').trim();
    if (!fixed || isCorruptBarcodeString(raw) || isCorruptBarcodeString(fixed)) {
      toDelete.push(row);
      continue;
    }
    if (fixed !== raw) {
      toFix.push({ id: row.id, product_id: row.product_id, from: raw, to: fixed });
    }
  }

  console.log(`Всего строк barcodes: ${(r.rows || []).length}`);
  console.log(`Удалить (пустые/битые): ${toDelete.length}`);
  console.log(`Исправить значение: ${toFix.length}`);

  for (const row of toDelete) {
    await query(`DELETE FROM barcodes WHERE id = $1`, [row.id]);
    console.log(`  DELETE product_id=${row.product_id} barcode=${JSON.stringify(row.barcode)}`);
  }

  for (const row of toFix) {
    const dup = await query(
      `SELECT id FROM barcodes WHERE barcode = $1 AND product_id <> $2 LIMIT 1`,
      [row.to, row.product_id]
    );
    if (dup.rows[0]) {
      await query(`DELETE FROM barcodes WHERE id = $1`, [row.id]);
      console.log(`  DELETE duplicate fix product_id=${row.product_id} ${row.from} -> ${row.to} (занят)`);
    } else {
      await query(`UPDATE barcodes SET barcode = $1 WHERE id = $2`, [row.to, row.id]);
      console.log(`  UPDATE product_id=${row.product_id} ${row.from} -> ${row.to}`);
    }
  }

  console.log('Готово.');
  process.exit(0);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
