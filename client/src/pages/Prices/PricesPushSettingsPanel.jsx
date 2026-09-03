import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Button } from '../../components/common/Button/Button';
import { pricesApi } from '../../services/prices.api.js';
import { productsApi } from '../../services/products.api.js';
import { FILTER_CATEGORY_NONE } from '../../utils/uncategorizedCategoryFilter.js';

const SCOPES = {
  all: 'all',
  categories: 'categories',
  products: 'products',
  categoriesAndProducts: 'categories_and_products',
};

function normalizeScopeFromApi(rawScope) {
  if (rawScope === SCOPES.categoriesAndProducts) return SCOPES.categoriesAndProducts;
  if (rawScope === SCOPES.products) return SCOPES.products;
  if (rawScope === SCOPES.categories) return SCOPES.categories;
  return SCOPES.all;
}

function extractProductList(response) {
  if (Array.isArray(response)) return response.filter(Boolean);
  const data = response?.data;
  if (Array.isArray(data)) return data.filter(Boolean);
  if (Array.isArray(data?.data)) return data.data.filter(Boolean);
  if (Array.isArray(response?.items)) return response.items.filter(Boolean);
  return [];
}

function buildScopePayload(scope, pushFbs, pushFbo, pickedCategoryIds, selectedProducts, showFbsOption, showFboOption) {
  return {
    scope,
    pushFbs: showFbsOption ? pushFbs === true : false,
    pushFbo: showFboOption ? pushFbo === true : false,
    categoryIds:
      scope === SCOPES.categories || scope === SCOPES.categoriesAndProducts
        ? [...pickedCategoryIds]
        : [],
    productIds:
      scope === SCOPES.categoriesAndProducts || scope === SCOPES.products
        ? selectedProducts.map((p) => Number(p.id)).filter((n) => Number.isFinite(n) && n > 0)
        : [],
  };
}

function buildScopeSummaryText(settings) {
  if (!settings) return 'по сохранённым настройкам';
  const schemeParts = [];
  if (settings.pushFbs !== false) schemeParts.push('FBS');
  if (settings.pushFbo !== false) schemeParts.push('FBO');
  const schemeText = schemeParts.length ? schemeParts.join(' + ') : 'FBS';
  let scopeText = 'все товары организаций с включённой отправкой';
  if (settings.scope === 'categories_and_products' && settings.categoryIds?.length && settings.productIds?.length) {
    scopeText = `${settings.categoryIds.length} категор(ий), ${settings.productIds.length} товар(ов)`;
  } else if (settings.scope === 'products' && settings.productIds?.length) {
    scopeText = `${settings.productIds.length} выбранных товаров`;
  } else if (settings.scope === 'categories' && settings.categoryIds?.length) {
    scopeText = `${settings.categoryIds.length} категор(ий)`;
  }
  return `${scopeText}, мин. ${schemeText}`;
}

function productLabel(p) {
  if (!p) return '';
  const sku = p.sku || p.article || `#${p.id}`;
  const name = p.name || p.title || '';
  return name ? `${sku} — ${name}` : sku;
}

export { buildScopeSummaryText };

/**
 * Панель настроек отправки цен на маркетплейсы (раздел «Цены»).
 */
export function PricesPushSettingsPanel({
  categories = [],
  showUncategorizedCategoryOption = false,
  showFbsOption = true,
  showFboOption = true,
  organizations = [],
  onOrganizationsChange,
  onSaved,
  onPushNow,
  pushLoading = false,
  pushFeedback = null,
}) {
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [orgSavingId, setOrgSavingId] = useState(null);
  const [message, setMessage] = useState(null);
  const [error, setError] = useState(null);

  const [scope, setScope] = useState(SCOPES.all);
  const [pushFbs, setPushFbs] = useState(true);
  const [pushFbo, setPushFbo] = useState(true);
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
      setScope(normalizeScopeFromApi(data?.scope));
      setPushFbs(data?.pushFbs !== false);
      setPushFbo(data?.pushFbo !== false);
      setPickedCategoryIds(new Set((data?.categoryIds || []).map(String)));
      setOrgToggles(data?.organizations || []);

      const ids = (data?.productIds || []).map(Number).filter((n) => Number.isFinite(n) && n > 0);
      if (ids.length) {
        const loaded = await productsApi.getManyByIds(ids);
        setSelectedProducts(
          ids.map((id, idx) => loaded[idx] || { id, sku: `#${id}`, name: '' })
        );
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
        const searchOpts = { search: q, limit: 15 };
        const catIds = [...pickedCategoryIds].filter((id) => id !== FILTER_CATEGORY_NONE);
        if (scope === SCOPES.categoriesAndProducts && catIds.length === 1) {
          searchOpts.categoryId = catIds[0];
        }
        const res = await productsApi.getAll(searchOpts);
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
  }, [productSearch, selectedProducts, scope, pickedCategoryIds]);

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
      const payload = buildScopePayload(
        scope,
        pushFbs,
        pushFbo,
        pickedCategoryIds,
        selectedProducts,
        showFbsOption,
        showFboOption
      );
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

  const orgList = orgToggles.length ? orgToggles : organizations.map((o) => ({
    id: o.id,
    name: o.name,
    autoPushMarketplacePrices: o.auto_push_marketplace_prices === true,
  }));

  const hasEnabledOrg = orgList.some((o) => o.autoPushMarketplacePrices === true);

  const canSaveScope =
    (showFbsOption ? pushFbs : false) || (showFboOption ? pushFbo : false)
      ? scope === SCOPES.all ||
        (scope === SCOPES.categories && pickedCategoryIds.size > 0) ||
        (scope === SCOPES.products && selectedProducts.length > 0) ||
        (scope === SCOPES.categoriesAndProducts &&
          pickedCategoryIds.size > 0 &&
          selectedProducts.length > 0)
      : false;

  const canPushNow = canSaveScope && hasEnabledOrg && typeof onPushNow === 'function';

  const pushDisabledReason = (() => {
    if (!hasEnabledOrg) return 'Включите отправку хотя бы для одной организации.';
    if (!(showFbsOption ? pushFbs : false) && !(showFboOption ? pushFbo : false)) {
      return 'Выберите хотя бы одну схему (FBS или FBO).';
    }
    if (scope === SCOPES.categories && pickedCategoryIds.size === 0) {
      return 'Выберите хотя бы одну категорию.';
    }
    if (scope === SCOPES.products && selectedProducts.length === 0) {
      return 'Добавьте хотя бы один товар.';
    }
    if (scope === SCOPES.categoriesAndProducts) {
      if (pickedCategoryIds.size === 0) return 'Выберите хотя бы одну категорию.';
      if (selectedProducts.length === 0) return 'Добавьте хотя бы один товар.';
    }
    return null;
  })();

  const handleSaveAndPush = async () => {
    if (!canPushNow) return;

    const payload = buildScopePayload(
      scope,
      pushFbs,
      pushFbo,
      pickedCategoryIds,
      selectedProducts,
      showFbsOption,
      showFboOption
    );
    const enabledOrgs = orgList.filter((o) => o.autoPushMarketplacePrices === true);
    if (!enabledOrgs.length) {
      setError('Включите отправку хотя бы для одной организации.');
      return;
    }

    // Без window.confirm: после клика по «Отправить» диалог часто блокируется /
    // сразу даёт false → ложное «Отправка отменена».
    setSaving(true);
    setMessage(null);
    setError(null);
    try {
      await pricesApi.updatePushSettings(payload);
      onSaved?.(payload);
      await onPushNow(payload, { skipConfirm: true, organizations: enabledOrgs });
    } catch (err) {
      setError(err.response?.data?.message || err.message || 'Ошибка отправки');
    } finally {
      setSaving(false);
    }
  };

  const currentScopeSummary = useMemo(
    () =>
      buildScopeSummaryText(
        buildScopePayload(
          scope,
          pushFbs,
          pushFbo,
          pickedCategoryIds,
          selectedProducts,
          showFbsOption,
          showFboOption
        )
      ),
    [
      scope,
      pushFbs,
      pushFbo,
      pickedCategoryIds,
      selectedProducts,
      showFbsOption,
      showFboOption,
    ]
  );

  const renderCategoryPicker = () => (
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
  );

  const renderProductPicker = () => (
    <div style={{ marginTop: '6px' }}>
      <input
        type="search"
        className="form-control form-control-sm"
        placeholder="Поиск по артикулу или названию…"
        value={productSearch}
        onChange={(e) => setProductSearch(e.target.value)}
        autoComplete="off"
      />
      {searchLoading && <div className="text-muted small mt-1">Поиск…</div>}
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
  );

  if (loading) {
    return (
      <section className="prices-push-settings">
        <p className="text-muted small mb-0">Загрузка настроек…</p>
      </section>
    );
  }

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

      {(showFbsOption || showFboOption) && (
        <div style={{ marginBottom: '16px' }}>
          <strong className="small d-block mb-2">Какие мин. цены отправлять</strong>
          <div style={{ display: 'flex', flexDirection: 'column', gap: '8px' }}>
            {showFbsOption && (
              <div className="form-check form-switch mb-0">
                <input
                  className="form-check-input"
                  type="checkbox"
                  role="switch"
                  id="prices-push-scheme-fbs"
                  checked={pushFbs === true}
                  onChange={(e) => setPushFbs(e.target.checked)}
                />
                <label className="form-check-label" htmlFor="prices-push-scheme-fbs">
                  FBS
                </label>
              </div>
            )}
            {showFboOption && (
              <div className="form-check form-switch mb-0">
                <input
                  className="form-check-input"
                  type="checkbox"
                  role="switch"
                  id="prices-push-scheme-fbo"
                  checked={pushFbo === true}
                  onChange={(e) => setPushFbo(e.target.checked)}
                />
                <label className="form-check-label" htmlFor="prices-push-scheme-fbo">
                  FBO / FBY
                </label>
              </div>
            )}
          </div>
          <p className="text-muted small mt-2 mb-0">
            На карточке маркетплейса одна цена. Если выбраны обе схемы — отправляется максимум из
            выбранных мин. цен, чтобы не опуститься ниже любого из порогов.
          </p>
        </div>
      )}

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
              <div style={{ fontSize: '12px', color: 'var(--muted)' }}>
                Все товары из выбранных категорий
              </div>
              {scope === SCOPES.categories && renderCategoryPicker()}
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
              <div style={{ fontSize: '12px', color: 'var(--muted)' }}>
                Только указанные товары, без фильтра по категориям
              </div>
              {scope === SCOPES.products && renderProductPicker()}
            </span>
          </label>

          <label style={{ display: 'flex', gap: '8px', alignItems: 'flex-start', cursor: 'pointer' }}>
            <input
              type="radio"
              name="prices-push-scope"
              checked={scope === SCOPES.categoriesAndProducts}
              onChange={() => setScope(SCOPES.categoriesAndProducts)}
              style={{ marginTop: '3px' }}
            />
            <span style={{ flex: 1 }}>
              <strong>Категории и выбранные товары</strong>
              <div style={{ fontSize: '12px', color: 'var(--muted)' }}>
                Только указанные товары из выбранных категорий
              </div>
              {scope === SCOPES.categoriesAndProducts && (
                <>
                  {renderCategoryPicker()}
                  {renderProductPicker()}
                </>
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
          disabled={saving || pushLoading || !canSaveScope}
        >
          {saving && !pushLoading ? 'Сохранение…' : 'Сохранить настройки'}
        </Button>
      </div>

      <div
        style={{
          marginTop: '16px',
          padding: '12px 14px',
          borderRadius: '8px',
          border: '1px solid rgba(59,130,246,0.35)',
          background: 'rgba(59,130,246,0.08)',
        }}
      >
        <p className="small mb-2 mb-md-2" style={{ marginBottom: '8px' }}>
          <strong>Отправка:</strong>{' '}
          {canSaveScope ? currentScopeSummary : 'настройте область отправки выше'}
        </p>
        <p className="text-muted small mb-2">
          По расписанию цены отправляются автоматически. Нажмите кнопку ниже, чтобы отправить
          сейчас по выбранным настройкам.
        </p>
        <Button
          type="button"
          variant="secondary"
          size="small"
          onClick={handleSaveAndPush}
          disabled={saving || pushLoading || !canPushNow}
          title={!canPushNow ? pushDisabledReason || undefined : undefined}
        >
          {pushLoading ? '⏳ Запуск отправки…' : '📤 Отправить на маркетплейсы'}
        </Button>
        {!canPushNow && pushDisabledReason && (
          <p className="text-muted small mt-2 mb-0">{pushDisabledReason}</p>
        )}
        {pushFeedback && (
          <div
            className="small mt-2"
            style={{
              color: String(pushFeedback).startsWith('Ошибка')
                ? 'var(--danger, #ef4444)'
                : 'var(--primary)',
            }}
          >
            {String(pushFeedback).startsWith('Ошибка') ? '⚠️' : 'ℹ️'} {pushFeedback}
          </div>
        )}
      </div>
    </section>
  );
}
