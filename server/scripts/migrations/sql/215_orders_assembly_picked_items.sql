-- Что сняли с полки при скан-сборке: [{ "productId": 1, "quantity": 2 }].
-- Пока заказ «Собран» (до отгрузки), эти количества вычитаются из «на полке».
ALTER TABLE orders ADD COLUMN IF NOT EXISTS assembly_picked_items JSONB;
