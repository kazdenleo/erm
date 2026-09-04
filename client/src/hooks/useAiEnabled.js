/**
 * GigaChat: показывать ИИ-чат / опции только если ключ сохранён и включён.
 * Карточка в «Интеграциях» всегда видна — там подключение.
 */

import { useEffect, useState } from 'react';
import { aiApi } from '../services/ai.api';

const CHANGED_EVENT = 'ai-gigachat-config-changed';

export function invalidateAiEnabled() {
  if (typeof window !== 'undefined') {
    window.dispatchEvent(new Event(CHANGED_EVENT));
  }
}

export function useAiEnabled() {
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
  }, [refreshNonce]);

  return { enabled, configured, loading };
}
