-- Фикс: после «Вернуть в Новый» синхронизация с МП снова ставила «На сборке».
-- Метка времени: пользователь явно вернул заказ в «Новый», пока МП в сборке — держим new в ERP.
ALTER TABLE orders
  ADD COLUMN IF NOT EXISTS returned_to_new_at TIMESTAMP WITH TIME ZONE;

COMMENT ON COLUMN orders.returned_to_new_at IS 'Пользователь вернул заказ в «Новый» со сборки; синк не откатывает в in_assembly, пока статус МП не логистический';
