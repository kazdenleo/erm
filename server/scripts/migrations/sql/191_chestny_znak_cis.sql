-- Migration: 191_chestny_znak_cis.sql
-- Description: Реестр КИ и документы ГИС МТ в разрезе организации

BEGIN;

CREATE TABLE IF NOT EXISTS chestny_znak_cis (
  id BIGSERIAL PRIMARY KEY,
  profile_id BIGINT NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
  organization_id BIGINT NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  cis TEXT NOT NULL,
  gtin VARCHAR(14),
  product_id BIGINT REFERENCES products(id) ON DELETE SET NULL,
  product_group VARCHAR(50),
  warehouse_id BIGINT,
  status VARCHAR(32) NOT NULL DEFAULT 'scanned',
  gis_status VARCHAR(64),
  owner_inn VARCHAR(12),
  source_type VARCHAR(40),
  source_id BIGINT,
  dest_type VARCHAR(40),
  dest_id BIGINT,
  last_document_id BIGINT,
  error_message TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT uq_chestny_znak_cis_org UNIQUE (profile_id, organization_id, cis),
  CONSTRAINT chk_chestny_znak_cis_status CHECK (
    status IN ('scanned', 'in_stock', 'reserved', 'transferred', 'withdrawn', 'error')
  )
);

CREATE INDEX IF NOT EXISTS idx_chestny_znak_cis_org_status
  ON chestny_znak_cis (profile_id, organization_id, status);
CREATE INDEX IF NOT EXISTS idx_chestny_znak_cis_source
  ON chestny_znak_cis (organization_id, source_type, source_id);

CREATE TABLE IF NOT EXISTS chestny_znak_documents (
  id BIGSERIAL PRIMARY KEY,
  profile_id BIGINT NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
  organization_id BIGINT NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  doc_kind VARCHAR(40) NOT NULL,
  gis_type VARCHAR(64) NOT NULL,
  gis_action VARCHAR(64),
  status VARCHAR(32) NOT NULL DEFAULT 'draft',
  channel VARCHAR(20) NOT NULL DEFAULT 'true_api',
  gis_doc_id VARCHAR(80),
  product_group VARCHAR(50),
  inn VARCHAR(12),
  source_type VARCHAR(40),
  source_id BIGINT,
  payload JSONB,
  error_message TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  sent_at TIMESTAMPTZ,
  CONSTRAINT chk_chestny_znak_doc_kind CHECK (
    doc_kind IN (
      'purchase_accept',
      'wholesale_ship',
      'fbo_transfer',
      'fbs_distance',
      'own_use',
      'retail',
      'return_in'
    )
  ),
  CONSTRAINT chk_chestny_znak_doc_status CHECK (
    status IN ('draft', 'ready', 'edo_pending', 'edo_done', 'sent', 'accepted', 'rejected')
  ),
  CONSTRAINT chk_chestny_znak_doc_channel CHECK (channel IN ('edo', 'true_api'))
);

CREATE INDEX IF NOT EXISTS idx_chestny_znak_docs_org
  ON chestny_znak_documents (profile_id, organization_id, created_at DESC);

CREATE TABLE IF NOT EXISTS chestny_znak_document_cises (
  document_id BIGINT NOT NULL REFERENCES chestny_znak_documents(id) ON DELETE CASCADE,
  cis_id BIGINT NOT NULL REFERENCES chestny_znak_cis(id) ON DELETE CASCADE,
  PRIMARY KEY (document_id, cis_id)
);

ALTER TABLE chestny_znak_cis
  DROP CONSTRAINT IF EXISTS chestny_znak_cis_last_document_id_fkey;
ALTER TABLE chestny_znak_cis
  ADD CONSTRAINT chestny_znak_cis_last_document_id_fkey
  FOREIGN KEY (last_document_id) REFERENCES chestny_znak_documents(id) ON DELETE SET NULL;

ALTER TABLE products
  ADD COLUMN IF NOT EXISTS chestny_znak_pg VARCHAR(50);

COMMENT ON TABLE chestny_znak_cis IS 'Коды маркировки на балансе организации (Честный знак)';
COMMENT ON TABLE chestny_znak_documents IS 'Документы оборота ГИС МТ / ЭДО в разрезе организации';

COMMIT;
