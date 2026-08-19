import { useEffect, useMemo, useState } from 'react';
import { marketplaceCabinetsApi } from '../services/marketplaceCabinets.api.js';
import { collectFieldLimitsByMp, emptyFieldLimitsByMp } from '../utils/marketplaceFieldLimits.js';

/**
 * Лимиты полей карточки по кабинетам организации.
 * @param {string|number|null} organizationId
 */
export function useMarketplaceFieldLimits(organizationId) {
  const [limitsByMp, setLimitsByMp] = useState(emptyFieldLimitsByMp);
  const [loading, setLoading] = useState(false);

  const orgKey = organizationId != null && String(organizationId).trim() !== ''
    ? String(organizationId).trim()
    : '';

  useEffect(() => {
    if (!orgKey) {
      setLimitsByMp(emptyFieldLimitsByMp());
      return undefined;
    }
    let cancelled = false;
    setLoading(true);
    marketplaceCabinetsApi
      .list(orgKey)
      .then((r) => {
        if (cancelled) return;
        setLimitsByMp(collectFieldLimitsByMp(r?.data || []));
      })
      .catch(() => {
        if (!cancelled) setLimitsByMp(emptyFieldLimitsByMp());
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [orgKey]);

  return { limitsByMp, loading };
}

/**
 * Лимиты по нескольким организациям (массовое редактирование).
 * @param {Array<string|number>} organizationIds
 */
export function useMarketplaceFieldLimitsByOrg(organizationIds) {
  const key = useMemo(() => {
    const ids = [...new Set((organizationIds || []).map((id) => String(id || '').trim()).filter(Boolean))];
    ids.sort();
    return ids.join(',');
  }, [organizationIds]);

  const [byOrg, setByOrg] = useState({});

  useEffect(() => {
    const ids = key ? key.split(',').filter(Boolean) : [];
    if (!ids.length) {
      setByOrg({});
      return undefined;
    }
    let cancelled = false;
    Promise.all(
      ids.map(async (id) => {
        try {
          const r = await marketplaceCabinetsApi.list(id);
          return [id, collectFieldLimitsByMp(r?.data || [])];
        } catch {
          return [id, emptyFieldLimitsByMp()];
        }
      })
    ).then((entries) => {
      if (cancelled) return;
      setByOrg(Object.fromEntries(entries));
    });
    return () => {
      cancelled = true;
    };
  }, [key]);

  return byOrg;
}
