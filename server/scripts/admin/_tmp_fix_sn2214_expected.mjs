/**
 * Purchase 514 / SN-2214: expected 37, received 15, receipt 466 scanned 60.
 * Bump expected to 15+60=75 so remain=60 matches scan (no false overscan),
 * and raise incoming by the same delta.
 */
import { query, getClient, closePool } from '../../src/config/database.js';
import stockMovementsRepositoryPG from '../../src/repositories/stock_movements.repository.pg.js';

const PURCHASE_ID = 514;
const PRODUCT_ID = 553; // SN-2214
const RECEIPT_ID = 466;

async function main() {
  const client = await getClient();
  try {
    await client.query('BEGIN');
    const pi = await client.query(
      `SELECT expected_quantity, received_quantity FROM purchase_items
       WHERE purchase_id=$1 AND product_id=$2 FOR UPDATE`,
      [PURCHASE_ID, PRODUCT_ID]
    );
    const row = pi.rows[0];
    if (!row) throw new Error('purchase item not found');
    const expected = Math.max(0, Number(row.expected_quantity) || 0);
    const received = Math.max(0, Number(row.received_quantity) || 0);

    const scan = await client.query(
      `SELECT scanned_quantity FROM purchase_receipt_items
       WHERE receipt_id=$1 AND product_id=$2`,
      [RECEIPT_ID, PRODUCT_ID]
    );
    const scanned = Math.max(0, Number(scan.rows[0]?.scanned_quantity) || 0);
    if (scanned <= 0) throw new Error('no scanned qty in receipt');

    const newExpected = received + scanned; // 15+60=75
    const delta = newExpected - expected;
    console.log({ expected, received, scanned, newExpected, delta });
    if (delta === 0) {
      console.log('already aligned');
      await client.query('ROLLBACK');
      return;
    }
    if (delta < 0) throw new Error('new expected lower than current — refuse');

    await client.query(
      `UPDATE purchase_items
       SET expected_quantity=$1, updated_at=CURRENT_TIMESTAMP
       WHERE purchase_id=$2 AND product_id=$3`,
      [newExpected, PURCHASE_ID, PRODUCT_ID]
    );

    const pr = await client.query(
      `SELECT incoming_quantity FROM products WHERE id=$1 FOR UPDATE`,
      [PRODUCT_ID]
    );
    const incoming = Math.max(0, Number(pr.rows[0]?.incoming_quantity) || 0);
    const newIncoming = incoming + delta;
    await client.query(
      `UPDATE products SET incoming_quantity=$1, updated_at=CURRENT_TIMESTAMP WHERE id=$2`,
      [newIncoming, PRODUCT_ID]
    );
    await stockMovementsRepositoryPG.insertSnapshotAfterProduct(client, {
      productId: PRODUCT_ID,
      type: 'incoming',
      quantityChange: delta,
      reason: `Дозаполнение ожидания по закупке №${PURCHASE_ID} под факт скана приёмки №${RECEIPT_ID}`,
      meta: {
        purchase_id: PURCHASE_ID,
        purchase_receipt_id: RECEIPT_ID,
        expected_before: expected,
        expected_after: newExpected,
        admin_align_scan: true,
      },
      warehouseId: 6,
      profileId: 6,
    });

    await client.query('COMMIT');
    console.log('ok', { newExpected, incomingBefore: incoming, newIncoming });
  } catch (e) {
    try {
      await client.query('ROLLBACK');
    } catch {
      /* ignore */
    }
    throw e;
  } finally {
    client.release();
  }
}

main()
  .catch((e) => {
    console.error(e);
    process.exitCode = 1;
  })
  .finally(() => closePool());
