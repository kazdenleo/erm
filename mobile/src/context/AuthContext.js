import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from 'react';
import Constants from 'expo-constants';
import { configureApi, normalizeServerUrl, ApiError } from '../api/client';
import { authApi, organizationsApi } from '../api/erp';
import { readItem, writeItem } from '../lib/storage';

const AuthContext = createContext(null);

/** В разработке телефон видит ПК по тому же IP, что и Metro (hostUri), backend — на порту 3001. */
function defaultServerUrl() {
  const fromEnv = process.env.EXPO_PUBLIC_API_URL;
  if (fromEnv) return fromEnv;
  const host = String(Constants.expoConfig?.hostUri || '').split(':')[0];
  return host ? `http://${host}:3001` : '';
}

function profileIdOf(user) {
  const raw = user?.profileId ?? user?.profile_id ?? user?.profile?.id;
  const n = Number(raw);
  return Number.isFinite(n) && n > 0 ? n : null;
}

export function AuthProvider({ children }) {
  const [status, setStatus] = useState('loading'); // loading | signedOut | signedIn | error
  const [bootError, setBootError] = useState(null);
  const [user, setUser] = useState(null);
  const [organizations, setOrganizations] = useState([]);
  const [organizationId, setOrganizationId] = useState(null);
  const [serverUrl, setServerUrl] = useState('');
  const signOutRef = useRef(null);

  const resetSession = useCallback(async () => {
    configureApi({ token: null, accountId: null, organizationId: null });
    setUser(null);
    setOrganizations([]);
    setOrganizationId(null);
    await writeItem('token', null);
    setStatus('signedOut');
  }, []);

  /** /auth/me → профиль → список организаций → выбранная организация. */
  const loadSession = useCallback(async (preferredOrgId) => {
    const me = await authApi.me();
    if (me?.mustChangePassword) {
      throw new ApiError('Сначала смените временный пароль в веб-версии ERP.', 403, 'MUST_CHANGE_PASSWORD');
    }
    const pid = profileIdOf(me);
    configureApi({ accountId: pid, organizationId: null });
    let orgs = [];
    try {
      orgs = await organizationsApi.list();
    } catch {
      orgs = [];
    }
    const preferred = orgs.find((o) => String(o.id) === String(preferredOrgId));
    const orgId = preferred ? String(preferred.id) : orgs[0] ? String(orgs[0].id) : null;
    configureApi({ organizationId: orgId });
    await writeItem('organizationId', orgId);
    setUser(me);
    setOrganizations(orgs);
    setOrganizationId(orgId);
    setStatus('signedIn');
  }, []);

  const bootstrap = useCallback(
    () =>
      Promise.all([readItem('server'), readItem('token'), readItem('organizationId')]).then(
        async ([savedServer, token, orgId]) => {
          const storedServer = savedServer || defaultServerUrl();
          setServerUrl(storedServer);
          configureApi({
            baseUrl: normalizeServerUrl(storedServer),
            token,
            onUnauthorized: () => signOutRef.current?.(),
          });
          if (!token || !storedServer) {
            setStatus('signedOut');
            return;
          }
          try {
            await loadSession(orgId);
          } catch (e) {
            if (e?.status === 401 || e?.status === 403) {
              await resetSession();
            } else {
              setBootError(e?.message || 'Не удалось подключиться к серверу');
              setStatus('error');
            }
          }
        }
      ),
    [loadSession, resetSession]
  );

  useEffect(() => {
    bootstrap();
  }, [bootstrap]);

  const retry = useCallback(() => {
    setStatus('loading');
    setBootError(null);
    bootstrap();
  }, [bootstrap]);

  const signIn = useCallback(
    async ({ server, login, password }) => {
      const base = normalizeServerUrl(server);
      if (!base) throw new ApiError('Укажите адрес сервера');
      configureApi({ baseUrl: base, token: null, accountId: null, organizationId: null });
      const res = await authApi.login(String(login).trim(), password);
      if (!res?.token) throw new ApiError('Сервер не вернул токен');
      configureApi({ token: res.token });
      try {
        await loadSession(await readItem('organizationId'));
      } catch (e) {
        configureApi({ token: null });
        throw e;
      }
      await writeItem('server', String(server).trim());
      await writeItem('token', res.token);
      setServerUrl(String(server).trim());
    },
    [loadSession]
  );

  const signOut = useCallback(async () => {
    await writeItem('receiptSession', null);
    await writeItem('cargoPurchase', null);
    await resetSession();
  }, [resetSession]);

  useEffect(() => {
    signOutRef.current = signOut;
  }, [signOut]);

  const selectOrganization = useCallback(async (id) => {
    const next = id != null ? String(id) : null;
    configureApi({ organizationId: next });
    setOrganizationId(next);
    await writeItem('organizationId', next);
  }, []);

  const value = useMemo(
    () => ({
      status,
      bootError,
      user,
      organizations,
      organizationId,
      organization: organizations.find((o) => String(o.id) === String(organizationId)) || null,
      serverUrl,
      signIn,
      signOut,
      selectOrganization,
      retry,
    }),
    [status, bootError, user, organizations, organizationId, serverUrl, signIn, signOut, selectOrganization, retry]
  );

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth() {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error('useAuth вызван вне AuthProvider');
  return ctx;
}
