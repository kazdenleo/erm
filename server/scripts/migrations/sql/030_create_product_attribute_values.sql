CREATE TABLE IF NOT EXISTS product_attribute_values (
    product_id BIGINT NOT NULL REFERENCES products(id) ON DELETE CASCADE,
    attribute_id BIGINT NOT NULL REFERENCES product_attributes(id) ON DELETE CASCADE,
    value TEXT,
    PRIMARY KEY (product_id, attribute_id)
);

CREATE INDEX IF NOT EXISTS idx_product_attribute_values_product ON product_attribute_values(product_id);
CREATE INDEX IF NOT EXISTS idx_product_attribute_values_attribute ON product_attribute_values(attribute_id);
