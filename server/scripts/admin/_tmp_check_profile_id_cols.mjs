import pool, { query } from '../../src/config/database.js';

const tables = [
  'brands',
  'category_label_templates',
  'packaging_label_templates',
  'cell_label_templates',
  'category_rich_content_templates',
  'category_video_cover_templates',
  'employee_tasks',
  'fbo_purchase_calc_sessions',
  'fbo_supplies',
  'integrations',
  'inventory_sessions',
  'marketplace_fbo_report_lines',
  'marketplace_fbo_report_syncs',
  'marketplace_fbs_report_lines',
  'marketplace_fbs_report_syncs',
  'marketplace_inventory_snapshots',
  'marketplace_price_changes',
  'marketplace_questions',
  'marketplace_return_claims',
  'marketplace_reviews',
  'order_fulfillment_lines',
  'orders',
  'organizations',
  'ozon_ads_sku_stats',
  'ads_campaigns',
  'ads_campaign_products',
  'ads_sku_stats',
  'ads_sku_stats_daily',
  'ads_sync_runs',
  'ads_action_log',
  'ads_automation_rules',
  'ads_automation_runs',
  'pricing_strategies',
  'products',
  'purchases',
  'question_answer_templates',
  'review_auto_reply_rules',
  'review_reply_templates',
  'stock_movements',
  'supplier_returns',
  'supplier_settlement_entries',
  'suppliers',
  'support_inquiries',
  'user_categories',
  'users',
  'warehouse_suppliers',
  'warehouses',
  'wb_fbo_forecast_snapshots',
];

const exist = await query(
  `SELECT table_name
   FROM information_schema.tables
   WHERE table_schema = 'public' AND table_name = ANY($1::text[])`,
  [tables]
);
const existSet = new Set(exist.rows.map((r) => r.table_name));

const cols = await query(
  `SELECT table_name
   FROM information_schema.columns
   WHERE table_schema = 'public'
     AND column_name = 'profile_id'
     AND table_name = ANY($1::text[])`,
  [tables]
);
const have = new Set(cols.rows.map((r) => r.table_name));

const noTable = tables.filter((t) => !existSet.has(t));
const noCol = tables.filter((t) => existSet.has(t) && !have.has(t));
console.log(JSON.stringify({ noTable, noCol }, null, 2));
await pool.end();
