/**
 * Пульс акций — универсальные политики фаз A/B/C (Ozon / позже WB, YM).
 */

import React, { useCallback, useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { Button } from '../../components/common/Button/Button';
import { promoPulseApi } from '../../services/promoPulse.api.js';
import { categoriesApi } from '../../services/categories.api.js';

const SEGMENTS = [
  { id: 'hero', label: 'hero — не режем долю B' },
  { id: 'normal', label: 'normal' },
  { id: 'stock', label: 'stock — можно ниже пола' },
  { id: 'new', label: 'new — держим A' },
];

export function PromoPulse() {
  const [ports, setPorts] = useState([]);
  const [policies, setPolicies] = useState([]);
  const [policy, setPolicy] = useState(null);
  const [forcePhase, setForcePhase] = useState('');
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState(null);
  const [preview, setPreview] = useState(null);
  const [runs, setRuns] = useState([]);
  const [assignments, setAssignments] = useState([]);
  const [states, setStates] = useState([]);
  const [saving, setSaving] = useState(false);
  const [assignMode, setAssignMode] = useState('product');
  const [assignProductId, setAssignProductId] = useState('');
  const [assignCategoryId, setAssignCategoryId] = useState('');
  const [assignSegment, setAssignSegment] = useState('stock');
  const [categories, setCategories] = useState([]);

  const load = useCallback(async () => {
    setLoading(true);
    setMessage(null);
    try {
      const [portsRes, polRes, runsRes, asgRes, stRes, catRes] = await Promise.all([
        promoPulseApi.ports(),
        promoPulseApi.listPolicies(),
        promoPulseApi.listRuns(),
        promoPulseApi.listAssignments(),
        promoPulseApi.listStates(),
        categoriesApi.getAll().catch(() => ({ data: [] })),
      ]);
      setPorts(portsRes?.data || []);
      const list = polRes?.data || [];
      setPolicies(list);
      setPolicy(list.find((p) => p.is_default) || list[0] || null);
      setRuns(runsRes?.data || []);
      setAssignments(asgRes?.data || []);
      setStates(stRes?.data || []);
      const cats = Array.isArray(catRes?.data) ? catRes.data : Array.isArray(catRes) ? catRes : [];
      setCategories(cats.filter((c) => c?.id != null));
    } catch (e) {
      setMessage('Ошибка: ' + (e.response?.data?.error || e.message));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  const savePolicy = async () => {
    if (!policy?.id) return;
    setSaving(true);
    setMessage(null);
    try {
      const res = await promoPulseApi.updatePolicy(policy.id, policy);
      setPolicy(res?.data || policy);
      setMessage('Политика сохранена');
      await load();
    } catch (e) {
      setMessage('Ошибка: ' + (e.response?.data?.error || e.message));
    } finally {
      setSaving(false);
    }
  };

  const runPreview = async () => {
    setBusy(true);
    setMessage(null);
    try {
      const res = await promoPulseApi.preview({
        policyId: policy?.id,
        forcePhase: forcePhase || undefined,
      });
      if (!res?.ok) {
        setMessage('Ошибка: ' + (res?.error || 'preview'));
        setPreview(null);
      } else {
        setPreview(res);
        setMessage(
          `Preview: join ${res.counts?.join || 0}, set_level ${res.counts?.set_level || 0}, leave ${res.counts?.leave || 0}, skip ${res.counts?.skip || 0}`
        );
      }
    } catch (e) {
      setMessage('Ошибка: ' + (e.response?.data?.error || e.message));
    } finally {
      setBusy(false);
    }
  };

  const runDry = async () => {
    setBusy(true);
    setMessage(null);
    try {
      const res = await promoPulseApi.run({
        policyId: policy?.id,
        forcePhase: forcePhase || undefined,
        dryRun: true,
      });
      if (!res?.ok) {
        setMessage('Ошибка: ' + (res?.error || 'run'));
      } else {
        setPreview(res);
        setMessage(res.notice || `Прогон #${res.runId} сохранён (dry-run)`);
        await load();
      }
    } catch (e) {
      setMessage('Ошибка: ' + (e.response?.data?.error || e.message));
    } finally {
      setBusy(false);
    }
  };

  const runLive = async () => {
    if (policy?.dry_run !== false) {
      setMessage('Снимите «Только dry-run» в политике и сохраните — иначе live недоступен');
      return;
    }
    if (
      !window.confirm(
        'Отправить команды join/leave/set_level на маркетплейс? Это изменит участие и цены в акциях.'
      )
    ) {
      return;
    }
    setBusy(true);
    setMessage(null);
    try {
      const res = await promoPulseApi.run({
        policyId: policy?.id,
        forcePhase: forcePhase || undefined,
        dryRun: false,
      });
      if (!res?.ok) {
        setMessage('Ошибка: ' + (res?.error || 'run'));
      } else {
        setPreview(res);
        setMessage(res.notice || `Live-прогон #${res.runId}`);
        await load();
      }
    } catch (e) {
      setMessage('Ошибка: ' + (e.response?.data?.error || e.message));
    } finally {
      setBusy(false);
    }
  };

  const addAssignment = async () => {
    const payload = { segment: assignSegment, policy_id: policy?.id };
    if (assignMode === 'category') {
      const categoryId = Number(assignCategoryId);
      if (!Number.isFinite(categoryId) || categoryId < 1) {
        setMessage('Ошибка: выберите категорию');
        return;
      }
      payload.user_category_id = categoryId;
    } else {
      const productId = Number(assignProductId);
      if (!Number.isFinite(productId) || productId < 1) {
        setMessage('Ошибка: укажите ID товара');
        return;
      }
      payload.product_id = productId;
    }
    setBusy(true);
    try {
      await promoPulseApi.createAssignment(payload);
      setAssignProductId('');
      setAssignCategoryId('');
      setMessage(`Сегмент ${assignSegment} сохранён`);
      await load();
    } catch (e) {
      setMessage('Ошибка: ' + (e.response?.data?.error || e.message));
    } finally {
      setBusy(false);
    }
  };

  const removeAssignment = async (id) => {
    setBusy(true);
    try {
      await promoPulseApi.deleteAssignment(id);
      await load();
    } catch (e) {
      setMessage('Ошибка: ' + (e.response?.data?.error || e.message));
    } finally {
      setBusy(false);
    }
  };

  const toggleMp = (id) => {
    if (!policy) return;
    const set = new Set(policy.marketplaces || []);
    if (set.has(id)) set.delete(id);
    else set.add(id);
    setPolicy({ ...policy, marketplaces: [...set] });
  };

  const phaseCDays = Number(policy?.config?.phase_c_days) || 1;
  const setPhaseCDays = (n) => {
    if (!policy) return;
    setPolicy({
      ...policy,
      config: { ...(policy.config || {}), phase_c_days: Number(n) || 1 },
    });
  };

  if (loading) return <div className="card"><p className="text-muted">Загрузка…</p></div>;

  const actionable = (preview?.all || []).filter((r) => r.decision && r.decision !== 'skip');

  return (
    <div className="card">
      <div style={{ display: 'flex', justifyContent: 'space-between', gap: 12, flexWrap: 'wrap' }}>
        <div>
          <h1 className="title">Пульс акций</h1>
          <p className="subtitle">
            Фазы A → B → C. Ozon / WB / YM; запись на МП при снятом dry-run; cron 1:20 МСК.
            WB без leave API — только вход. {' '}
            <Link to="/prices/promotions">← Акции</Link>
            {' · '}
            <Link to="/prices/strategies">Стратегии цен</Link>
          </p>
        </div>
      </div>

      {message && (
        <p style={{ marginTop: 12, color: message.startsWith('Ошибка') ? 'var(--danger,#ef4444)' : 'var(--primary)' }}>
          {message}
        </p>
      )}

      <div style={{ marginTop: 16, display: 'flex', gap: 8, flexWrap: 'wrap' }}>
        {ports.map((p) => (
          <span
            key={p.id}
            title={JSON.stringify(p.capabilities)}
            style={{
              padding: '4px 10px',
              borderRadius: 6,
              border: '1px solid var(--border,#e5e7eb)',
              fontSize: 13,
              background: p.ready ? 'rgba(34,197,94,0.12)' : 'rgba(148,163,184,0.15)',
              color: p.ready ? 'inherit' : 'var(--muted)',
            }}
          >
            {p.label}{p.ready ? '' : ' (скоро)'}
          </span>
        ))}
      </div>

      {policy && (
        <section style={{ marginTop: 20, maxWidth: 720 }}>
          <h2 style={{ fontSize: 16, marginBottom: 8 }}>Политика: {policy.name}</h2>
          <div style={{ display: 'grid', gap: 10 }}>
            <label style={{ display: 'flex', gap: 8, alignItems: 'center', fontSize: 13 }}>
              Маркетплейсы:
              {ports.map((p) => (
                <label key={p.id} style={{ display: 'inline-flex', gap: 4, alignItems: 'center', opacity: p.ready ? 1 : 0.5 }}>
                  <input
                    type="checkbox"
                    checked={(policy.marketplaces || []).includes(p.id)}
                    disabled={!p.ready}
                    onChange={() => toggleMp(p.id)}
                  />
                  {p.id}
                </label>
              ))}
            </label>
            <div style={{ display: 'flex', gap: 12, flexWrap: 'wrap' }}>
              <label style={{ fontSize: 13 }}>
                Фаза A, дней{' '}
                <input
                  type="number"
                  min={1}
                  max={90}
                  value={policy.phase_a_days}
                  onChange={(e) => setPolicy({ ...policy, phase_a_days: Number(e.target.value) })}
                  style={{ width: 64 }}
                />
              </label>
              <label style={{ fontSize: 13 }}>
                Фаза B, дней{' '}
                <input
                  type="number"
                  min={1}
                  max={60}
                  value={policy.phase_b_days}
                  onChange={(e) => setPolicy({ ...policy, phase_b_days: Number(e.target.value) })}
                  style={{ width: 64 }}
                />
              </label>
              <label style={{ fontSize: 13 }}>
                Фаза C, дней{' '}
                <input
                  type="number"
                  min={1}
                  max={30}
                  value={phaseCDays}
                  onChange={(e) => setPhaseCDays(e.target.value)}
                  style={{ width: 64 }}
                />
              </label>
              <label style={{ fontSize: 13 }}>
                Макс. доля B / 30д{' '}
                <input
                  type="number"
                  min={0.05}
                  max={1}
                  step={0.01}
                  value={policy.max_b_share_30d}
                  onChange={(e) => setPolicy({ ...policy, max_b_share_30d: Number(e.target.value) })}
                  style={{ width: 72 }}
                />
              </label>
            </div>
            <label style={{ fontSize: 13, display: 'flex', gap: 6, alignItems: 'center' }}>
              <input
                type="checkbox"
                checked={policy.require_profit_ge_markup !== false}
                onChange={(e) => setPolicy({ ...policy, require_profit_ge_markup: e.target.checked })}
              />
              Прибыль на входе ≥ мин. наценки
            </label>
            <label style={{ fontSize: 13, display: 'flex', gap: 6, alignItems: 'center' }}>
              <input
                type="checkbox"
                checked={policy.allow_below_floor_stock === true}
                onChange={(e) => setPolicy({ ...policy, allow_below_floor_stock: e.target.checked })}
              />
              Сток может ниже пола в фазе B
            </label>
            <label style={{ fontSize: 13, display: 'flex', gap: 6, alignItems: 'center' }}>
              <input
                type="checkbox"
                checked={policy.dry_run !== false}
                onChange={(e) => setPolicy({ ...policy, dry_run: e.target.checked })}
              />
              Только dry-run (запись на МП выключена)
            </label>
            <div>
              <Button type="button" variant="secondary" onClick={savePolicy} disabled={saving}>
                {saving ? 'Сохранение…' : 'Сохранить политику'}
              </Button>
            </div>
          </div>
        </section>
      )}

      <section style={{ marginTop: 24 }}>
        <h2 style={{ fontSize: 16, marginBottom: 8 }}>Предпросмотр и прогон</h2>
        <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'center', marginBottom: 12 }}>
          <label style={{ fontSize: 13 }}>
            Симулировать фазу{' '}
            <select value={forcePhase} onChange={(e) => setForcePhase(e.target.value)}>
              <option value="">По календарю / state</option>
              <option value="A">A — медиана</option>
              <option value="B">B — удар</option>
              <option value="C">C — выход</option>
            </select>
          </label>
          <Button type="button" variant="primary" onClick={runPreview} disabled={busy || !policy}>
            {busy ? '…' : 'Preview'}
          </Button>
          <Button type="button" variant="secondary" onClick={runDry} disabled={busy || !policy}>
            Сохранить прогон (dry-run)
          </Button>
          <Button
            type="button"
            variant="primary"
            onClick={runLive}
            disabled={busy || !policy || policy.dry_run !== false}
            title={policy?.dry_run !== false ? 'Снимите dry-run в политике' : 'Отправить на МП'}
          >
            Live на МП
          </Button>
        </div>
        {preview?.errors?.length > 0 && (
          <ul style={{ fontSize: 13, color: 'var(--muted)' }}>
            {preview.errors.map((err, i) => (
              <li key={i}>{err.marketplace}: {err.error}</li>
            ))}
          </ul>
        )}
        {actionable.length > 0 ? (
          <div className="prices-table-container" style={{ overflowX: 'auto' }}>
            <table className="prices-table table">
              <thead>
                <tr>
                  <th>МП</th>
                  <th>Акция</th>
                  <th>Товар</th>
                  <th>Сегмент</th>
                  <th>Фаза</th>
                  <th>B/30д</th>
                  <th>Решение</th>
                  <th>Цена</th>
                  <th>Уровень</th>
                  <th>Причина</th>
                </tr>
              </thead>
              <tbody>
                {actionable.slice(0, 200).map((row, idx) => (
                  <tr key={`${row.marketplace}-${row.action_id}-${row.our_product_id}-${idx}`}>
                    <td>{row.marketplace}</td>
                    <td style={{ maxWidth: 180, overflow: 'hidden', textOverflow: 'ellipsis' }} title={row.action_title}>
                      {row.action_title || row.action_id}
                    </td>
                    <td>{row.our_product_id}</td>
                    <td>{row.segment || '—'}</td>
                    <td>{row.phase}</td>
                    <td>{row.days_in_b_30d != null ? row.days_in_b_30d : '—'}</td>
                    <td>{row.decision}</td>
                    <td>{row.target_price != null ? `${row.target_price} ₽` : '—'}</td>
                    <td>{row.target_level != null ? `${row.target_level}%` : '—'}</td>
                    <td style={{ fontSize: 12, color: 'var(--muted)' }}>{row.reason}</td>
                  </tr>
                ))}
              </tbody>
            </table>
            {actionable.length > 200 && (
              <p className="text-muted small">Показаны первые 200 из {actionable.length}</p>
            )}
          </div>
        ) : preview ? (
          <p className="text-muted">Нет команд кроме skip — смените симуляцию фазы на B или проверьте участие в акциях.</p>
        ) : null}
      </section>

      <section style={{ marginTop: 24, maxWidth: 720 }}>
        <h2 style={{ fontSize: 16, marginBottom: 8 }}>Сегменты</h2>
        <p className="text-muted" style={{ fontSize: 13, marginBottom: 8 }}>
          Приоритет: товар → категория → организация. hero не режется max долей B; stock может ниже пола в B;
          new держит фазу A.
        </p>
        <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'center', marginBottom: 12 }}>
          <select value={assignMode} onChange={(e) => setAssignMode(e.target.value)}>
            <option value="product">Товар</option>
            <option value="category">Категория</option>
          </select>
          {assignMode === 'product' ? (
            <input
              type="number"
              placeholder="ID товара"
              value={assignProductId}
              onChange={(e) => setAssignProductId(e.target.value)}
              style={{ width: 120 }}
            />
          ) : (
            <select
              value={assignCategoryId}
              onChange={(e) => setAssignCategoryId(e.target.value)}
              style={{ maxWidth: 280 }}
            >
              <option value="">Категория…</option>
              {categories.map((c) => (
                <option key={c.id} value={c.id}>{c.name || c.path || `#${c.id}`}</option>
              ))}
            </select>
          )}
          <select value={assignSegment} onChange={(e) => setAssignSegment(e.target.value)}>
            {SEGMENTS.map((s) => (
              <option key={s.id} value={s.id}>{s.label}</option>
            ))}
          </select>
          <Button type="button" variant="secondary" onClick={addAssignment} disabled={busy}>
            Добавить
          </Button>
        </div>
        {assignments.length === 0 ? (
          <p className="text-muted">Нет привязок — всем normal</p>
        ) : (
          <ul style={{ fontSize: 13 }}>
            {assignments.map((a) => (
              <li key={a.id} style={{ display: 'flex', gap: 8, alignItems: 'center', marginBottom: 4 }}>
                <span>
                  #{a.id} · {a.segment}
                  {a.product_id ? ` · товар ${a.product_sku || a.product_id}` : ''}
                  {a.user_category_id ? ` · кат. ${a.category_name || a.user_category_id}` : ''}
                  {a.organization_id ? ` · орг. ${a.organization_name || a.organization_id}` : ''}
                </span>
                <button type="button" onClick={() => removeAssignment(a.id)} style={{ fontSize: 12 }}>
                  удалить
                </button>
              </li>
            ))}
          </ul>
        )}
      </section>

      <section style={{ marginTop: 24 }}>
        <h2 style={{ fontSize: 16, marginBottom: 8 }}>Состояние фаз</h2>
        {states.length === 0 ? (
          <p className="text-muted">Появится после первого сохранённого прогона</p>
        ) : (
          <div className="prices-table-container" style={{ overflowX: 'auto' }}>
            <table className="prices-table table">
              <thead>
                <tr>
                  <th>МП</th>
                  <th>Акция</th>
                  <th>Товар</th>
                  <th>Фаза</th>
                  <th>С</th>
                  <th>Решение</th>
                </tr>
              </thead>
              <tbody>
                {states.slice(0, 50).map((s) => (
                  <tr key={s.id}>
                    <td>{s.marketplace}</td>
                    <td>{s.action_external_id}</td>
                    <td>{s.product_sku || s.our_product_id || '—'}</td>
                    <td>{s.phase}</td>
                    <td style={{ fontSize: 12 }}>
                      {s.phase_started_at ? new Date(s.phase_started_at).toLocaleDateString('ru-RU') : '—'}
                    </td>
                    <td style={{ fontSize: 12, color: 'var(--muted)' }}>
                      {s.last_decision?.type || '—'}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>

      <section style={{ marginTop: 24 }}>
        <h2 style={{ fontSize: 16, marginBottom: 8 }}>Последние прогоны</h2>
        {runs.length === 0 ? (
          <p className="text-muted">Пока нет</p>
        ) : (
          <ul style={{ fontSize: 13 }}>
            {runs.slice(0, 10).map((r) => (
              <li key={r.id}>
                #{r.id} · {r.dry_run ? 'dry-run' : 'live'} · {r.status} ·{' '}
                {new Date(r.started_at).toLocaleString('ru-RU')} · {JSON.stringify(r.counts)}
              </li>
            ))}
          </ul>
        )}
      </section>

      {!policies.length && (
        <p className="text-muted" style={{ marginTop: 16 }}>Политика создастся при первой загрузке после миграции.</p>
      )}
    </div>
  );
}
