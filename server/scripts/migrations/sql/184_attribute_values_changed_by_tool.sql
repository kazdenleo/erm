-- Источник значения атрибута: стратегия / мин. цены vs ручной ввод.
ALTER TABLE product_attribute_values
  ADD COLUMN IF NOT EXISTS changed_by_tool BOOLEAN NOT NULL DEFAULT false;

COMMENT ON COLUMN product_attribute_values.changed_by_tool IS
  'true = значение записала стратегия ценообразования или обновление мин. цен';
