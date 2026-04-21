/**
 * Auth Context
 * Состояние авторизации, аккаунт (profile), выбранная организация, флаги возможностей
 */

import React, { createContext, useContext, useState, useEffect, useCallback, useMemo, useRef } from 'react';
import { authApi } from '../services/auth.api.js';
import { setApiSessionContext } from '../services/apiSession.js';

const AuthContext = createContext(null);

const STORAGE_ORG_KEY = 'erp_selected_organization_id';

export function AuthProvider({ children }) {
  const [user, setUser] = useState(null);
  const [loading, setLoading] = useState(true);
  const [selectedOrganizationId, setSelectedOrganizationIdState] = useState(() => {
    try {
      const raw = localStorage.getItem(STORAGE_ORG_KEY);
      return raw != null && raw !== '' ? raw : null;
    } catch {
      return null;
    }
  });

  const loadUser = useCallback(async () => {
    const token = localStorage.getItem('token');
    if (!token) {
      setUser(null);
      setLoading(false);
      return;
    }
    let orgFromStorage = null;
    try {
      const raw = localStorage.getItem(STORAGE_ORG_KEY);
      orgFromStorage = raw != null && raw !== '' ? raw : null;
    } catch {
      /* ignore */
    }
    // До /auth/me пользователь ещё не загружен — всё равно передаём выбранную организацию (сервер определит аккаунт)
    setApiSessionContext({
      accountId: null,
      organizationId: orgFromStorage,
    });
    try {
      const res = await authApi.me();
      if (res?.ok && res?.data) {
        setUser(res.data);
      } else {
        setUser(null);
        localStorage.removeItem('token');
      }
    } catch (err) {
      // Сбрасываем сессию только при явном «не авторизован»; сетевые сбои и 5xx не должны выкидывать на логин.
      const status = err?.response?.status;
      if (status === 401) {
        setUser(null);
        localStorage.removeItem('token');
      }
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    loadUser();
  }, [loadUser]);

  const skipOrgReloadRef = useRef(true);
  useEffect(() => {
    if (skipOrgReloadRef.current) {
      skipOrgReloadRef.current = false;
      return;
    }
    if (!localStorage.getItem('token')) return;
    loadUser();
  }, [selectedOrganizationId, loadUser]);

  const setSelectedOrganizationId = useCallback((id) => {
    const next = id != null && id !== '' ? String(id) : null;
    setSelectedOrganizationIdState(next);
    try {
      if (next == null) {
        localStorage.removeItem(STORAGE_ORG_KEY);
      } else {
        localStorage.setItem(STORAGE_ORG_KEY, next);
      }
    } catch {
      /* ignore */
    }
  }, []);

  const login = useCallback(async (email, password) => {
    let res;
    try {
      res = await authApi.login(String(email || '').trim(), password);
    } catch (err) {
      const msg =
        err?.response?.data?.message ||
        err?.response?.data?.error ||
        err?.message ||
        'Ошибка входа';
      throw new Error(msg);
    }
    if (!res?.ok || !res?.data?.token) {
      throw new Error(res?.message || 'Ошибка входа');
    }
    localStorage.setItem('token', res.data.token);
    let orgFromStorage = null;
    try {
      const raw = localStorage.getItem(STORAGE_ORG_KEY);
      orgFromStorage = raw != null && raw !== '' ? raw : null;
    } catch {
      /* ignore */
    }
    setApiSessionContext({
      accountId: null,
      organizationId: orgFromStorage,
    });
    let mustChangePassword = false;
    try {
      const me = await authApi.me();
      if (me?.ok && me?.data) {
        setUser(me.data);
        mustChangePassword = !!me.data.mustChangePassword;
      } else {
        setUser(res.data.user);
        mustChangePassword = !!res.data.user?.mustChangePassword;
      }
    } catch {
      setUser(res.data.user);
      mustChangePassword = !!res.data.user?.mustChangePassword;
    }
    return { ...res.data, mustChangePassword };
  }, []);

  const logout = useCallback(() => {
    localStorage.removeItem('token');
    try {
      localStorage.removeItem(STORAGE_ORG_KEY);
    } catch {
      /* ignore */
    }
    setSelectedOrganizationIdState(null);
    setUser(null);
    setApiSessionContext({ accountId: null, organizationId: null });
  }, []);

  const profileId = useMemo(() => {
    const raw = user?.profileId ?? user?.profile_id ?? user?.profile?.id;
    if (raw == null || raw === '') return null;
    const n = Number(raw);
    return Number.isFinite(n) && n > 0 ? n : null;
  }, [user]);

  const accountId = profileId;

  useEffect(() => {
    setApiSessionContext({
      accountId: profileId != null ? String(profileId) : null,
      organizationId: selectedOrganizationId,
    });
  }, [profileId, selectedOrganizationId]);

  const accountRole = useMemo(() => {
    const raw = user?.accountRole ?? user?.account_role ?? null;
    const s = raw == null ? '' : String(raw).trim().toLowerCase();
    return s || null;
  }, [user]);

  const features = user?.features;
  const limits = user?.limits;

  const canUseFeature = useCallback(
    (key) => {
      if (key == null || key === '') return true;
      const f = features;
      if (f == null || typeof f !== 'object') return true;
      if (Object.keys(f).length === 0) return true;
      return f[key] !== false;
    },
    [features]
  );

  const value = useMemo(
    () => ({
      user,
      loading,
      login,
      logout,
      /** Администратор продукта (системы): role === 'admin', без привязки к аккаунту клиента */
      isAdmin: user?.role === 'admin',
      /** Администратор аккаунта: is_profile_admin, обычно role === 'user' и задан profileId */
      isProfileAdmin: !!(user?.isProfileAdmin ?? user?.is_profile_admin),
      /** Роль внутри аккаунта (account_role): admin | picker | warehouse_manager | editor */
      accountRole,
      /** Администратор аккаунта/системы: может управлять пользователями и ролями */
      isAccountAdmin:
        (user?.role === 'admin') ||
        !!(user?.isProfileAdmin ?? user?.is_profile_admin) ||
        accountRole === 'admin',
      profileId,
      /** То же, что profileId: аккаунт в БД — профиль (tenant) */
      accountId,
      account:
        profileId != null
          ? { id: profileId, name: user?.profile?.name ?? null }
          : null,
      profile: user?.profile ?? null,
      features: features && typeof features === 'object' ? features : {},
      limits: limits && typeof limits === 'object' ? limits : {},
      canUseFeature,
      selectedOrganizationId,
      setSelectedOrganizationId,
      refreshUser: loadUser,
    }),
    [
      user,
      loading,
      login,
      logout,
      accountRole,
      profileId,
      accountId,
      features,
      limits,
      canUseFeature,
      selectedOrganizationId,
      setSelectedOrganizationId,
      loadUser,
    ]
  );

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth() {
  const ctx = useContext(AuthContext);
  if (!ctx) {
    throw new Error('useAuth must be used within AuthProvider');
  }
  return ctx;
}
