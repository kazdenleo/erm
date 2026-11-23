-- Правила назначения стратегий: товар / бренд / категория / кабинет, опционально по МП.

BEGIN;

CREATE TABLE IF NOT EXISTS pricing_strategy_rules (
  id BIGSERIAL PRIMARY KEY,
  profile_id BIGINT NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
  strategy_id BIGINT NOT NULL REFERENCES pricing_strategies(id) ON DELETE CASCADE,
  -- product | brand | category | profile
  scope_type TEXT NOT NULL
    CHECK (scope_type IN ('product', 'brand', 'category', 'profile')),
  -- product_id / brand_id / user_category_id; для profile — NULL
  scope_id BIGINT,
  -- ozon | wb | ym | NULL (= все МП); wildberries/yandex нормализуются в коде
  marketplace TEXT
    CHECK (
      marketplace IS NULL
      OR marketplace IN ('ozon', 'wb', 'ym', 'wildberries', 'yandex')
    ),
  is_active BOOLEAN NOT NULL DEFAULT true,
  created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT pricing_strategy_rules_scope_id_chk CHECK (
    (scope_type = 'profile' AND scope_id IS NULL)
    OR (scope_type <> 'profile' AND scope_id IS NOT NULL)
  )
);

-- Один смысл на комбинацию scope + МП (NULL marketplace = все МП)
CREATE UNIQUE INDEX IF NOT EXISTS uq_pricing_strategy_rules_scope
  ON pricing_strategy_rules (profile_id, scope_type, scope_id, marketplace)
  NULLS NOT DISTINCT;

CREATE INDEX IF NOT EXISTS idx_pricing_strategy_rules_profile
  ON pricing_strategy_rules (profile_id, is_active);

CREATE INDEX IF NOT EXISTS idx_pricing_strategy_rules_strategy
  ON pricing_strategy_rules (strategy_id);

CREATE INDEX IF NOT EXISTS idx_pricing_strategy_rules_scope
  ON pricing_strategy_rules (scope_type, scope_id)
  WHERE is_active = true;

COMMENT ON TABLE pricing_strategy_rules IS
  'Назначение стратегии: товар/бренд/категория/кабинет, опционально отдельно по маркетплейсу';
COMMENT ON COLUMN pricing_strategy_rules.scope_type IS
  'product | brand | category | profile';
COMMENT ON COLUMN pricing_strategy_rules.marketplace IS
  'Конкретный МП или NULL = все маркетплейсы';

COMMIT;
