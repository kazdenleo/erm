/**
 * Protected Route
 * Редирект на /login при отсутствии авторизации
 */

import React from 'react';
import { Navigate, useLocation } from 'react-router-dom';
import { useAuth } from '../context/AuthContext.jsx';

const FIRST_PASSWORD_PATH = '/first-login-change-password';

export function ProtectedRoute({ children }) {
  const { user, loading } = useAuth();
  const location = useLocation();

  if (loading) {
    return (
      <div className="loading-screen" style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', minHeight: '60vh' }}>
        Загрузка...
      </div>
    );
  }

  if (!user) {
    return <Navigate to="/login" state={{ from: location }} replace />;
  }

  const mustChange = !!user.mustChangePassword;
  if (mustChange && location.pathname !== FIRST_PASSWORD_PATH) {
    return <Navigate to={FIRST_PASSWORD_PATH} replace state={{ from: location }} />;
  }
  if (!mustChange && location.pathname === FIRST_PASSWORD_PATH) {
    return <Navigate to="/" replace />;
  }

  return children;
}
