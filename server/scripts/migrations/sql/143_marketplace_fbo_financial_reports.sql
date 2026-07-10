-- Финансовые отчёты FBO с маркетплейсов (продажи и удержания по заказам).

CREATE TABLE IF NOT EXISTS marketplace_fbo_report_syncs (
  id BIGSERIAL PRIMARY KEY,
  profile_id BIGINT NOT NULL,
  marketplace TEXT NOT NULL,
  date_from DATE NOT NULL,
  date_to DATE NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending',
  error_message TEXT NULL,
  rows_imported INTEGER NOT NULL DEFAULT 0,
  created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  finished_at TIMESTAMPTZ NULL
);

CREATE INDEX IF NOT EXISTS marketplace_fbo_report_syncs_profile_created_idx
  ON marketplace_fbo_report_syncs (profile_id, created_at DESC);

CREATE INDEX IF NOT EXISTS marketplace_fbo_report_syncs_profile_period_idx
  ON marketplace_fbo_report_syncs (profile_id, marketplace, date_from, date_to);

CREATE TABLE IF NOT EXISTS marketplace_fbo_report_lines (
  id BIGSERIAL PRIMARY KEY,
  sync_id BIGINT NOT NULL REFERENCES marketplace_fbo_report_syncs(id) ON DELETE CASCADE,
  profile_id BIGINT NOT NULL,
  marketplace TEXT NOT NULL,
  operation_date DATE NULL,
  order_id TEXT NULL,
  posting_number TEXT NULL,
  sku TEXT NULL,
  product_name TEXT NULL,
  barcode TEXT NULL,
  quantity INTEGER NOT NULL DEFAULT 0,
  retail_amount NUMERIC(14, 2) NOT NULL DEFAULT 0,
  commission_amount NUMERIC(14, 2) NOT NULL DEFAULT 0,
  logistics_amount NUMERIC(14, 2) NOT NULL DEFAULT 0,
  storage_amount NUMERIC(14, 2) NOT NULL DEFAULT 0,
  penalty_amount NUMERIC(14, 2) NOT NULL DEFAULT 0,
  acquiring_amount NUMERIC(14, 2) NOT NULL DEFAULT 0,
  other_deductions NUMERIC(14, 2) NOT NULL DEFAULT 0,
  payout_amount NUMERIC(14, 2) NOT NULL DEFAULT 0,
  operation_type TEXT NULL,
  raw_json JSONB NULL
);

CREATE INDEX IF NOT EXISTS marketplace_fbo_report_lines_sync_idx
  ON marketplace_fbo_report_lines (sync_id);

CREATE INDEX IF NOT EXISTS marketplace_fbo_report_lines_profile_date_idx
  ON marketplace_fbo_report_lines (profile_id, operation_date DESC);

CREATE INDEX IF NOT EXISTS marketplace_fbo_report_lines_profile_sku_idx
  ON marketplace_fbo_report_lines (profile_id, sku);

CREATE INDEX IF NOT EXISTS marketplace_fbo_report_lines_posting_idx
  ON marketplace_fbo_report_lines (profile_id, posting_number);
