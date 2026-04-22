-- Номер стикера при сборке (вводится при отметке «Собран»).
ALTER TABLE orders ADD COLUMN IF NOT EXISTS assembly_sticker_number TEXT;
