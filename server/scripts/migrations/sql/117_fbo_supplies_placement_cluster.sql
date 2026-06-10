-- Migration: 117_fbo_supplies_placement_cluster.sql
-- Кластер размещения поставки FBO (Ozon / WB / Яндекс)

BEGIN;

ALTER TABLE fbo_supplies
    ADD COLUMN IF NOT EXISTS placement_cluster TEXT;

COMMENT ON COLUMN fbo_supplies.placement_cluster IS 'Кластер размещения на складе маркетплейса';

COMMIT;
