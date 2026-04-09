/**
 * Доступ только для администратора продукта (role === 'admin').
 * Ожидается внутри ProtectedRoute — пользователь уже авторизован.
 */

import React from 'react';
import { Navigate } from 'react-router-dom';
import { useAuth } from '../context/AuthContext.jsx';

export function PlatformRoute({ children }) {
  const { isAdmin } = useAuth();
  if (!isAdmin) {
    return <Navigate to="/" replace />;
  }
  return children;
}
