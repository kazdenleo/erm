-- Migration: 238_product_competitors_stock_qty.sql
-- Description: Остаток конкурента, если он виден на витрине

ALTER TABLE product_competitors
  ADD COLUMN IF NOT EXISTS stock_qty INTEGER;

COMMENT ON COLUMN product_competitors.stock_qty IS 'Остаток на витрине, если маркетплейс его показал. NULL — на странице остатка не было';
