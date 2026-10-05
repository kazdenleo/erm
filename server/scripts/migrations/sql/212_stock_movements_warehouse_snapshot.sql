-- Снимок остатков по складу движения (наличие / в пути / резерв), независимо от других складов.
-- balance_after / incoming_after / reserved_after остаются итогами по товару на всех складах.
ALTER TABLE stock_movements ADD COLUMN IF NOT EXISTS wh_balance_after INTEGER;
ALTER TABLE stock_movements ADD COLUMN IF NOT EXISTS wh_incoming_after INTEGER;
ALTER TABLE stock_movements ADD COLUMN IF NOT EXISTS wh_reserved_after INTEGER;

COMMENT ON COLUMN stock_movements.wh_balance_after IS 'Наличие на складе warehouse_id после движения';
COMMENT ON COLUMN stock_movements.wh_incoming_after IS '«В пути» на склад warehouse_id после движения';
COMMENT ON COLUMN stock_movements.wh_reserved_after IS 'Резерв на складе warehouse_id после движения';
