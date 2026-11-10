/**
 * GigaChat: показывать ИИ-чат / опции только если тариф включает AI,
 * ключ сохранён и включён.
 */

import { useEffect, useState } from 'react';
import { aiApi } from '../services/ai.api';
import { useAuth } from '../context/AuthContext.jsx';

const CHANGED_EVENT = 'ai-gigachat-config-changed';

export function invalidateAiEnabled() {
  if (typeof window !== 'undefined') {
    window.dispatchEvent(new Event(CHANGED_EVENT));
  }
}

function planAllowsAi(user, profile) {
  if (user?.role === 'admin') return true;
  const sub = profile?.subscription;
  if (sub && sub.writeAllowed === false) return false;
  const f = sub?.features;
  if (f == null || typeof f !== 'object') return true;
  return f.ai === true;
}

export function useAiEnabled() {
  const { user, profile } = useAuth();
  const planOk = planAllowsAi(user, profile);
  const [enabled, setEnabled] = useState(false);
  const [configured, setConfigured] = useState(false);
  const [loading, setLoading] = useState(true);
  const [refreshNonce, setRefreshNonce] = useState(0);

  useEffect(() => {
    const onChange = () => setRefreshNonce((n) => n + 1);
    window.addEventListener(CHANGED_EVENT, onChange);
    return () => window.removeEventListener(CHANGED_EVENT, onChange);
  }, []);

  useEffect(() => {
    if (!planOk) {
      setConfigured(false);
      setEnabled(false);
      setLoading(false);
      return undefined;
    }
    let cancelled = false;
    setLoading(true);
    aiApi
      .getConfig()
      .then((data) => {
        if (cancelled) return;
        const hasCred = data?.configured === true || data?.credentialsSet === true;
        const on = hasCred && data?.enabled !== false;
        setConfigured(hasCred);
        setEnabled(on);
      })
      .catch(() => {
        if (cancelled) return;
        setConfigured(false);
        setEnabled(false);
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [refreshNonce, planOk]);

  return { enabled: planOk && enabled, configured: planOk && configured, loading };
}
