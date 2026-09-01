import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Button } from '../../components/common/Button/Button';
import { pricesApi } from '../../services/prices.api.js';
import { productsApi } from '../../services/products.api.js';
import { FILTER_CATEGORY_NONE } from '../../utils/uncategorizedCategoryFilter.js';

const SCOPES = {
  all: 'all',
  categories: 'categories',
  products: 'products',
};

function extractProductList(response) {
  const list = Array.isArray(response?.data)
    ? response.data
    : (response?.data?.data ?? response?.data ?? response ?? []);
  return Array.isArray(list) ? list.filter(Boolean) : [];
}

function productLabel(p) {
  if (!p) return '';
  const sku = p.sku || p.article || `#${p.id}`;
  const name = p.name || p.title || '';
  return name ? `${sku} — ${name}` : sku;
}

/**
 * Панель настроек отправки цен на маркетплейсы (раздел «Цены»).
 */
export function PricesPushSettingsPanel({
  categories = [],
  showUncategorizedCategoryOption = false,
  organizations = [],
  onOrganizationsChange,
  onSaved,
}) {
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [orgSavingId, setOrgSavingId] = useState(null);
  const [message, setMessage] = useState(null);
  const [error, setError] = useState(null);

  const [scope, setScope] = useState(SCOPES.all);
  const [pickedCategoryIds, setPickedCategoryIds] = useState(() => new Set());
  const [selectedProducts, setSelectedProducts] = useState([]);
  const [orgToggles, setOrgToggles] = useState([]);

  const [productSearch, setProductSearch] = useState('');
  const [searchResults, setSearchResults] = useState([]);
  const [searchLoading, setSearchLoading] = useState(false);
  const searchDebounceRef = useRef(null);

  const sortedCategories = useMemo(() => {
    return [...(categories || [])].sort((a, b) =>
      String(a.name || '').localeCompare(String(b.name || ''), 'ru')
    );
  }, [categories]);

  const loadSettings = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await pricesApi.getPushSettings();
      const data = res?.data ?? res;
      setScope(data?.scope || SCOPES.all);
      setPickedCategoryIds(new Set((data?.categoryIds || []).map(String)));
      setOrgToggles(data?.organizations || []);

      const ids = (data?.productIds || []).map(Number).filter((n) => Number.isFinite(n) && n > 0);
      if (ids.length) {
        const prodRes = await productsApi.getAll({ ids, limit: ids.length });
        const list = extractProductList(prodRes);
        const byId = new Map((Array.isArray(list) ? list : []).map((p) => [String(p.id), p]));
        setSelectedProducts(ids.map((id) => byId.get(String(id)) || { id, sku: `#${id}` }));
      } else {
        setSelectedProducts([]);
      }
    } catch (err) {
      console.error('[PricesPushSettings] load failed:', err);
      setError(err.response?.data?.message || err.message || 'Не удалось загрузить настройки');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    loadSettings();
  }, [loadSettings]);

  useEffect(() => {
    if (searchDebounceRef.current) clearTimeout(searchDebounceRef.current);
    const q = productSearch.trim();
    if (q.length < 2) {
      setSearchResults([]);
      setSearchLoading(false);
      return undefined;
    }
    setSearchLoading(true);
    searchDebounceRef.current = setTimeout(async () => {
      try {
        const res = await productsApi.getAll({ search: q, limit: 15 });
        const list = extractProductList(res);
        const selectedIds = new Set(selectedProducts.map((p) => String(p.id)));
        setSearchResults(list.filter((p) => p?.id && !selectedIds.has(String(p.id))));
      } catch (err) {
        console.error('[PricesPushSettings] product search failed:', err);
        setSearchResults([]);
      } finally {
        setSearchLoading(false);
      }
    }, 350);
    return () => {
      if (searchDebounceRef.current) clearTimeout(searchDebounceRef.current);
    };
  }, [productSearch, selectedProducts]);

  const toggleCategory = (id) => {
    setPickedCategoryIds((prev) => {
      const next = new Set(prev);
      const key = String(id);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  };

  const addProduct = (product) => {
    if (!product?.id) return;
    setSelectedProducts((prev) => {
      if (prev.some((p) => String(p.id) === String(product.id))) return prev;
      return [...prev, product];
    });
    setProductSearch('');
    setSearchResults([]);
  };

  const removeProduct = (productId) => {
    setSelectedProducts((prev) => prev.filter((p) => String(p.id) !== String(productId)));
  };

  const handleOrgToggle = async (orgId, enabled) => {
    setOrgSavingId(orgId);
    setMessage(null);
    setError(null);
    try {
      if (typeof onOrganizationsChange === 'function') {
        await onOrganizationsChange(orgId, { auto_push_marketplace_prices: enabled === true });
      }
      setOrgToggles((prev) =>
        prev.map((o) =>
          String(o.id) === String(orgId) ? { ...o, autoPushMarketplacePrices: enabled === true } : o
        )
      );
      setMessage('Настройка организации сохранена');
      setTimeout(() => setMessage(null), 4000);
    } catch (err) {
      setError(err.response?.data?.message || err.message || 'Ошибка сохранения организации');
    } finally {
      setOrgSavingId(null);
    }
  };

  const handleSaveScope = async () => {
    setSaving(true);
    setMessage(null);
    setError(null);
    try {
      const payload = {
        scope,
        categoryIds: scope === SCOPES.categories ? [...pickedCategoryIds] : [],
        productIds:
          scope === SCOPES.products
            ? selectedProducts.map((p) => Number(p.id)).filter((n) => Number.isFinite(n) && n > 0)
            : [],
      };
      await pricesApi.updatePushSettings(payload);
      setMessage('Настройки сохранены');
      onSaved?.(payload);
      setTimeout(() => setMessage(null), 5000);
    } catch (err) {
      setError(err.response?.data?.message || err.message || 'Ошибка сохранения');
    } finally {
      setSaving(false);
    }
  };

  const canSaveScope =
    scope === SCOPES.all ||
    (scope === SCOPES.categories && pickedCategoryIds.size > 0) ||
    (scope === SCOPES.products && selectedProducts.length > 0);

  if (loading) {
    return (
      <section className="prices-push-settings">
        <p className="text-muted small mb-0">Загрузка настроек…</p>
      </section>
    );
  }

  const orgList = orgToggles.length ? orgToggles : organizations.map((o) => ({
    id: o.id,
    name: o.name,
    autoPushMarketplacePrices: o.auto_push_marketplace_prices === true,
  }));

  return (
    <section className="prices-push-settings" style={{ marginBottom: '16px' }}>
      <h2 className="h6 mb-1">Отправка цен на маркетплейсы</h2>
      <p className="text-muted small mb-3">
        Управляет автоматической и ручной отправкой сохранённых цен на Ozon, Wildberries и Яндекс.Маркет.
        Отправляются только товары с рассчитанными мин. ценами.
      </p>

      {error && <div className="error mb-2">{error}</div>}
      {message && <div className="small mb-2" style={{ color: 'var(--primary)' }}>{message}</div>}

      <div style={{ marginBottom: '16px' }}>
        <strong className="small d-block mb-2">Организации</strong>
        {orgList.length === 0 ? (
          <p className="text-muted small mb-0">Нет организаций в аккаунте.</p>
        ) : (
          <div style={{ display: 'flex', flexDirection: 'column', gap: '8px' }}>
            {orgList.map((org) => (
              <div key={org.id} className="form-check form-switch mb-0">
                <input
                  className="form-check-input"
                  type="checkbox"
                  role="switch"
                  id={`prices-push-org-${org.id}`}
                  checked={org.autoPushMarketplacePrices === true}
                  disabled={orgSavingId === org.id}
                  onChange={(e) => handleOrgToggle(org.id, e.target.checked)}
                />
                <label className="form-check-label" htmlFor={`prices-push-org-${org.id}`}>
                  {org.name || `Организация #${org.id}`}
                </label>
              </div>
            ))}
          </div>
        )}
        <p className="text-muted small mt-2 mb-0">
          Если выключено, система не меняет цены на МП для товаров этой организации
          (ни при пересчёте минимума, ни по расписанию).
        </p>
      </div>

      <div style={{ marginBottom: '12px' }}>
        <strong className="small d-block mb-2">Область отправки</strong>
        <div style={{ display: 'flex', flexDirection: 'column', gap: '10px' }}>
          <label style={{ display: 'flex', gap: '8px', alignItems: 'flex-start', cursor: 'pointer' }}>
            <input
              type="radio"
              name="prices-push-scope"
              checked={scope === SCOPES.all}
              onChange={() => setScope(SCOPES.all)}
              style={{ marginTop: '3px' }}
            />
            <span>
              <strong>Все товары</strong>
              <div style={{ fontSize: '12px', color: 'var(--muted)' }}>
                Все товары организаций с включённой отправкой
              </div>
            </span>
          </label>

          <label style={{ display: 'flex', gap: '8px', alignItems: 'flex-start', cursor: 'pointer' }}>
            <input
              type="radio"
              name="prices-push-scope"
              checked={scope === SCOPES.categories}
              onChange={() => setScope(SCOPES.categories)}
              style={{ marginTop: '3px' }}
            />
            <span style={{ flex: 1 }}>
              <strong>По категориям</strong>
              {scope === SCOPES.categories && (
                <div
                  className="prices-push-categories"
                  style={{
                    maxHeight: '180px',
                    overflowY: 'auto',
                    border: '1px solid rgba(255,255,255,0.12)',
                    borderRadius: '6px',
                    padding: '6px 8px',
                    fontSize: '12px',
                    marginTop: '6px',
                  }}
                >
                  {showUncategorizedCategoryOption && (
                    <label style={{ display: 'flex', gap: '6px', marginBottom: '4px', cursor: 'pointer' }}>
                      <input
                        type="checkbox"
                        checked={pickedCategoryIds.has(FILTER_CATEGORY_NONE)}
                        onChange={() => toggleCategory(FILTER_CATEGORY_NONE)}
                      />
                      <span>Без категории</span>
                    </label>
                  )}
                  {sortedCategories.map((cat) => (
                    <label
                      key={cat.id}
                      style={{ display: 'flex', gap: '6px', marginBottom: '4px', cursor: 'pointer' }}
                    >
                      <input
                        type="checkbox"
                        checked={pickedCategoryIds.has(String(cat.id))}
                        onChange={() => toggleCategory(String(cat.id))}
                      />
                      <span>{cat.name || `#${cat.id}`}</span>
                    </label>
                  ))}
                  {!sortedCategories.length && !showUncategorizedCategoryOption && (
                    <span style={{ color: 'var(--muted)' }}>Категории не найдены</span>
                  )}
                </div>
              )}
            </span>
          </label>

          <label style={{ display: 'flex', gap: '8px', alignItems: 'flex-start', cursor: 'pointer' }}>
            <input
              type="radio"
              name="prices-push-scope"
              checked={scope === SCOPES.products}
              onChange={() => setScope(SCOPES.products)}
              style={{ marginTop: '3px' }}
            />
            <span style={{ flex: 1 }}>
              <strong>Выбранные товары</strong>
              {scope === SCOPES.products && (
                <div style={{ marginTop: '6px' }}>
                  <input
                    type="search"
                    className="form-control form-control-sm"
                    placeholder="Поиск по артикулу или названию…"
                    value={productSearch}
                    onChange={(e) => setProductSearch(e.target.value)}
                    autoComplete="off"
                  />
                  {searchLoading && (
                    <div className="text-muted small mt-1">Поиск…</div>
                  )}
                  {searchResults.length > 0 && (
                    <div
                      style={{
                        marginTop: '4px',
                        maxHeight: '140px',
                        overflowY: 'auto',
                        border: '1px solid rgba(255,255,255,0.12)',
                        borderRadius: '6px',
                      }}
                    >
                      {searchResults.map((p) => (
                        <button
                          key={p.id}
                          type="button"
                          className="btn btn-link btn-sm text-start w-100 text-decoration-none"
                          style={{ fontSize: '12px', padding: '4px 8px' }}
                          onClick={() => addProduct(p)}
                        >
                          + {productLabel(p)}
                        </button>
                      ))}
                    </div>
                  )}
                  {selectedProducts.length > 0 && (
                    <ul
                      style={{
                        margin: '8px 0 0',
                        padding: 0,
                        listStyle: 'none',
                        maxHeight: '160px',
                        overflowY: 'auto',
                        fontSize: '12px',
                      }}
                    >
                      {selectedProducts.map((p) => (
                        <li
                          key={p.id}
                          style={{
                            display: 'flex',
                            justifyContent: 'space-between',
                            gap: '8px',
                            padding: '2px 0',
                            borderBottom: '1px solid rgba(255,255,255,0.06)',
                          }}
                        >
                          <span>{productLabel(p)}</span>
                          <button
                            type="button"
                            className="btn btn-link btn-sm p-0 text-danger"
                            onClick={() => removeProduct(p.id)}
                            title="Убрать"
                          >
                            ✕
                          </button>
                        </li>
                      ))}
                    </ul>
                  )}
                  {selectedProducts.length === 0 && (
                    <p className="text-muted small mt-2 mb-0">Добавьте товары через поиск выше.</p>
                  )}
                </div>
              )}
            </span>
          </label>
        </div>
      </div>

      <div className="d-flex gap-2 align-items-center flex-wrap">
        <Button
          type="button"
          variant="primary"
          size="small"
          onClick={handleSaveScope}
          disabled={saving || !canSaveScope}
        >
          {saving ? 'Сохранение…' : 'Сохранить настройки'}
        </Button>
      </div>
    </section>
  );
}
