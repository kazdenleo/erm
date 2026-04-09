CREATE TABLE IF NOT EXISTS product_attributes (
    id BIGSERIAL PRIMARY KEY,
    name VARCHAR(255) NOT NULL,
    type VARCHAR(32) NOT NULL CHECK (type IN ('text', 'checkbox', 'number', 'date', 'dictionary')),
    dictionary_values JSONB DEFAULT '[]'::jsonb,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_product_attributes_name ON product_attributes(name);
CREATE INDEX IF NOT EXISTS idx_product_attributes_type ON product_attributes(type);

CREATE TABLE IF NOT EXISTS category_attributes (
    user_category_id BIGINT NOT NULL REFERENCES user_categories(id) ON DELETE CASCADE,
    attribute_id BIGINT NOT NULL REFERENCES product_attributes(id) ON DELETE CASCADE,
    PRIMARY KEY (user_category_id, attribute_id)
);

CREATE INDEX IF NOT EXISTS idx_category_attributes_category ON category_attributes(user_category_id);
CREATE INDEX IF NOT EXISTS idx_category_attributes_attribute ON category_attributes(attribute_id);
