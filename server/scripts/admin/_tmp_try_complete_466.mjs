/**
 * Diagnose why purchase receipt 466 won't complete
 */
import { query, closePool } from '../../src/config/database.js';
import purchasesService from '../../src/services/purchases.service.js';
import chestnyZnakOps from '../../src/services/chestnyZnakOps.service.js';

const RID = 466;

async function main() {
  const head = await query(
    `SELECT r.id, r.status, r.purchase_id, r.created_by_user_id, r.extras_resolved,
            p.profile_id, p.warehouse_id, p.organization_id, p.status AS purchase_status
     FROM purchase_receipts r
     JOIN purchases p ON p.id = r.purchase_id
     WHERE r.id = $1`,
    [RID]
  );
  console.log('head', head.rows[0]);
  if (!head.rows[0]) return;
  const { purchase_id, profile_id, warehouse_id, organization_id, created_by_user_id, status } =
    head.rows[0];
  console.log('receipt status', status);

  const scanLines = (
    await query(`SELECT product_id, scanned_quantity FROM purchase_receipt_items WHERE receipt_id=$1`, [
      RID,
    ])
  ).rows;
  console.log(
    'scan lines',
    scanLines.length,
    'total qty',
    scanLines.reduce((s, r) => s + (Number(r.scanned_quantity) || 0), 0)
  );

  // CIS check alone
  try {
    await chestnyZnakOps.assertReceiptCisQty({
      receiptId: RID,
      profileId: profile_id,
      organizationId: organization_id,
      scanLines,
    });
    console.log('CIS assert: OK');
  } catch (e) {
    console.log('CIS assert FAIL', e.statusCode, e.message);
  }

  // Try complete as creator
  try {
    const res = await purchasesService.completeReceipt(RID, {
      profileId: profile_id,
      userId: created_by_user_id,
      warehouseId: warehouse_id,
    });
    console.log('complete OK', {
      status: res?.status,
      extras: res?.extras?.length,
      warehouseReceiptId: res?.warehouseReceiptId,
      stockProblems: res?.stockProblems?.length,
    });
  } catch (e) {
    console.log('complete FAIL', {
      statusCode: e.statusCode,
      code: e.code,
      message: e.message,
      stack: String(e.stack || '').split('\n').slice(0, 8),
    });
  }

  const after = await query(`SELECT status, completed_at FROM purchase_receipts WHERE id=$1`, [RID]);
  console.log('receipt after', after.rows[0]);
}

main()
  .catch((e) => {
    console.error('fatal', e);
    process.exitCode = 1;
  })
  .finally(() => closePool());
