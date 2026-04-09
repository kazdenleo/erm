-- Migration: 066_inventory_sessions.sql
-- Документы инвентаризации (список + строки) и связь с движениями остатков

BEGIN;

CREATE TABLE IF NOT EXISTS inventory_sessions (
    id BIGSERIAL PRIMARY KEY,
    created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    created_by_user_id BIGINT REFERENCES users(id) ON DELETE SET NULL,
    profile_id BIGINT REFERENCES profiles(id) ON DELETE SET NULL,
    lines_count INTEGER NOT NULL DEFAULT 0,
    note TEXT
);

CREATE INDEX IF NOT EXISTS idx_inventory_sessions_created_at ON inventory_sessions(created_at DESC);
CREATE INDEX IF NOT EXISTS idx_inventory_sessions_profile_id ON inventory_sessions(profile_id);

CREATE TABLE IF NOT EXISTS inventory_session_lines (
    id BIGSERIAL PRIMARY KEY,
    session_id BIGINT NOT NULL REFERENCES inventory_sessions(id) ON DELETE CASCADE,
    product_id BIGINT NOT NULL REFERENCES products(id) ON DELETE CASCADE,
    quantity_before INTEGER NOT NULL,
    quantity_after INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_inventory_session_lines_session_id ON inventory_session_lines(session_id);

COMMENT ON TABLE inventory_sessions IS 'Шапка инвентаризации (пересчёт остатков)';
COMMENT ON TABLE inventory_session_lines IS 'Строки инвентаризации: было / стало';

COMMIT;
