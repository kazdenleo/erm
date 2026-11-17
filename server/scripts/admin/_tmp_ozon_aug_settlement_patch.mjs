/**
 * Временный патч ОПиУ Ozon за август 2026 (profile 1) по «Отчёту о взаиморасчётах»,
 * пока Api-Key Ozon невалиден и /v2/finance/realization недоступен.
 *
 * Эталон (Зеленоглазое такси, авг 2026):
 *  - Отчёт о реализации:         181 781.52  (выручка; выкупы НЕ входят)
 *  - Акт выполненных работ:        61 704.81
 *  - Отчёт о перевыставлении:       6 799.35
 *  - Отчёт по штрафам:              1 374.57
 *  - Акты страховой премии:           153.32 (компенсация)
 */
import 'dotenv/config';
import pg from 'pg';

const PROFILE_ID = 1;
const FROM = '2026-08-01';
const TO = '2026-09-01';
const OP_DATE = '2026-08-31';

const REALIZATION = 181781.52;
const SOLD = REALIZATION;
const ACT = 61704.81;
const REINVOICE = 6799.35;
const PENALTY = 1374.57;
// Акты страховой премии — компенсация за утерю/порчу (доход), не «прочие удержания».
const INSURANCE_COMPENSATION = 153.32;

const c = new pg.Client({
  host: process.env.DB_HOST || 'localhost',
  port: Number(process.env.DB_PORT || 5432),
  database: process.env.DB_NAME || 'erp_system',
  user: process.env.DB_USER || 'postgres',
  password: process.env.DB_PASSWORD || '',
});
await c.connect();
await c.query('BEGIN');

try {
  // Убираем предыдущий патч, если уже ставили.
  await c.query(
    `DELETE FROM marketplace_fbs_report_lines
     WHERE profile_id = $1 AND marketplace = 'ozon'
       AND operation_date >= $2::date AND operation_date < $3::date
       AND (
         operation_type = 'OzonMutualSettlementPatch'
         OR (product_name = 'Отчёт о взаиморасчётах (патч)' AND raw_json->>'source' = 'ozon_mutual_settlement')
       )`,
    [PROFILE_ID, FROM, TO]
  );

  // Обнуляем денежные поля старых строк (цифры ОПиУ — из взаиморасчётов).
  // quantity / product_id НЕ трогаем: себестоимость считается по шт × cost карточки.
  for (const table of ['marketplace_fbs_report_lines', 'marketplace_fbo_report_lines']) {
    await c.query(
      `UPDATE ${table}
       SET retail_amount = 0,
           commission_amount = 0,
           logistics_amount = 0,
           storage_amount = 0,
           penalty_amount = 0,
           acquiring_amount = 0,
           other_deductions = 0,
           payout_amount = 0,
           raw_json = CASE
             WHEN raw_json IS NULL THEN NULL
             ELSE (raw_json
               || jsonb_build_object(
                 'accruals_for_sale', 0,
                 'sale_commission', 0,
                 'amount', 0,
                 'services', '[]'::jsonb,
                 'delivery_charge', 0,
                 'return_delivery_charge', 0,
                 '_settlement_patched', true
               ))
           END
       WHERE profile_id = $1 AND marketplace = 'ozon'
         AND operation_date >= $2::date AND operation_date < $3::date
         AND NOT (
           COALESCE(product_name, '') = 'Отчёт о взаиморасчётах (патч)'
           AND COALESCE(raw_json->>'source', '') = 'ozon_mutual_settlement'
         )`,
      [PROFILE_ID, FROM, TO]
    );
  }

  const sync = await c.query(
    `INSERT INTO marketplace_fbs_report_syncs (profile_id, marketplace, date_from, date_to, status, rows_imported)
     VALUES ($1, 'ozon', $2::date, ($3::date - 1), 'done', 1)
     RETURNING id`,
    [PROFILE_ID, FROM, TO]
  );
  const syncId = sync.rows[0].id;

  await c.query(
    `INSERT INTO marketplace_fbs_report_lines (
       sync_id, profile_id, marketplace, operation_date, order_id, posting_number,
       sku, product_name, barcode, product_id, quantity,
       retail_amount, commission_amount, logistics_amount, storage_amount,
       penalty_amount, acquiring_amount, other_deductions, payout_amount,
       operation_type, raw_json
     ) VALUES (
       $1, $2, 'ozon', $3::date, NULL, NULL,
       NULL, 'Отчёт о взаиморасчётах (патч)', NULL, NULL, 0,
       $4, $5, $6, 0,
       $7, 0, $8, $9,
       'OperationAgentDeliveredToCustomer', $10::jsonb
     )`,
    [
      syncId,
      PROFILE_ID,
      OP_DATE,
      SOLD,
      ACT,
      REINVOICE,
      PENALTY,
      -INSURANCE_COMPENSATION, // other_deductions < 0 → компенсация в ОПиУ
      Math.round((SOLD - ACT - REINVOICE - PENALTY + INSURANCE_COMPENSATION) * 100) / 100,
      JSON.stringify({
        source: 'ozon_mutual_settlement',
        _settlement_patched: true,
        period: '2026-08',
        operation_type: 'OperationAgentDeliveredToCustomer',
        accruals_for_sale: SOLD,
        sale_commission: -ACT,
        amount: Math.round((SOLD - ACT - REINVOICE - PENALTY + INSURANCE_COMPENSATION) * 100) / 100,
        // Колонки logistics/penalty/other не восстанавливаются из extract — skip в recategorize.
        docs: {
          realization: REALIZATION,
          sold: SOLD,
          act: ACT,
          reinvoice: REINVOICE,
          penalty: PENALTY,
          insuranceCompensation: INSURANCE_COMPENSATION,
          // выкупы во взаиморасчётах есть, но в выручку ОПиУ не входят
        },
      }),
    ]
  );

  const check = await c.query(
    `SELECT
       round(sum(coalesce(retail_amount,0))::numeric,2) sold,
       round(sum(coalesce(commission_amount,0))::numeric,2) comm,
       round(sum(coalesce(logistics_amount,0))::numeric,2) log,
       round(sum(coalesce(penalty_amount,0))::numeric,2) pen,
       round(sum(coalesce(other_deductions,0))::numeric,2) oth
     FROM (
       SELECT retail_amount, commission_amount, logistics_amount, penalty_amount, other_deductions
       FROM marketplace_fbs_report_lines
       WHERE profile_id=$1 AND marketplace='ozon'
         AND operation_date>=$2::date AND operation_date<$3::date
       UNION ALL
       SELECT retail_amount, commission_amount, logistics_amount, penalty_amount, other_deductions
       FROM marketplace_fbo_report_lines
       WHERE profile_id=$1 AND marketplace='ozon'
         AND operation_date>=$2::date AND operation_date<$3::date
     ) t`,
    [PROFILE_ID, FROM, TO]
  );

  await c.query('COMMIT');
  console.log('patched sync', syncId, 'totals', check.rows[0]);
} catch (e) {
  await c.query('ROLLBACK');
  console.error(e);
  process.exitCode = 1;
} finally {
  await c.end();
}
