-- Область категорий инвентаризации (NULL / [] = весь склад).
ALTER TABLE inventory_sessions
  ADD COLUMN IF NOT EXISTS category_ids JSONB NULL;

COMMENT ON COLUMN inventory_sessions.category_ids IS
  'ID категорий user_categories, выбранных при инвентаризации (без потомков в JSON; обнуление учитывает дерево). NULL — весь склад.';
