-- Migration: 017_fix_category_mappings.sql
-- Description: Исправление типа category_id в category_mappings для связи с categories

BEGIN;

-- Меняем тип category_id на BIGINT и добавляем внешний ключ
ALTER TABLE category_mappings 
  DROP CONSTRAINT IF EXISTS category_mappings_category_id_fkey,
  ALTER COLUMN category_id TYPE BIGINT USING category_id::BIGINT,
  ADD CONSTRAINT category_mappings_category_id_fkey 
    FOREIGN KEY (category_id) REFERENCES categories(id) ON DELETE CASCADE;

COMMIT;

