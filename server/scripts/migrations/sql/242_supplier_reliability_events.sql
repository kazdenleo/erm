-- События надёжности поставщика: отказы API и опоздания приёмки.
BEGIN;

CREATE TABLE IF NOT EXISTS supplier_reliability_events (
  id BIGSERIAL PRIMARY KEY,
  profile_id BIGINT NULL,
  supplier_id BIGINT NOT NULL REFERENCES suppliers(id) ON DELETE CASCADE,
  event_type TEXT NOT NULL,
  purchase_id BIGINT NULL,
  product_id BIGINT NULL,
  meta JSONB NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT supplier_reliability_events_type_chk CHECK (
    event_type IN (
      'submit_ok',
      'submit_reject',
      'submit_partial',
      'late_delivery',
      'on_time_delivery'
    )
  )
);

CREATE INDEX IF NOT EXISTS idx_supplier_reliability_events_supplier_created
  ON supplier_reliability_events (supplier_id, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_supplier_reliability_events_profile_created
  ON supplier_reliability_events (profile_id, created_at DESC)
  WHERE profile_id IS NOT NULL;

COMMENT ON TABLE supplier_reliability_events IS
  'Отказы Basket_Add / частичный приём и опоздания относительно planned_delivery_date';

COMMIT;
