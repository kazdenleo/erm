-- Заказы FBO (со склада маркетплейса) почти в реальном времени: Ozon /v2/posting/fbo/list,
-- WB Statistics /api/v1/supplier/orders (склад WB), Яндекс FBY /v2/campaigns/{id}/stats/orders.
-- Одна строка — одна позиция заказа; finance-отчёты FBO остаются в marketplace_fbo_report_lines.
CREATE TABLE IF NOT EXISTS marketplace_fbo_orders (
  id BIGSERIAL PRIMARY KEY,
  profile_id BIGINT NOT NULL,
  organization_id BIGINT,
  marketplace VARCHAR(16) NOT NULL,
  order_id VARCHAR(128) NOT NULL,
  line_key VARCHAR(128) NOT NULL,
  offer_id VARCHAR(255),
  sku VARCHAR(64),
  product_name TEXT,
  quantity INT NOT NULL DEFAULT 1,
  price NUMERIC(14, 2) NOT NULL DEFAULT 0,
  status VARCHAR(64),
  is_cancelled BOOLEAN NOT NULL DEFAULT false,
  ordered_at TIMESTAMP WITH TIME ZONE NOT NULL,
  warehouse_name VARCHAR(255),
  created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
  UNIQUE (profile_id, marketplace, order_id, line_key)
);

CREATE INDEX IF NOT EXISTS idx_marketplace_fbo_orders_profile_ordered
  ON marketplace_fbo_orders(profile_id, ordered_at);

-- Состояние синхронизации: с какой даты данные полные (backfill_from) и последний прогон.
CREATE TABLE IF NOT EXISTS marketplace_fbo_orders_sync_state (
  profile_id BIGINT NOT NULL,
  organization_id BIGINT NOT NULL DEFAULT 0,
  marketplace VARCHAR(16) NOT NULL,
  backfill_from DATE,
  last_synced_at TIMESTAMP WITH TIME ZONE,
  last_status VARCHAR(32),
  last_error TEXT,
  rows_last_sync INT,
  PRIMARY KEY (profile_id, organization_id, marketplace)
);
