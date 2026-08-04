-- Снимок резерва на заказе: список заказов читает колонки без пересчёта журнала на каждый GET.

ALTER TABLE orders
  ADD COLUMN IF NOT EXISTS reserved_qty integer NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS reserve_need_qty integer NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS reserve_coverage text NOT NULL DEFAULT 'none',
  ADD COLUMN IF NOT EXISTS reserve_snapshot_at timestamptz NULL;

COMMENT ON COLUMN orders.reserved_qty IS
  'Снимок: сколько единиц зарезервировано под заказ (обновляется при reserve/unreserve).';
COMMENT ON COLUMN orders.reserve_need_qty IS
  'Снимок: сколько единиц нужно зарезервировать (qty или qty×комплектующие).';
COMMENT ON COLUMN orders.reserve_coverage IS
  'Снимок покрытия: none | on_hand | incoming.';
COMMENT ON COLUMN orders.reserve_snapshot_at IS
  'Когда снимок резерва последний раз пересчитан.';

ALTER TABLE orders
  DROP CONSTRAINT IF EXISTS orders_reserve_coverage_check;

ALTER TABLE orders
  ADD CONSTRAINT orders_reserve_coverage_check
  CHECK (reserve_coverage IN ('none', 'on_hand', 'incoming'));
