-- Migration: 109_barcodes_marketplaces.sql
-- Маркетплейсы для штрихкода: ozon, wb, ym. Пустой массив — внутренний ШК.

ALTER TABLE barcodes
  ADD COLUMN IF NOT EXISTS marketplaces JSONB NOT NULL DEFAULT '[]'::jsonb;

COMMENT ON COLUMN barcodes.marketplaces IS 'Маркетплейсы для печати этикеток FBO: ozon, wb, ym. [] — внутренний ШК';

CREATE INDEX IF NOT EXISTS idx_barcodes_marketplaces ON barcodes USING gin (marketplaces);
