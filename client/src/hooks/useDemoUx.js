/**
 * Состояние демо/онбординга: чеклист, подсказки, бейджи.
 */
import { useCallback, useEffect, useState } from 'react';
import { useLocation } from 'react-router-dom';
import { useAuth } from '../context/AuthContext.jsx';
import { demoUxApi } from '../services/demoUx.api.js';

const PATH_STEPS = [
  { match: (p) => p.startsWith('/products'), step: 'view_product' },
  { match: (p) => p.startsWith('/prices'), step: 'open_prices' },
  { match: (p) => p.startsWith('/integrations'), step: 'connect_mp' },
];

export function useDemoUx() {
  const { user, isAuthenticated } = useAuth();
  const location = useLocation();
  const [ux, setUx] = useState(null);
  const [loading, setLoading] = useState(false);

  const reload = useCallback(async () => {
    if (!isAuthenticated || !user?.id) {
      setUx(null);
      return null;
    }
    setLoading(true);
    try {
      const data = await demoUxApi.get();
      setUx(data);
      return data;
    } catch {
      setUx(null);
      return null;
    } finally {
      setLoading(false);
    }
  }, [isAuthenticated, user?.id]);

  useEffect(() => {
    reload();
  }, [reload]);

  useEffect(() => {
    if (!isAuthenticated || !user?.id) return undefined;
    const path = location.pathname || '';
    const hit = PATH_STEPS.find((x) => x.match(path));
    if (!hit) return undefined;
    let cancelled = false;
    (async () => {
      try {
        const data = await demoUxApi.completeStep(hit.step);
        if (!cancelled) setUx(data);
      } catch {
        /* ignore */
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [location.pathname, isAuthenticated, user?.id]);

  const completeStep = useCallback(async (stepId) => {
    const data = await demoUxApi.completeStep(stepId);
    setUx(data);
    return data;
  }, []);

  const dismissHint = useCallback(async (key) => {
    const data = await demoUxApi.dismissHint(key);
    setUx(data);
    return data;
  }, []);

  const dismissChecklist = useCallback(async () => {
    const data = await demoUxApi.dismissChecklist();
    setUx(data);
    return data;
  }, []);

  const extendDemo = useCallback(async () => {
    const result = await demoUxApi.extendDemo();
    await reload();
    return result;
  }, [reload]);

  const hintVisible = useCallback(
    (key) => {
      if (!ux) return false;
      return !(ux.hintsDismissed || []).includes(key);
    },
    [ux]
  );

  return {
    ux,
    loading,
    reload,
    completeStep,
    dismissHint,
    dismissChecklist,
    extendDemo,
    hintVisible,
  };
}
