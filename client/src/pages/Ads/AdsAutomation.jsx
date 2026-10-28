import React, { useCallback, useEffect, useState } from 'react';
import adsApi from '../../services/ads.api';
import './Ads.css';

const RULE_TYPES = [
  { value: 'zero_stock_pause', label: 'Автопауза при нулевом остатке' },
  { value: 'target_drr_bid', label: 'Биддер целевого ДРР' },
];

const MP_OPTIONS = [
  { value: '', label: 'Все МП' },
  { value: 'ozon', label: 'Ozon' },
  { value: 'wildberries', label: 'Wildberries' },
  { value: 'yandex', label: 'Яндекс.Маркет' },
];

export function AdsAutomation() {
  const [rules, setRules] = useState([]);
  const [runs, setRuns] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [busy, setBusy] = useState(false);
  const [form, setForm] = useState({
    name: '',
    ruleType: 'zero_stock_pause',
    marketplace: '',
    targetDrrPercent: 10,
    bidStepPercent: 5,
    minBid: 50,
    maxBid: 500,
  });

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const [r1, r2] = await Promise.all([adsApi.listRules(), adsApi.listAutomationRuns()]);
      setRules(r1?.data || []);
      setRuns(r2?.data || []);
    } catch (e) {
      setError(e?.response?.data?.error || e.message || 'Ошибка');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  const create = async () => {
    setBusy(true);
    setError(null);
    try {
      const config =
        form.ruleType === 'target_drr_bid'
          ? {
              targetDrrPercent: Number(form.targetDrrPercent) || 10,
              bidStepPercent: Number(form.bidStepPercent) || 5,
              minBid: Number(form.minBid) || 50,
              maxBid: Number(form.maxBid) || 500,
              cooldownMinutes: 60,
            }
          : { resumeOnStock: true, minStock: 1 };
      await adsApi.createRule({
        name: form.name || undefined,
        ruleType: form.ruleType,
        marketplace: form.marketplace || null,
        config,
        enabled: true,
      });
      setForm((f) => ({ ...f, name: '' }));
      await load();
    } catch (e) {
      setError(e?.response?.data?.error || e.message || 'Ошибка');
    } finally {
      setBusy(false);
    }
  };

  const toggle = async (rule) => {
    setBusy(true);
    try {
      await adsApi.updateRule(rule.id, { enabled: !rule.enabled });
      await load();
    } catch (e) {
      setError(e?.response?.data?.error || e.message || 'Ошибка');
    } finally {
      setBusy(false);
    }
  };

  const remove = async (id) => {
    if (!window.confirm('Удалить правило?')) return;
    setBusy(true);
    try {
      await adsApi.deleteRule(id);
      await load();
    } catch (e) {
      setError(e?.response?.data?.error || e.message || 'Ошибка');
    } finally {
      setBusy(false);
    }
  };

  const runOne = async (id) => {
    setBusy(true);
    setError(null);
    try {
      await adsApi.runRule(id);
      await load();
    } catch (e) {
      setError(e?.response?.data?.error || e.message || 'Ошибка');
    } finally {
      setBusy(false);
    }
  };

  const runAll = async () => {
    setBusy(true);
    setError(null);
    try {
      await adsApi.runAutomation();
      await load();
    } catch (e) {
      setError(e?.response?.data?.error || e.message || 'Ошибка');
    } finally {
      setBusy(false);
    }
  };

  return (
    <div>
      <div className="ads-toolbar">
        <button type="button" className="btn btn-primary" disabled={busy} onClick={runAll}>
          Запустить все правила
        </button>
        <button type="button" className="btn btn-light" onClick={load} disabled={loading}>
          Обновить
        </button>
      </div>

      {error && (
        <div className="ads-muted" style={{ color: 'var(--error, #ef4444)' }}>
          {error}
        </div>
      )}

      <h3>Новое правило</h3>
      <div className="ads-form-row">
        <label>
          Название
          <input
            value={form.name}
            onChange={(e) => setForm((f) => ({ ...f, name: e.target.value }))}
            placeholder="Необязательно"
          />
        </label>
        <label>
          Тип
          <select
            value={form.ruleType}
            onChange={(e) => setForm((f) => ({ ...f, ruleType: e.target.value }))}
          >
            {RULE_TYPES.map((t) => (
              <option key={t.value} value={t.value}>
                {t.label}
              </option>
            ))}
          </select>
        </label>
        <label>
          МП
          <select
            value={form.marketplace}
            onChange={(e) => setForm((f) => ({ ...f, marketplace: e.target.value }))}
          >
            {MP_OPTIONS.map((o) => (
              <option key={o.value || 'all'} value={o.value}>
                {o.label}
              </option>
            ))}
          </select>
        </label>
        {form.ruleType === 'target_drr_bid' && (
          <>
            <label>
              Целевой ДРР %
              <input
                type="number"
                value={form.targetDrrPercent}
                onChange={(e) => setForm((f) => ({ ...f, targetDrrPercent: e.target.value }))}
              />
            </label>
            <label>
              Шаг ставки %
              <input
                type="number"
                value={form.bidStepPercent}
                onChange={(e) => setForm((f) => ({ ...f, bidStepPercent: e.target.value }))}
              />
            </label>
            <label>
              Min ставка
              <input
                type="number"
                value={form.minBid}
                onChange={(e) => setForm((f) => ({ ...f, minBid: e.target.value }))}
              />
            </label>
            <label>
              Max ставка
              <input
                type="number"
                value={form.maxBid}
                onChange={(e) => setForm((f) => ({ ...f, maxBid: e.target.value }))}
              />
            </label>
          </>
        )}
        <button type="button" className="btn btn-success" disabled={busy} onClick={create}>
          Создать
        </button>
      </div>

      <h3>Правила</h3>
      <div className="ads-table-wrap">
        <table className="ads-table">
          <thead>
            <tr>
              <th>Название</th>
              <th>Тип</th>
              <th>МП</th>
              <th>Вкл</th>
              <th></th>
            </tr>
          </thead>
          <tbody>
            {loading ? (
              <tr>
                <td colSpan={5} className="ads-muted">
                  Загрузка…
                </td>
              </tr>
            ) : rules.length === 0 ? (
              <tr>
                <td colSpan={5} className="ads-muted">
                  Правил пока нет
                </td>
              </tr>
            ) : (
              rules.map((r) => (
                <tr key={r.id}>
                  <td>{r.name}</td>
                  <td>
                    {RULE_TYPES.find((t) => t.value === r.ruleType)?.label || r.ruleType}
                  </td>
                  <td>{r.marketplace || 'все'}</td>
                  <td>
                    {r.enabled ? (
                      <span className="ads-badge ads-badge--ok">да</span>
                    ) : (
                      <span className="ads-badge ads-badge--warn">нет</span>
                    )}
                  </td>
                  <td>
                    <div className="ads-actions">
                      <button
                        type="button"
                        className="btn btn-sm btn-light"
                        disabled={busy}
                        onClick={() => toggle(r)}
                      >
                        {r.enabled ? 'Выкл' : 'Вкл'}
                      </button>
                      <button
                        type="button"
                        className="btn btn-sm btn-primary"
                        disabled={busy}
                        onClick={() => runOne(r.id)}
                      >
                        Запуск
                      </button>
                      <button
                        type="button"
                        className="btn btn-sm btn-danger"
                        disabled={busy}
                        onClick={() => remove(r.id)}
                      >
                        Удал.
                      </button>
                    </div>
                  </td>
                </tr>
              ))
            )}
          </tbody>
        </table>
      </div>

      <h3 style={{ marginTop: 20 }}>Последние срабатывания</h3>
      <div className="ads-table-wrap">
        <table className="ads-table">
          <thead>
            <tr>
              <th>Время</th>
              <th>Правило</th>
              <th>Статус</th>
              <th>Действий</th>
              <th>Сообщение</th>
            </tr>
          </thead>
          <tbody>
            {runs.length === 0 ? (
              <tr>
                <td colSpan={5} className="ads-muted">
                  Пока пусто
                </td>
              </tr>
            ) : (
              runs.map((run) => (
                <tr key={run.id}>
                  <td>{run.created_at ? String(run.created_at).replace('T', ' ').slice(0, 19) : '—'}</td>
                  <td>{run.rule_id}</td>
                  <td>{run.status}</td>
                  <td>{run.actions_count}</td>
                  <td>{run.message || '—'}</td>
                </tr>
              ))
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
}

export default AdsAutomation;
