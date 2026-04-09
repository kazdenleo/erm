-- Migration: 027_add_product_type_and_kit_components.sql
-- Description: Тип товара (Товар/Комплект) и таблица комплектующих

BEGIN;

-- Тип товара: 'product' — обычный товар, 'kit' — комплект
DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM information_schema.columns
        WHERE table_name = 'products' AND column_name = 'product_type'
    ) THEN
        ALTER TABLE products ADD COLUMN product_type VARCHAR(20) NOT NULL DEFAULT 'product';
        ALTER TABLE products ADD CONSTRAINT chk_product_type CHECK (product_type IN ('product', 'kit'));
        COMMENT ON COLUMN products.product_type IS 'Тип: product — товар, kit — комплект';
    END IF;
END $$;

-- Таблица комплектующих (для комплектов): какой товар входит в комплект и в каком количестве
CREATE TABLE IF NOT EXISTS kit_components (
    id BIGSERIAL PRIMARY KEY,
    kit_product_id BIGINT NOT NULL REFERENCES products(id) ON DELETE CASCADE,
    component_product_id BIGINT NOT NULL REFERENCES products(id) ON DELETE CASCADE,
    quantity INTEGER NOT NULL DEFAULT 1 CHECK (quantity > 0),
    created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
    UNIQUE(kit_product_id, component_product_id)
);

CREATE INDEX IF NOT EXISTS idx_kit_components_kit_product_id ON kit_components(kit_product_id);
CREATE INDEX IF NOT EXISTS idx_kit_components_component_product_id ON kit_components(component_product_id);

COMMENT ON TABLE kit_components IS 'Состав комплектов: связь комплекта с товарами-комплектующими и их количество';

COMMIT;
