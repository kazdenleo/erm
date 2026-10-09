-- Взаиморасчёты с поставщиками: ручные операции (оплаты и корректировки баланса).
-- Начисления берутся из складских документов: приёмка (+) и возврат поставщику (−).
BEGIN;

CREATE TABLE IF NOT EXISTS supplier_settlement_entries (
  id BIGSERIAL PRIMARY KEY,
  profile_id BIGINT NOT NULL REFERENCES profiles (id) ON DELETE CASCADE,
  supplier_id BIGINT NOT NULL REFERENCES suppliers (id) ON DELETE CASCADE,
  kind VARCHAR(20) NOT NULL CHECK (kind IN ('payment', 'adjustment')),
  amount NUMERIC(14, 2) NOT NULL CHECK (amount <> 0),
  occurred_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  comment TEXT NOT NULL DEFAULT '',
  created_by_user_id BIGINT NULL REFERENCES users (id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_supplier_settlement_entries_supplier
  ON supplier_settlement_entries (supplier_id, occurred_at);

CREATE INDEX IF NOT EXISTS idx_supplier_settlement_entries_profile
  ON supplier_settlement_entries (profile_id);

COMMENT ON TABLE supplier_settlement_entries IS 'Ручные операции взаиморасчётов с поставщиком';
COMMENT ON COLUMN supplier_settlement_entries.amount IS 'Изменение нашего долга поставщику: оплата < 0, корректировка ±';

COMMIT;
