-- Migration: 201_fbo_collect_kit_progress.sql
-- Прогресс скана комплектующих до полной сборки 1 комплекта (печать этикетки)

BEGIN;

ALTER TABLE fbo_supply_items
  ADD COLUMN IF NOT EXISTS collect_component_progress JSONB NOT NULL DEFAULT '{}'::jsonb;

COMMENT ON COLUMN fbo_supply_items.collect_component_progress IS
  'Счётчики сканов комплектующих к следующему комплекту: { "componentProductId": qty }. Печать этикетки — только когда набор полон или отсканирован SKU комплекта.';

COMMIT;
