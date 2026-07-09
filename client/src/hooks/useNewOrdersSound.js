import { useEffect, useRef } from 'react';
import { ordersApi } from '../services/orders.api';
import { playEventSound, SOUND_EVENTS } from '../utils/soundSettings';

/** Событие для внешнего запроса проверки (страница «Заказы» после обновления списка). */
export const NEW_ORDERS_SOUND_CHECK_EVENT = 'erm:check-new-orders-sound';

/** Интервал опроса, когда вкладка активна (мс). */
const ACTIVE_INTERVAL_MS = 10000;
/** Интервал, когда вкладка в фоне — реже, чтобы не грузить API. */
const HIDDEN_INTERVAL_MS = 30000;

/**
 * Глобальный звук "Новый заказ".
 * Опрос идёт в фоне и не привязан к странице /orders.
 *
 * Логика:
 * - Первый полученный count только "вооружает" (без звука), чтобы не пищать при первом заходе в приложение.
 * - Звук только при росте количества "new" относительно предыдущего значения.
 * - При активной вкладке опрос каждые 10 с; при возврате на вкладку — сразу.
 */
export function useNewOrdersSound({ enabled = true, profileId = null } = {}) {
  const prevRef = useRef(null);
  const armedRef = useRef(false);
  const inFlightRef = useRef(false);

  useEffect(() => {
    if (!enabled) return undefined;

    let cancelled = false;
    let timerId = null;

    const getIntervalMs = () =>
      typeof document !== 'undefined' && document.visibilityState === 'hidden'
        ? HIDDEN_INTERVAL_MS
        : ACTIVE_INTERVAL_MS;

    const scheduleNext = () => {
      if (cancelled) return;
      if (timerId) clearTimeout(timerId);
      timerId = setTimeout(() => {
        void tick().finally(() => scheduleNext());
      }, getIntervalMs());
    };

    const tick = async () => {
      if (inFlightRef.current) return;
      inFlightRef.current = true;
      try {
        const data = await ordersApi.getNewCount();
        if (cancelled) return;
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
      } finally {
        inFlightRef.current = false;
      }
    };

    const onCheckEvent = () => {
      if (!cancelled) void tick();
    };

    const onVisibility = () => {
      if (cancelled) return;
      if (document.visibilityState === 'visible') {
        void tick();
        scheduleNext();
      }
    };

    const onFocus = () => {
      if (!cancelled) void tick();
    };

    prevRef.current = null;
    armedRef.current = false;

    void tick().finally(() => scheduleNext());

    window.addEventListener(NEW_ORDERS_SOUND_CHECK_EVENT, onCheckEvent);
    document.addEventListener('visibilitychange', onVisibility);
    window.addEventListener('focus', onFocus);

    return () => {
      cancelled = true;
      if (timerId) clearTimeout(timerId);
      window.removeEventListener(NEW_ORDERS_SOUND_CHECK_EVENT, onCheckEvent);
      document.removeEventListener('visibilitychange', onVisibility);
      window.removeEventListener('focus', onFocus);
    };
  }, [enabled, profileId]);
}

/** Запросить немедленную проверку счётчика «Новый» (без дублирования логики звука). */
export function requestNewOrdersSoundCheck() {
  if (typeof window === 'undefined') return;
  window.dispatchEvent(new CustomEvent(NEW_ORDERS_SOUND_CHECK_EVENT));
}
