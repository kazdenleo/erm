import { useEffect, useRef } from 'react';
import { ordersApi } from '../services/orders.api';
import { playEventSound, SOUND_EVENTS } from '../utils/soundSettings';

/**
 * Глобальный звук "Новый заказ".
 * Опрос идёт в фоне и не привязан к странице /orders.
 *
 * Логика:
 * - Первый полученный count только "вооружает" (без звука), чтобы не пищать при первом заходе в приложение.
 * - Звук только при росте количества "new" относительно предыдущего значения.
 */
export function useNewOrdersSound({ enabled = true, intervalMs = 60000 } = {}) {
  const prevRef = useRef(null);
  const armedRef = useRef(false);

  useEffect(() => {
    if (!enabled) return;
    let cancelled = false;
    let timerId = null;

    const tick = async () => {
      try {
        const data = await ordersApi.getStatusCounts({});
        const cur = Number(data?.new ?? 0);
        const prev = prevRef.current;
        prevRef.current = cur;
        if (!armedRef.current) {
          armedRef.current = true;
          return;
        }
        if (prev == null) return;
        if (cur > prev) playEventSound(SOUND_EVENTS.new_order);
      } catch {
        // ignore: не пищим при ошибке сети
      }
    };

    void tick();
    timerId = setInterval(() => {
      if (!cancelled) void tick();
    }, Math.max(15000, Number(intervalMs) || 60000));

    return () => {
      cancelled = true;
      if (timerId) clearInterval(timerId);
    };
  }, [enabled, intervalMs]);
}

