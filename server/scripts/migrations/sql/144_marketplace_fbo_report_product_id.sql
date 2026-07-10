-- Связь строк FBO-отчёта с товарами каталога ERP.

ALTER TABLE marketplace_fbo_report_lines
  ADD COLUMN IF NOT EXISTS product_id BIGINT NULL REFERENCES products(id) ON DELETE SET NULL;

CREATE INDEX IF NOT EXISTS marketplace_fbo_report_lines_product_idx
  ON marketplace_fbo_report_lines (profile_id, product_id)
  WHERE product_id IS NOT NULL;
