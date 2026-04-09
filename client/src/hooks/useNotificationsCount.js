import { useEffect, useState } from 'react';
import { integrationsApi } from '../services/integrations.api';

export function useNotificationsCount(pollMs = 60000) {
  const [count, setCount] = useState(0);

  useEffect(() => {
    let cancelled = false;
    const load = async () => {
      try {
        const list = await integrationsApi.getNotifications({ warn_days: 10 });
        const next = Array.isArray(list)
          ? list.length
          : Array.isArray(list?.data)
            ? list.data.length
            : 0;
        if (!cancelled) setCount(next);
      } catch {
        if (!cancelled) setCount(0);
      }
    };
    load();
    const t = setInterval(load, pollMs);
    return () => {
      cancelled = true;
      clearInterval(t);
    };
  }, [pollMs]);

  return count;
}
