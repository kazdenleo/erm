-- Migration: 127_fbo_purchase_calc_sessions.sql
-- Сессии расчёта закупки FBO (хранятся до полного оформления закупок)

BEGIN;

CREATE TABLE IF NOT EXISTS fbo_purchase_calc_sessions (
    id BIGSERIAL PRIMARY KEY,
    profile_id BIGINT NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
    supply_ids JSONB NOT NULL,
    supply_ids_hash VARCHAR(64) NOT NULL,
    status VARCHAR(20) NOT NULL DEFAULT 'open'
        CHECK (status IN ('open', 'completed')),
    created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    completed_at TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS idx_fbo_purchase_calc_sessions_profile
    ON fbo_purchase_calc_sessions(profile_id, status, updated_at DESC);

CREATE UNIQUE INDEX IF NOT EXISTS idx_fbo_purchase_calc_sessions_open_hash
    ON fbo_purchase_calc_sessions(profile_id, supply_ids_hash)
    WHERE status = 'open';

CREATE TABLE IF NOT EXISTS fbo_purchase_calc_row_state (
    id BIGSERIAL PRIMARY KEY,
    session_id BIGINT NOT NULL REFERENCES fbo_purchase_calc_sessions(id) ON DELETE CASCADE,
    row_key TEXT NOT NULL,
    product_id BIGINT REFERENCES products(id) ON DELETE SET NULL,
    purchased_qty INTEGER NOT NULL DEFAULT 0 CHECK (purchased_qty >= 0),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    UNIQUE (session_id, row_key)
);

CREATE INDEX IF NOT EXISTS idx_fbo_purchase_calc_row_state_session
    ON fbo_purchase_calc_row_state(session_id);

CREATE TABLE IF NOT EXISTS fbo_purchase_calc_purchase_links (
    id BIGSERIAL PRIMARY KEY,
    session_id BIGINT NOT NULL REFERENCES fbo_purchase_calc_sessions(id) ON DELETE CASCADE,
    purchase_id BIGINT NOT NULL REFERENCES purchases(id) ON DELETE CASCADE,
    supplier_id BIGINT REFERENCES suppliers(id) ON DELETE SET NULL,
    items JSONB NOT NULL DEFAULT '[]'::jsonb,
    created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_fbo_purchase_calc_purchase_links_session
    ON fbo_purchase_calc_purchase_links(session_id);

COMMENT ON TABLE fbo_purchase_calc_sessions IS 'Расчёт закупки по поставкам FBO — до оформления всех закупок';
COMMENT ON COLUMN fbo_purchase_calc_row_state.purchased_qty IS 'Сколько уже отправлено в закупки из этой сессии';

COMMIT;
