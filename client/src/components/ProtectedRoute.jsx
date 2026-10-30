/**
 * Protected Route
 * Редирект на /login при отсутствии авторизации.
 * Системный admin (role=admin) — только /platform/*; пользователи аккаунта — только ERP.
 */

import React from 'react';
import { Navigate, useLocation } from 'react-router-dom';
import { useAuth } from '../context/AuthContext.jsx';

const FIRST_PASSWORD_PATH = '/first-login-change-password';
const ONBOARDING_PATH = '/onboarding';

function needsOnboarding(user) {
  if (!user || user.role === 'admin') return false;
  const flag = user?.profile?.onboarding;
  if (flag && typeof flag === 'object' && flag.completed === true) return false;
  if (flag && typeof flag === 'object' && flag.completed === false) return true;
  // Старые сессии без поля — не гоняем в wizard
  return false;
}

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
    const home = user.role === 'admin' ? '/platform/accounts' : '/';
    return <Navigate to={home} replace />;
  }

  const isSystemAdmin = user.role === 'admin';
  const onPlatform = location.pathname === '/platform' || location.pathname.startsWith('/platform/');

  // Системный администратор продукта не входит в интерфейс аккаунта (ERP).
  if (isSystemAdmin && !onPlatform) {
    return <Navigate to="/platform/accounts" replace />;
  }

  const onOnboarding = location.pathname === ONBOARDING_PATH;
  if (!mustChange && needsOnboarding(user) && !onOnboarding && !onPlatform) {
    return <Navigate to={ONBOARDING_PATH} replace />;
  }
  if (!mustChange && !needsOnboarding(user) && onOnboarding) {
    return <Navigate to="/" replace />;
  }

  return children;
}
