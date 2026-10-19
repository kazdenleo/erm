/**
 * Виджет «Пора пополнить запасы»: какие товары скоро закончатся на наших складах и насколько срочно.
 */

import React, { useCallback, useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { procurementForecastApi } from '../../../services/procurementForecast.api';
import { LOW_STOCK_URGENCY, daysLeftLabel } from '../../StockLevels/LowStockPanel';
import { KpiCard } from './AnalyticsWidgets';
import { cachedLoad, errorMessage, formatQty } from './widgetUtils';

const ALERT_OPTIONS = [5, 7, 10, 14, 21, 30];
const LIST_LIMITS = [5, 10, 20];
const FULL_LIST_URL = '/stock-levels/warehouse?view=low';

function pickAlert(settings) {
  return ALERT_OPTIONS.includes(Number(settings?.alertDays)) ? Number(settings.alertDays) : 14;
}

function pickLimit(settings) {
  return LIST_LIMITS.includes(Number(settings?.limit)) ? Number(settings.limit) : 5;
}

export function LowStockWidget({ settings }) {
  const alertDays = pickAlert(settings);
  const limit = pickLimit(settings);
  const hideCovered = Boolean(settings?.hideCovered);
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);

  const load = useCallback(
    (force = false) => {
      setLoading(true);
      setError(null);
      cachedLoad(`low-stock:${alertDays}`, () => procurementForecastApi.getLowStock({ alertDays }), { force })
        .then((d) => setData(d || null))
        .catch((e) => {
          setError(errorMessage(e, 'Не удалось загрузить остатки'));
          setData(null);
        })
        .finally(() => setLoading(false));
    },
    [alertDays]
  );

  useEffect(() => {
    load();
  }, [load]);

  const summary = data?.summary || {};
  const items = (data?.items || []).filter((it) => !hideCovered || !it.coveredByIncoming);
  const list = items.slice(0, limit);

  return (
    <KpiCard
      icon="pe-7s-box1"
      title="Пора пополнить запасы"
      period={`запаса меньше чем на ${alertDays} дн.`}
      to={FULL_LIST_URL}
      loading={loading}
      error={error}
      onReload={() => load(true)}
      metrics={[
        { label: 'Закончились', value: formatQty(summary.out ?? 0), tone: summary.out > 0 ? 'bad' : undefined },
        { label: 'Критично', value: formatQty(summary.critical ?? 0), tone: summary.critical > 0 ? 'bad' : undefined },
        { label: 'Скоро', value: formatQty(summary.soon ?? 0) },
      ]}
    >
      {list.length === 0 ? (
        <div className="text-muted small mt-3">Запасов хватает — пополнять ничего не нужно.</div>
      ) : (
        <div className="home-kpi-top">
          <div className="home-kpi-top__title">Что пополнить в первую очередь</div>
          {list.map((it) => {
            const u = LOW_STOCK_URGENCY[it.urgency] || {};
            return (
              <div key={it.productId} className="home-kpi-top__row">
                <Link
                  to={`/products/${it.productId}`}
                  className="home-kpi-top__name"
                  title={`${it.productSku ? `${it.productSku} · ` : ''}${it.productName}. Свободно ${formatQty(it.available)}, расход ${formatQty(
                    it.dailyRate
                  )}/день${it.incoming ? `, в пути ${formatQty(it.incoming)}` : ''}${it.toOrder ? `, заказать ${formatQty(it.toOrder)}` : ''}`}
                >
                  {it.productSku || it.productName}
                </Link>
                <span className="home-kpi-top__val d-flex align-items-center gap-2">
                  {it.coveredByIncoming && <span className="small text-success" title="Закрыто поставкой в пути">в пути</span>}
                  <span className={`low-stock-badge ${u.className || ''}`}>{daysLeftLabel(it)}</span>
                </span>
              </div>
            );
          })}
          {items.length > list.length && (
            <Link to={FULL_LIST_URL} className="small">
              Ещё {formatQty(items.length - list.length)} →
            </Link>
          )}
        </div>
      )}
    </KpiCard>
  );
}

export function LowStockSettings({ settings, onChange }) {
  return (
    <div className="d-flex flex-wrap gap-2 align-items-center">
      <select
        className="form-select form-select-sm w-auto"
        value={pickAlert(settings)}
        onChange={(e) => onChange({ ...settings, alertDays: Number(e.target.value) })}
        aria-label="Порог предупреждения"
      >
        {ALERT_OPTIONS.map((n) => (
          <option key={n} value={n}>
            {`Запаса < ${n} дн.`}
          </option>
        ))}
      </select>
      <select
        className="form-select form-select-sm w-auto"
        value={pickLimit(settings)}
        onChange={(e) => onChange({ ...settings, limit: Number(e.target.value) })}
        aria-label="Сколько товаров в списке"
      >
        {LIST_LIMITS.map((n) => (
          <option key={n} value={n}>
            {`Список: ${n}`}
          </option>
        ))}
      </select>
      <label className="form-check-label small d-flex align-items-center gap-1">
        <input
          type="checkbox"
          className="form-check-input mt-0"
          checked={Boolean(settings?.hideCovered)}
          onChange={(e) => onChange({ ...settings, hideCovered: e.target.checked })}
        />
        Скрыть закрытые поставкой в пути
      </label>
    </div>
  );
}
