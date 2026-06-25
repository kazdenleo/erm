import React from 'react';
import { Navigate, useLocation } from 'react-router-dom';
import { useAuth } from '../../context/AuthContext.jsx';
import { isNavFeatureEnabled, navSectionKeyForPath } from '../../utils/userNavSections.js';

/**
 * Блокирует прямой переход по URL в раздел, скрытый для пользователя.
 */
export function NavSectionGuard({ children }) {
  const { pathname, search } = useLocation();
  const { isAccountAdmin, isAdmin, features } = useAuth();

  if (isAccountAdmin || isAdmin) {
    return children;
  }

  const key = navSectionKeyForPath(pathname, search);
  if (key && !isNavFeatureEnabled(features, key)) {
    return <Navigate to="/" replace />;
  }

  return children;
}
