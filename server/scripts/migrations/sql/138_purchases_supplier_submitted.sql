-- Идемпотентность отправки закупки поставщику (Moskvorechie, Mikado и др.).

BEGIN;

ALTER TABLE purchases
  ADD COLUMN IF NOT EXISTS supplier_submitted_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS supplier_order_ref VARCHAR(255);

COMMENT ON COLUMN purchases.supplier_submitted_at IS 'Когда закупка успешно отправлена в API поставщика';
COMMENT ON COLUMN purchases.supplier_order_ref IS 'Номер/ID заказа у поставщика (если вернул API)';

CREATE INDEX IF NOT EXISTS idx_purchases_supplier_submitted_at
  ON purchases (supplier_id, supplier_submitted_at)
  WHERE supplier_submitted_at IS NOT NULL;

COMMIT;
