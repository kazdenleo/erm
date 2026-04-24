-- Migration: 094_integrations_organization_id.sql
-- Description: Привязка интеграций к организации внутри профиля (тенанта)

BEGIN;

ALTER TABLE integrations
  ADD COLUMN IF NOT EXISTS organization_id BIGINT REFERENCES organizations(id) ON DELETE SET NULL;

-- Попытка бэкоффила: если организация уже есть у профиля, привяжем существующие интеграции к первой организации.
-- Если организаций нет — оставим NULL, пользователь заполнит через UI.
DO $$
BEGIN
  -- В UPDATE нельзя безопасно ссылаться на алиас target-таблицы из LATERAL в некоторых версиях PG.
  -- Используем коррелированный подзапрос: "первая организация" для profile_id интеграции.
  UPDATE integrations i
  SET organization_id = (
    SELECT o.id
    FROM organizations o
    WHERE o.profile_id = i.profile_id
    ORDER BY o.id ASC
    LIMIT 1
  )
  WHERE i.organization_id IS NULL
    AND i.profile_id IS NOT NULL
    AND EXISTS (SELECT 1 FROM organizations o2 WHERE o2.profile_id = i.profile_id);
END $$;

CREATE INDEX IF NOT EXISTS idx_integrations_organization_id ON integrations(organization_id);

-- Уникальность делаем по (profile_id, organization_id, code). organization_id может быть NULL (legacy),
-- но в коде marketplace-интеграции будут требовать organization_id.
DROP INDEX IF EXISTS uq_integrations_profile_code;
CREATE UNIQUE INDEX IF NOT EXISTS uq_integrations_profile_org_code ON integrations(profile_id, organization_id, code);

COMMIT;

