-- Migration: 034_add_tax_system_and_vat_to_organizations.sql
-- Description: Система налогообложения и НДС в организациях

BEGIN;

ALTER TABLE organizations
  ADD COLUMN IF NOT EXISTS tax_system VARCHAR(100),
  ADD COLUMN IF NOT EXISTS vat VARCHAR(50);

COMMENT ON COLUMN organizations.tax_system IS 'Система налогообложения: ОСН, УСН, УСН доход-расход, ПСН, ЕСХН и т.д.';
COMMENT ON COLUMN organizations.vat IS 'НДС: Без НДС, НДС 20%, НДС 10%, НДС 0% и т.д.';

COMMIT;
