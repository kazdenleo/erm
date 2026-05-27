/**
 * Auth Context
 * Состояние авторизации, аккаунт (profile), выбранная организация, флаги возможностей
 */

import React, { createContext, useContext, useState, useEffect, useCallback, useMemo, useRef } from 'react';
import { authApi } from '../services/auth.api.js';
import { setApiSessionContext } from '../services/apiSession.js';
import {
  clearStoredOrganizationId,
  readStoredOrganizationId,
  resolveOrganizationIdForProfile,
  writeStoredOrganizationId,
} from '../utils/organizationSessionSync.js';

const AuthContext = createContext(null);

export function AuthProvider({ children }) {
  const [user, setUser] = useState(null);
  const [loading, setLoading] = useState(true);
  /** Не читаем localStorage в useState — иначе эффект сессии подставит чужой org до /auth/me */
  const [selectedOrganizationId, setSelectedOrganizationIdState] = useState(null);
  const [hasOrganizations, setHasOrganizations] = useState(null);

  const syncingOrgRef = useRef(false);

  const applyOrganizationId = useCallback((id, { persist = true } = {}) => {
    const next = id != null && id !== '' ? String(id) : null;
    setSelectedOrganizationIdState(next);
    if (persist) {
      writeStoredOrganizationId(next);
    }
  }, []);

  const syncOrganizationForUser = useCallback(
    async (userData, preferredOrgId = null) => {
      const rawPid = userData?.profileId ?? userData?.profile_id ?? userData?.profile?.id;
      const pid =
        rawPid != null && rawPid !== '' && Number.isFinite(Number(rawPid)) && Number(rawPid) > 0
          ? Number(rawPid)
          : null;

      if (pid == null) {
        setHasOrganizations(null);
        clearStoredOrganizationId();
        applyOrganizationId(null);
        setApiSessionContext({ accountId: null, organizationId: null });
        return null;
      }

      syncingOrgRef.current = true;
      try {
        const resolved = await resolveOrganizationIdForProfile(pid, preferredOrgId);
        applyOrganizationId(resolved);
        setHasOrganizations(pid != null ? resolved != null : null);
        setApiSessionContext({
          accountId: pid != null ? String(pid) : null,
          organizationId: resolved,
        });
        return resolved;
      } catch {
        setHasOrganizations(pid != null ? false : null);
        applyOrganizationId(null);
        setApiSessionContext({
          accountId: pid != null ? String(pid) : null,
          organizationId: null,
        });
        return null;
      } finally {
        syncingOrgRef.current = false;
      }
    },
    [applyOrganizationId]
  );

  const loadUser = useCallback(async () => {
    const token = localStorage.getItem('token');
    if (!token) {
      setUser(null);
      setLoading(false);
      return;
    }
    const orgFromStorage = readStoredOrganizationId();
    setHasOrganizations(null);
    // Не отправляем «чужую» организацию до /auth/me — иначе 403 ORGANIZATION_CONTEXT_MISMATCH после смены аккаунта.
    setApiSessionContext({
      accountId: null,
      organizationId: null,
    });
    try {
      const res = await authApi.me();
      if (res?.ok && res?.data) {
        setUser(res.data);
        await syncOrganizationForUser(res.data, orgFromStorage);
      } else {
        setUser(null);
        setHasOrganizations(null);
        localStorage.removeItem('token');
        applyOrganizationId(null);
      }
    } catch (err) {
      // Сбрасываем сессию только при явном «не авторизован»; сетевые сбои и 5xx не должны выкидывать на логин.
      const status = err?.response?.status;
      if (status === 401) {
        setUser(null);
        setHasOrganizations(null);
        localStorage.removeItem('token');
        applyOrganizationId(null);
      } else if (status === 403) {
        const code = err?.response?.data?.code;
        if (code === 'ORGANIZATION_CONTEXT_MISMATCH' || code === 'ACCOUNT_CONTEXT_MISMATCH') {
          applyOrganizationId(null);
          try {
            const res = await authApi.me();
            if (res?.ok && res?.data) {
              setUser(res.data);
              await syncOrganizationForUser(res.data, null);
            }
          } catch {
            /* ignore */
          }
        }
      }
    } finally {
      setLoading(false);
    }
  }, [applyOrganizationId, syncOrganizationForUser]);

  useEffect(() => {
    loadUser();
  }, [loadUser]);

  useEffect(() => {
    const onContextInvalid = () => {
      if (!localStorage.getItem('token') || !user) return;
      syncOrganizationForUser(user, null);
    };
    window.addEventListener('erp:organization-context-invalid', onContextInvalid);
    return () => window.removeEventListener('erp:organization-context-invalid', onContextInvalid);
  }, [user, syncOrganizationForUser]);

  const skipOrgReloadRef = useRef(true);
  useEffect(() => {
    if (skipOrgReloadRef.current) {
      skipOrgReloadRef.current = false;
      return;
    }
    if (syncingOrgRef.current) return;
    if (!localStorage.getItem('token')) return;
    loadUser();
  }, [selectedOrganizationId, loadUser]);

  const setSelectedOrganizationId = useCallback(
    (id) => {
      applyOrganizationId(id);
    },
    [applyOrganizationId]
  );

  const login = useCallback(async (email, password) => {
    clearStoredOrganizationId();
    applyOrganizationId(null, { persist: false });
    setHasOrganizations(null);
    let res;
    try {
      res = await authApi.login(String(email || '').trim(), password);
    } catch (err) {
      const status = err?.response?.status;
      const msg =
        err?.response?.data?.message ||
        err?.response?.data?.error ||
        err?.message ||
        'Ошибка входа';
      if (status === 429) {
        throw new Error(
          'Слишком много запросов к серверу. Подождите 1–2 минуты, перезапустите API (server/server.js) и попробуйте снова.'
        );
      }
      throw new Error(msg);
    }
    if (!res?.ok || !res?.data?.token) {
      throw new Error(res?.message || 'Ошибка входа');
    }
    localStorage.setItem('token', res.data.token);
    setApiSessionContext({
      accountId: null,
      organizationId: null,
    });
    let mustChangePassword = false;
    try {
      const me = await authApi.me();
      if (me?.ok && me?.data) {
        setUser(me.data);
        mustChangePassword = !!me.data.mustChangePassword;
        await syncOrganizationForUser(me.data, null);
      } else {
        setUser(res.data.user);
        mustChangePassword = !!res.data.user?.mustChangePassword;
        await syncOrganizationForUser(res.data.user, null);
      }
    } catch (err) {
      const status = err?.response?.status;
      if (status === 403) {
        const code = err?.response?.data?.code;
        if (code === 'ORGANIZATION_CONTEXT_MISMATCH' || code === 'ACCOUNT_CONTEXT_MISMATCH') {
          applyOrganizationId(null);
          clearStoredOrganizationId();
          try {
            const me = await authApi.me();
            if (me?.ok && me?.data) {
              setUser(me.data);
              mustChangePassword = !!me.data.mustChangePassword;
              await syncOrganizationForUser(me.data, null);
              return { ...res.data, mustChangePassword };
            }
          } catch {
            /* fall through */
          }
          throw new Error(
            'Не удалось восстановить контекст аккаунта. Очистите данные сайта для этого домена и войдите снова.'
          );
        }
      }
      setUser(res.data.user);
      mustChangePassword = !!res.data.user?.mustChangePassword;
      await syncOrganizationForUser(res.data.user, null);
    }
    return { ...res.data, mustChangePassword };
  }, [applyOrganizationId, syncOrganizationForUser]);

  const logout = useCallback(() => {
    localStorage.removeItem('token');
    clearStoredOrganizationId();
    applyOrganizationId(null);
    setUser(null);
    setHasOrganizations(null);
    setApiSessionContext({ accountId: null, organizationId: null });
  }, [applyOrganizationId]);

  const profileId = useMemo(() => {
    const raw = user?.profileId ?? user?.profile_id ?? user?.profile?.id;
    if (raw == null || raw === '') return null;
    const n = Number(raw);
    return Number.isFinite(n) && n > 0 ? n : null;
  }, [user]);

  const accountId = profileId;

  useEffect(() => {
    if (loading || !user) {
      setApiSessionContext({ accountId: null, organizationId: null });
      return;
    }
    if (syncingOrgRef.current) {
      setApiSessionContext({
        accountId: profileId != null ? String(profileId) : null,
        organizationId: null,
      });
      return;
    }
    setApiSessionContext({
      accountId: profileId != null ? String(profileId) : null,
      organizationId: selectedOrganizationId,
    });
  }, [loading, user, profileId, selectedOrganizationId]);

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
      /** false — у аккаунта нет доступных организаций (после синхронизации) */
      hasOrganizations,
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
      hasOrganizations,
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
