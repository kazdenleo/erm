import React, { useMemo, useRef, useState } from 'react';
import { Button } from '../../components/common/Button/Button';
import { productsApi } from '../../services/products.api.js';
import { FILTER_CATEGORY_NONE } from '../../utils/uncategorizedCategoryFilter.js';
import { createEmptyMinMarkupRule } from '../../utils/minMarkupRules.js';

function extractProductList(response) {
  if (Array.isArray(response)) return response.filter(Boolean);
  const data = response?.data;
  if (Array.isArray(data)) return data.filter(Boolean);
  if (Array.isArray(data?.data)) return data.data.filter(Boolean);
  if (Array.isArray(response?.items)) return response.items.filter(Boolean);
  return [];
}

function productLabel(p) {
  if (!p) return '';
  const sku = p.sku || p.article || `#${p.id}`;
  const name = p.name || p.title || '';
  return name ? `${sku} — ${name}` : sku;
}

/**
 * Редактор градаций мин. наценки (₽ или %).
 */
export function PricesMinMarkupRulesPanel({
  rules = [],
  onChange,
  categories = [],
  showUncategorizedCategoryOption = false,
}) {
  const [productSearch, setProductSearch] = useState({});
  const [searchResults, setSearchResults] = useState({});
  const [searchLoading, setSearchLoading] = useState({});
  const [selectedProductsByRule, setSelectedProductsByRule] = useState({});
  const debounceRef = useRef({});

  const sortedCategories = useMemo(
    () =>
      [...(categories || [])].sort((a, b) =>
        String(a.name || '').localeCompare(String(b.name || ''), 'ru')
      ),
    [categories]
  );

  const updateRule = (ruleId, patch) => {
    onChange(
      (rules || []).map((r) => (r.id === ruleId ? { ...r, ...patch } : r))
    );
  };

  const removeRule = (ruleId) => {
    onChange((rules || []).filter((r) => r.id !== ruleId));
  };

  const addRule = () => {
    onChange([...(rules || []), createEmptyMinMarkupRule()]);
  };

  const updateTier = (ruleId, tiers) => updateRule(ruleId, { tiers });

  const searchProducts = (ruleId, q) => {
    if (debounceRef.current[ruleId]) clearTimeout(debounceRef.current[ruleId]);
    setProductSearch((prev) => ({ ...prev, [ruleId]: q }));
    if (String(q || '').trim().length < 2) {
      setSearchResults((prev) => ({ ...prev, [ruleId]: [] }));
      return;
    }
    setSearchLoading((prev) => ({ ...prev, [ruleId]: true }));
    debounceRef.current[ruleId] = setTimeout(async () => {
      try {
        const res = await productsApi.getAll({ search: q.trim(), limit: 12 });
        const list = extractProductList(res);
        const selected = selectedProductsByRule[ruleId] || [];
        const selectedIds = new Set(selected.map((p) => String(p.id)));
        setSearchResults((prev) => ({
          ...prev,
          [ruleId]: list.filter((p) => p?.id && !selectedIds.has(String(p.id))),
        }));
      } catch {
        setSearchResults((prev) => ({ ...prev, [ruleId]: [] }));
      } finally {
        setSearchLoading((prev) => ({ ...prev, [ruleId]: false }));
      }
    }, 350);
  };

  const addProductToRule = (ruleId, product, field) => {
    const rule = (rules || []).find((r) => r.id === ruleId);
    if (!rule || !product?.id) return;
    const id = Number(product.id);
    const key = field === 'exclude' ? 'excludeProductIds' : 'productIds';
    const nextIds = [...new Set([...(rule[key] || []), id])];
    updateRule(ruleId, { [key]: nextIds });
    setSelectedProductsByRule((prev) => ({
      ...prev,
      [ruleId]: [...(prev[ruleId] || []).filter((p) => String(p.id) !== String(id)), product],
    }));
    setProductSearch((prev) => ({ ...prev, [ruleId]: '' }));
    setSearchResults((prev) => ({ ...prev, [ruleId]: [] }));
  };

  const removeProductFromRule = (ruleId, productId, field) => {
    const rule = (rules || []).find((r) => r.id === ruleId);
    if (!rule) return;
    const key = field === 'exclude' ? 'excludeProductIds' : 'productIds';
    updateRule(ruleId, {
      [key]: (rule[key] || []).filter((id) => Number(id) !== Number(productId)),
    });
    setSelectedProductsByRule((prev) => ({
      ...prev,
      [ruleId]: (prev[ruleId] || []).filter((p) => String(p.id) !== String(productId)),
    }));
  };

  return (
    <div className="prices-min-markup-rules">
      <p className="text-muted small mb-3">
        Градации по себестоимости: для диапазона укажите мин. наценку в ₽ или в % от себестоимости.
        Необязательное поле «но не меньше» задаёт нижнюю границу наценки в рублях (удобно для %).
        Более узкое правило (товар → категория → все) имеет приоритет. Пока правило действует на товар,
        мин. наценки на карточке берутся из правила и вручную не меняются.
      </p>

      {(rules || []).length === 0 && (
        <p className="text-muted small">Правил пока нет — действует наценка с карточки товара.</p>
      )}

      {(rules || []).map((rule, idx) => (
        <div
          key={rule.id}
          style={{
            border: '1px solid rgba(255,255,255,0.12)',
            borderRadius: 8,
            padding: 12,
            marginBottom: 12,
          }}
        >
          <div className="d-flex flex-wrap gap-2 align-items-center mb-2">
            <div className="form-check form-switch mb-0">
              <input
                className="form-check-input"
                type="checkbox"
                role="switch"
                id={`mmr-en-${rule.id}`}
                checked={rule.enabled !== false}
                onChange={(e) => updateRule(rule.id, { enabled: e.target.checked })}
              />
              <label className="form-check-label small" htmlFor={`mmr-en-${rule.id}`}>
                Вкл.
              </label>
            </div>
            <input
              className="form-control form-control-sm"
              style={{ maxWidth: 220 }}
              placeholder={`Правило ${idx + 1}`}
              value={rule.name || ''}
              onChange={(e) => updateRule(rule.id, { name: e.target.value })}
            />
            <select
              className="form-select form-select-sm"
              style={{ maxWidth: 180 }}
              value={rule.scope || 'all'}
              onChange={(e) =>
                updateRule(rule.id, {
                  scope: e.target.value,
                  categoryIds: e.target.value === 'categories' ? rule.categoryIds : [],
                  productIds: e.target.value === 'products' ? rule.productIds : [],
                })
              }
            >
              <option value="all">Все товары</option>
              <option value="categories">Категории</option>
              <option value="products">Товары</option>
            </select>
            <Button type="button" variant="danger" size="small" onClick={() => removeRule(rule.id)}>
              Удалить
            </Button>
          </div>

          {rule.scope === 'categories' && (
            <div
              style={{
                maxHeight: 140,
                overflowY: 'auto',
                border: '1px solid rgba(255,255,255,0.1)',
                borderRadius: 6,
                padding: 6,
                marginBottom: 8,
                fontSize: 12,
              }}
            >
              {showUncategorizedCategoryOption && (
                <label className="d-flex gap-2 mb-1" style={{ cursor: 'pointer' }}>
                  <input
                    type="checkbox"
                    checked={(rule.categoryIds || []).includes(FILTER_CATEGORY_NONE)}
                    onChange={() => {
                      const set = new Set(rule.categoryIds || []);
                      if (set.has(FILTER_CATEGORY_NONE)) set.delete(FILTER_CATEGORY_NONE);
                      else set.add(FILTER_CATEGORY_NONE);
                      updateRule(rule.id, { categoryIds: [...set] });
                    }}
                  />
                  Без категории
                </label>
              )}
              {sortedCategories.map((c) => {
                const id = String(c.id);
                return (
                  <label key={id} className="d-flex gap-2 mb-1" style={{ cursor: 'pointer' }}>
                    <input
                      type="checkbox"
                      checked={(rule.categoryIds || []).includes(id)}
                      onChange={() => {
                        const set = new Set(rule.categoryIds || []);
                        if (set.has(id)) set.delete(id);
                        else set.add(id);
                        updateRule(rule.id, { categoryIds: [...set] });
                      }}
                    />
                    {c.name || `#${id}`}
                  </label>
                );
              })}
            </div>
          )}

          {rule.scope === 'products' && (
            <div className="mb-2">
              <input
                className="form-control form-control-sm"
                placeholder="Поиск товара для правила…"
                value={productSearch[rule.id] || ''}
                onChange={(e) => searchProducts(rule.id, e.target.value)}
              />
              {searchLoading[rule.id] && <p className="text-muted small mb-0 mt-1">Поиск…</p>}
              {(searchResults[rule.id] || []).map((p) => (
                <button
                  key={p.id}
                  type="button"
                  className="btn btn-link btn-sm text-start w-100"
                  onClick={() => addProductToRule(rule.id, p, 'include')}
                >
                  + {productLabel(p)}
                </button>
              ))}
              <ul className="list-unstyled small mb-0 mt-1">
                {(rule.productIds || []).map((id) => {
                  const p = (selectedProductsByRule[rule.id] || []).find(
                    (x) => String(x.id) === String(id)
                  );
                  return (
                    <li key={id} className="d-flex justify-content-between">
                      <span>{p ? productLabel(p) : `#${id}`}</span>
                      <button
                        type="button"
                        className="btn btn-link btn-sm text-danger p-0"
                        onClick={() => removeProductFromRule(rule.id, id, 'include')}
                      >
                        ✕
                      </button>
                    </li>
                  );
                })}
              </ul>
            </div>
          )}

          <strong className="small d-block mb-1">Градации по себестоимости</strong>
          <div className="table-responsive mb-2">
            <table className="table table-sm align-middle mb-0" style={{ fontSize: 12 }}>
              <thead>
                <tr>
                  <th>От, ₽</th>
                  <th>До, ₽</th>
                  <th>Тип</th>
                  <th>Значение</th>
                  <th>Но не меньше, ₽</th>
                  <th />
                </tr>
              </thead>
              <tbody>
                {(rule.tiers || []).map((tier, tIdx) => (
                  <tr key={`${rule.id}-t-${tIdx}`}>
                    <td>
                      <input
                        type="number"
                        className="form-control form-control-sm"
                        min="0"
                        value={tier.costFrom ?? 0}
                        onChange={(e) => {
                          const tiers = [...(rule.tiers || [])];
                          tiers[tIdx] = { ...tier, costFrom: Number(e.target.value) || 0 };
                          updateTier(rule.id, tiers);
                        }}
                      />
                    </td>
                    <td>
                      <input
                        type="number"
                        className="form-control form-control-sm"
                        min="0"
                        placeholder="∞"
                        value={tier.costTo ?? ''}
                        onChange={(e) => {
                          const tiers = [...(rule.tiers || [])];
                          const raw = e.target.value;
                          tiers[tIdx] = {
                            ...tier,
                            costTo: raw === '' ? null : Number(raw) || 0,
                          };
                          updateTier(rule.id, tiers);
                        }}
                      />
                    </td>
                    <td>
                      <select
                        className="form-select form-select-sm"
                        value={tier.mode || 'rub'}
                        onChange={(e) => {
                          const tiers = [...(rule.tiers || [])];
                          tiers[tIdx] = { ...tier, mode: e.target.value };
                          updateTier(rule.id, tiers);
                        }}
                      >
                        <option value="rub">₽</option>
                        <option value="percent">%</option>
                      </select>
                    </td>
                    <td>
                      <input
                        type="number"
                        className="form-control form-control-sm"
                        min="0"
                        step="0.1"
                        value={tier.value ?? ''}
                        onChange={(e) => {
                          const tiers = [...(rule.tiers || [])];
                          tiers[tIdx] = { ...tier, value: Number(e.target.value) || 0 };
                          updateTier(rule.id, tiers);
                        }}
                      />
                    </td>
                    <td>
                      <input
                        type="number"
                        className="form-control form-control-sm"
                        min="0"
                        step="1"
                        placeholder="—"
                        title="Необязательно: мин. наценка не ниже этой суммы"
                        value={tier.minRub ?? ''}
                        onChange={(e) => {
                          const tiers = [...(rule.tiers || [])];
                          const raw = e.target.value;
                          tiers[tIdx] = {
                            ...tier,
                            minRub: raw === '' ? null : Number(raw) || 0,
                          };
                          updateTier(rule.id, tiers);
                        }}
                      />
                    </td>
                    <td>
                      <button
                        type="button"
                        className="btn btn-link btn-sm text-danger p-0"
                        disabled={(rule.tiers || []).length <= 1}
                        onClick={() => {
                          updateTier(
                            rule.id,
                            (rule.tiers || []).filter((_, i) => i !== tIdx)
                          );
                        }}
                      >
                        ✕
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <Button
            type="button"
            variant="secondary"
            size="small"
            onClick={() =>
              updateTier(rule.id, [
                ...(rule.tiers || []),
                {
                  costFrom:
                    (rule.tiers || []).length > 0
                      ? Number(rule.tiers[rule.tiers.length - 1].costTo) ||
                        Number(rule.tiers[rule.tiers.length - 1].costFrom) + 1
                      : 0,
                  costTo: null,
                  mode: 'rub',
                  value: 50,
                  minRub: null,
                },
              ])
            }
          >
            + Диапазон
          </Button>

          <div className="mt-3">
            <strong className="small d-block mb-1">Исключения (товары)</strong>
            <input
              className="form-control form-control-sm"
              placeholder="Поиск товара-исключения…"
              value={productSearch[`${rule.id}-ex`] || ''}
              onChange={(e) => searchProducts(`${rule.id}-ex`, e.target.value)}
            />
            {(searchResults[`${rule.id}-ex`] || []).slice(0, 8).map((p) => (
              <button
                key={p.id}
                type="button"
                className="btn btn-link btn-sm text-start w-100"
                onClick={() => {
                  addProductToRule(rule.id, p, 'exclude');
                  setProductSearch((prev) => ({ ...prev, [`${rule.id}-ex`]: '' }));
                  setSearchResults((prev) => ({ ...prev, [`${rule.id}-ex`]: [] }));
                }}
              >
                + {productLabel(p)}
              </button>
            ))}
            <ul className="list-unstyled small mb-0 mt-1">
              {(rule.excludeProductIds || []).map((id) => (
                <li key={id} className="d-flex justify-content-between">
                  <span>#{id}</span>
                  <button
                    type="button"
                    className="btn btn-link btn-sm text-danger p-0"
                    onClick={() => removeProductFromRule(rule.id, id, 'exclude')}
                  >
                    ✕
                  </button>
                </li>
              ))}
            </ul>
          </div>
        </div>
      ))}

      <Button type="button" variant="secondary" size="small" onClick={addRule}>
        + Добавить правило
      </Button>
    </div>
  );
}
