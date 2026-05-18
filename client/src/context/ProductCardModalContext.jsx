import React, { createContext, useCallback, useContext, useMemo, useState } from 'react';
import { ProductForm } from '../components/forms/ProductForm/ProductForm';
import { useCategories } from '../hooks/useCategories';
import { useBrands } from '../hooks/useBrands';
import { useOrganizations } from '../hooks/useOrganizations';
import { useProducts } from '../hooks/useProducts';
import { productsApi } from '../services/products.api.js';
import { shouldIgnoreNavigationClick } from '../utils/navigationClick.js';

const ProductCardModalContext = createContext(null);

export function ProductCardModalProvider({ children }) {
  const { categories, loadCategories } = useCategories();
  const { brands } = useBrands();
  const { organizations } = useOrganizations();
  const { products, loadProducts } = useProducts({ autoLoad: false });

  const [state, setState] = useState({ isOpen: false, product: null, loading: false, error: null });

  const openProductCard = useCallback(
    async (productId) => {
      const id = Number(productId);
      if (!Number.isInteger(id) || id < 1) return;
      setState({ isOpen: true, product: null, loading: true, error: null });
      try {
        await loadCategories({ silent: categories.length > 0 });
        const response = await productsApi.getById(id);
        const full = response?.data ?? response;
        if (!full?.id) throw new Error('Товар не найден');
        setState({ isOpen: true, product: full, loading: false, error: null });
      } catch (e) {
        const msg = e?.response?.data?.message || e?.message || 'Ошибка открытия карточки товара';
        setState({ isOpen: true, product: null, loading: false, error: msg });
      }
    },
    [categories.length, loadCategories]
  );

  const closeProductCard = useCallback(() => {
    setState({ isOpen: false, product: null, loading: false, error: null });
  }, []);

  const openProductCardFromClick = useCallback(
    (productId, e) => {
      if (shouldIgnoreNavigationClick(e)) return;
      return openProductCard(productId);
    },
    [openProductCard]
  );

  const value = useMemo(
    () => ({ openProductCard, openProductCardFromClick, closeProductCard }),
    [openProductCard, openProductCardFromClick, closeProductCard]
  );

  return (
    <ProductCardModalContext.Provider value={value}>
      {children}
      {state.isOpen && (
        <div className="erm-product-card-overlay" role="dialog" aria-modal="false">
          <div className="erm-product-card-overlay__header">
            <div className="erm-product-card-overlay__title">Карточка товара</div>
            <button
              type="button"
              className="erm-product-card-overlay__close"
              aria-label="Close"
              onClick={closeProductCard}
            >
              ×
            </button>
          </div>
          <div className="erm-product-card-overlay__body">
            {state.loading ? (
              <div style={{ color: 'var(--muted)' }}>Загрузка...</div>
            ) : state.error ? (
              <div style={{ color: 'var(--danger, #ef4444)' }}>⚠️ {state.error}</div>
            ) : (
              <ProductForm
                product={state.product}
                categories={categories}
                brands={brands}
                organizations={organizations}
                products={products}
                onSubmit={async (productData) => {
                  if (!state.product?.id) return;
                  try {
                    setState((prev) => ({ ...prev, loading: true, error: null }));
                    const updated = await productsApi.update(state.product.id, productData);
                    const full = updated?.data ?? updated;
                    setState({ isOpen: false, product: full?.id ? full : null, loading: false, error: null });
                    await loadProducts();
                  } catch (e) {
                    const msg = e?.response?.data?.message || e?.message || 'Ошибка сохранения товара';
                    setState((prev) => ({ ...prev, loading: false, error: msg }));
                  }
                }}
                onCancel={closeProductCard}
                onProductUpdate={(p) => setState((prev) => ({ ...prev, product: p }))}
              />
            )}
          </div>
        </div>
      )}
    </ProductCardModalContext.Provider>
  );
}

export function useProductCardModal() {
  const ctx = useContext(ProductCardModalContext);
  if (!ctx) throw new Error('useProductCardModal must be used within ProductCardModalProvider');
  return ctx;
}

