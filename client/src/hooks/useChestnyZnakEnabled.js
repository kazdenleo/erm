/**
 * Честный знак в операционном UI только если у текущей организации есть интеграция.
 * Карточка в «Интеграциях» всегда видна — там подключение и создаётся.
 */

import { useEffect, useState } from 'react';
import { useAuth } from '../context/AuthContext.jsx';
import { chestnyZnakApi } from '../services/chestnyZnak.api';

const CHANGED_EVENT = 'chestny-znak-config-changed';

export function invalidateChestnyZnakEnabled() {
  if (typeof window !== 'undefined') {
    window.dispatchEvent(new Event(CHANGED_EVENT));
  }
}

function enabledFromConfig(data) {
  if (!data || data.configured !== true) return false;
  return data.is_active !== false;
}

export function useChestnyZnakEnabled() {
  const { selectedOrganizationId } = useAuth();
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
    const orgKey =
      selectedOrganizationId != null && String(selectedOrganizationId).trim() !== ''
        ? String(selectedOrganizationId)
        : '';
    if (!orgKey) {
      setEnabled(false);
      setConfigured(false);
      setLoading(false);
      return undefined;
    }
    let cancelled = false;
    setLoading(true);
    chestnyZnakApi
      .getConfig()
      .then((data) => {
        if (cancelled) return;
        setConfigured(data?.configured === true);
        setEnabled(enabledFromConfig(data));
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
  }, [selectedOrganizationId, refreshNonce]);

  return { enabled, configured, loading };
}
