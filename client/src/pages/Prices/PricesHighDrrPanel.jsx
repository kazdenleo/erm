/**
 * Порог высокого ДРР (Ozon) для «Работы с карточками» и контроля рекламы.
 */
import React, { useEffect, useState } from 'react';
import { Button } from '../../components/common/Button/Button';
import { pricesApi } from '../../services/prices.api.js';

const DEFAULT_HIGH_DRR = 20;

export function PricesHighDrrPanel({ initialPercent, onSaved }) {
  const [value, setValue] = useState(
    initialPercent != null && Number.isFinite(Number(initialPercent))
      ? String(initialPercent)
      : String(DEFAULT_HIGH_DRR)
  );
  const [saving, setSaving] = useState(false);
  const [message, setMessage] = useState(null);
  const [error, setError] = useState(null);

  useEffect(() => {
    if (initialPercent != null && Number.isFinite(Number(initialPercent))) {
      setValue(String(initialPercent));
    }
  }, [initialPercent]);

  const save = async () => {
    setSaving(true);
    setError(null);
    setMessage(null);
    try {
      const n = Number(String(value).replace(',', '.'));
      if (!Number.isFinite(n) || n < 0 || n > 100) {
        throw new Error('Укажите порог ДРР от 0 до 100');
      }
      const res = await pricesApi.updatePushSettings({ highDrrPercent: n });
      const saved = res?.data ?? res;
      setMessage(
        n > 0
          ? `Сохранено: товары с ДРР выше ${n}% в активной рекламе попадут в «Работа с карточками».`
          : 'Порог 0% — фильтр «Высокий ДРР» выключен.'
      );
      onSaved?.(saved);
    } catch (e) {
      setError(e.response?.data?.message || e.message || 'Не удалось сохранить');
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="prices-high-drr-panel">
      <p className="text-muted small mb-3">
        Если товар сейчас в активной кампании Ozon Performance и его ДРР выше порога — он
        появляется в разделе «Работа с карточками» (фильтр «Высокий ДРР»). Если рекламу отключили,
        товар убирается из списка после синхронизации Performance (ночью или вручную). Вне кампаний
        реклама не входит в расчёт минимальной цены.
      </p>
      <div className="d-flex align-items-end gap-2 flex-wrap mb-2">
        <label className="mb-0">
          <span className="small d-block mb-1">Порог высокого ДРР, %</span>
          <input
            type="number"
            min={0}
            max={100}
            step={0.1}
            className="form-control form-control-sm"
            style={{ width: 120 }}
            value={value}
            onChange={(e) => setValue(e.target.value)}
          />
        </label>
        <Button type="button" variant="primary" size="small" disabled={saving} onClick={save}>
          {saving ? 'Сохранение…' : 'Сохранить'}
        </Button>
      </div>
      {error && <div className="error small">{error}</div>}
      {message && (
        <div className="small" style={{ color: 'var(--primary)' }}>
          {message}
        </div>
      )}
    </div>
  );
}
