/**
 * Плашка незавершённых расчётов закупки FBO.
 */

import React, { useCallback, useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { fboSuppliesApi } from '../../services/fboSupplies.api';
import { Button } from '../../components/common/Button/Button';

export function FboOpenCalcSessionsBanner({ excludeSessionId = null, compact = false } = {}) {
  const navigate = useNavigate();
  const [sessions, setSessions] = useState([]);
  const [loading, setLoading] = useState(true);
  const [err, setErr] = useState(null);

  const load = useCallback(async () => {
    setLoading(true);
    setErr(null);
    try {
      const data = await fboSuppliesApi.listPurchaseCalcSessions();
      const list = Array.isArray(data) ? data : [];
      const filtered = excludeSessionId
        ? list.filter((s) => Number(s.id) !== Number(excludeSessionId))
        : list;
      setSessions(filtered);
    } catch (e) {
      setSessions([]);
      setErr(e.response?.data?.message || e.message || 'Не удалось загрузить активные расчёты');
    } finally {
      setLoading(false);
    }
  }, [excludeSessionId]);

  useEffect(() => {
    void load();
  }, [load]);

  useEffect(() => {
    const onFocus = () => {
      void load();
    };
    window.addEventListener('focus', onFocus);
    return () => window.removeEventListener('focus', onFocus);
  }, [load]);

  if (loading && !sessions.length) {
    if (compact) return null;
    return (
      <div className="fbo-open-calc-sessions-banner fbo-open-calc-sessions-banner--loading">
        Загрузка незавершённых расчётов закупки…
      </div>
    );
  }

  if (err && !sessions.length) {
    return (
      <div className="alert alert-warning" style={{ marginBottom: 12 }}>
        {err}
      </div>
    );
  }

  if (!sessions.length) return null;

  return (
    <div className="fbo-open-calc-sessions-banner" role="status">
      <div className="fbo-open-calc-sessions-banner__title">Незавершённые расчёты закупки</div>
      {!compact ? (
        <p className="fbo-open-calc-sessions-banner__hint">
          Можно прерваться и продолжить позже — прогресс закупок сохраняется.
        </p>
      ) : null}
      <div className="fbo-open-calc-sessions-banner__links">
        {sessions.map((s) => {
          const supplyCount = Array.isArray(s.supplyIds) ? s.supplyIds.length : 0;
          const purchased = Number(s.purchasedQty) || 0;
          const extra =
            s.pendingPositions != null
              ? `, осталось ${s.pendingPositions} поз.`
              : purchased > 0
                ? `, закуплено ${purchased} шт.`
                : s.hasPurchaseProgress
                  ? ', в работе'
                  : '';
          return (
            <Button
              key={s.id}
              type="button"
              variant="secondary"
              size="small"
              onClick={() => navigate(`/stock-levels/fbo-supplies/purchase-calc?session=${s.id}`)}
            >
              Расчёт №{s.id} ({supplyCount} поставок{extra})
            </Button>
          );
        })}
      </div>
    </div>
  );
}
