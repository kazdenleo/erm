import React, { createContext, useCallback, useContext, useMemo } from 'react';
import { useNavigate } from 'react-router-dom';
import { shouldIgnoreNavigationClick } from '../utils/navigationClick.js';
import { productCardPath, shouldOpenProductCardInNewTab } from '../utils/productCardPath.js';

const ProductCardModalContext = createContext(null);

export function ProductCardModalProvider({ children }) {
  const navigate = useNavigate();

  const openProductCard = useCallback(
    (productId, extra) => {
      const id = Number(productId);
      if (!Number.isInteger(id) || id < 1) return;
      navigate(productCardPath(id, extra));
    },
    [navigate]
  );

  const closeProductCard = useCallback(() => {
    navigate('/products');
  }, [navigate]);

  const openProductCardFromClick = useCallback(
    (productId, e, extra) => {
      const id = Number(productId);
      if (!Number.isInteger(id) || id < 1) return;
      if (shouldOpenProductCardInNewTab(e)) {
        window.open(productCardPath(id, extra), '_blank', 'noopener,noreferrer');
        return;
      }
      if (shouldIgnoreNavigationClick(e)) return;
      navigate(productCardPath(id, extra));
    },
    [navigate]
  );

  const value = useMemo(
    () => ({ openProductCard, openProductCardFromClick, closeProductCard }),
    [openProductCard, openProductCardFromClick, closeProductCard]
  );

  return <ProductCardModalContext.Provider value={value}>{children}</ProductCardModalContext.Provider>;
}

export function useProductCardModal() {
  const ctx = useContext(ProductCardModalContext);
  if (!ctx) throw new Error('useProductCardModal must be used within ProductCardModalProvider');
  return ctx;
}
