/**
 * Пульс акций — автоматическое участие в акциях по фазам A/B/C.
 */

import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import { Button } from '../../components/common/Button/Button';
import { promoPulseApi } from '../../services/promoPulse.api.js';
import { categoriesApi } from '../../services/categories.api.js';
import { searchProductsCombined } from '../../utils/productSearch.js';
import './Prices.css';
import './PriceHistory.css';

const SEGMENTS = [
  { id: 'normal', label: 'Обычный' },
  { id: 'hero', label: 'Хит' },
  { id: 'stock', label: 'Сток' },
  { id: 'new', label: 'Новинка' },
];

const SEGMENT_HINT = {
  hero: 'можно дольше в ударе',
  stock: 'можно ниже мин. цены',
  new: 'сначала только набор цены',
};

const DECISION_RU = {
  join: 'Войти',
  leave: 'Выйти',
  set_level: 'Бустинг',
  skip: 'Без изменений',
};

const DECISION_COLOR = {
  join: '#16a34a',
  leave: '#dc2626',
  set_level: '#2563eb',
  skip: 'var(--muted)',
};

const PHASE_RU = {
  A: 'A · набор цены',
  B: 'B · удар',
  C: 'C · выход',
};

const hintStyle = {
  fontSize: 13,
  lineHeight: 1.45,
  color: 'var(--muted, #6b7280)',
  margin: '0 0 8px',
};

const boxStyle = {
  marginTop: 12,
  padding: '12px 14px',
  border: '1px solid var(--border, #e5e7eb)',
  borderRadius: 8,
  background: 'rgba(148,163,184,0.08)',
  maxWidth: 920,
};

const sectionHeadStyle = {
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'space-between',
  gap: 12,
  width: '100%',
  padding: '10px 0',
  border: 'none',
  background: 'transparent',
  cursor: 'pointer',
  textAlign: 'left',
  fontSize: 15,
  fontWeight: 600,
  color: 'inherit',
};

function Collapsible({ title, open, onToggle, badge, children }) {
  return (
    <section style={{ marginTop: 8, borderTop: '1px solid var(--border, #e5e7eb)' }}>
      <button type="button" onClick={onToggle} style={sectionHeadStyle} aria-expanded={open}>
        <span>
          {open ? '▼' : '▶'} {title}
          {badge != null && badge !== '' ? (
            <span style={{ marginLeft: 8, fontWeight: 500, color: 'var(--muted)', fontSize: 13 }}>
              {badge}
            </span>
          ) : null}
        </span>
      </button>
      {open ? <div style={{ paddingBottom: 16 }}>{children}</div> : null}
    </section>
  );
}

function productLabel(row) {
  const sku = row.sku || row.product_sku;
  const name = row.offer_name || row.product_name;
  if (sku && name) return `${sku} — ${name}`;
  if (sku) return sku;
  if (name) return name;
  return row.our_product_id != null ? `#${row.our_product_id}` : '—';
}

export function PromoPulse({ embedded = false } = {}) {
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
  const [productQuery, setProductQuery] = useState('');
  const [selectedProduct, setSelectedProduct] = useState(null);
  const [productSuggest, setProductSuggest] = useState([]);
  const [productSuggestOpen, setProductSuggestOpen] = useState(false);
  const [productSearchLoading, setProductSearchLoading] = useState(false);
  const productSuggestRef = useRef(null);
  const [assignCategoryId, setAssignCategoryId] = useState('');
  const [assignSegment, setAssignSegment] = useState('stock');
  const [categories, setCategories] = useState([]);
  const [showHelp, setShowHelp] = useState(false);
  const [openSettings, setOpenSettings] = useState(false);
  const [openSegments, setOpenSegments] = useState(false);
  const [openStates, setOpenStates] = useState(false);
  const [openRuns, setOpenRuns] = useState(false);
  const [showSkip, setShowSkip] = useState(false);

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

  useEffect(() => {
    const q = productQuery.trim();
    if (assignMode !== 'product') return undefined;
    if (!q || (selectedProduct && (q === selectedProduct.sku || q === selectedProduct.name))) {
      setProductSuggest([]);
      setProductSearchLoading(false);
      return undefined;
    }
    let cancelled = false;
    setProductSearchLoading(true);
    const t = setTimeout(async () => {
      const list = await searchProductsCombined(q, { limit: 12 });
      if (!cancelled) {
        setProductSuggest(list);
        setProductSuggestOpen(true);
        setProductSearchLoading(false);
      }
    }, 280);
    return () => {
      cancelled = true;
      clearTimeout(t);
    };
  }, [productQuery, selectedProduct, assignMode]);

  useEffect(() => {
    const onDoc = (e) => {
      if (productSuggestRef.current && !productSuggestRef.current.contains(e.target)) {
        setProductSuggestOpen(false);
      }
    };
    document.addEventListener('mousedown', onDoc);
    return () => document.removeEventListener('mousedown', onDoc);
  }, []);

  const pickProduct = (product) => {
    if (!product?.id) return;
    setSelectedProduct(product);
    setProductQuery(product.sku || product.name || String(product.id));
    setProductSuggest([]);
    setProductSuggestOpen(false);
  };

  const clearPickedProduct = () => {
    setSelectedProduct(null);
    setProductQuery('');
    setProductSuggest([]);
  };

  const savePolicy = async () => {
    if (!policy?.id) return;
    setSaving(true);
    setMessage(null);
    try {
      const res = await promoPulseApi.updatePolicy(policy.id, policy);
      setPolicy(res?.data || policy);
      setMessage('Настройки сохранены');
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
        setMessage('Ошибка: ' + (res?.error || 'предпросмотр'));
        setPreview(null);
      } else {
        setPreview(res);
        setMessage(null);
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
        setMessage('Ошибка: ' + (res?.error || 'прогон'));
      } else {
        setPreview(res);
        setMessage(
          res.notice ||
            `Прогон #${res.runId} записан в журнал. На маркетплейс ничего не ушло.`
        );
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
      setMessage('Снимите режим «Только проверка», сохраните настройки — и снова нажмите «Отправить».');
      setOpenSettings(true);
      return;
    }
    if (
      !window.confirm(
        'Отправить на маркетплейс?\n\nТовары реально войдут в акции, выйдут или сменят цену бустинга.'
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
        setMessage('Ошибка: ' + (res?.error || 'прогон'));
      } else {
        setPreview(res);
        setMessage(res.notice || `Прогон #${res.runId}: отправлено на МП`);
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
      let product = selectedProduct;
      if (!product?.id && productQuery.trim()) {
        const list = await searchProductsCombined(productQuery.trim(), { limit: 5 });
        if (list.length === 1) product = list[0];
        else if (list.length > 1) {
          setProductSuggest(list);
          setProductSuggestOpen(true);
          setMessage('Ошибка: выберите товар из списка — найдено несколько');
          return;
        }
      }
      const productId = Number(product?.id);
      if (!Number.isFinite(productId) || productId < 1) {
        setMessage('Ошибка: найдите и выберите товар по названию, артикулу или штрихкоду');
        return;
      }
      payload.product_id = productId;
    }
    setBusy(true);
    try {
      await promoPulseApi.createAssignment(payload);
      clearPickedProduct();
      setAssignCategoryId('');
      setMessage('Правило сохранено');
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

  const maxBSharePct = Math.round((Number(policy?.max_b_share_30d) || 0.33) * 100);
  const safeMode = policy?.dry_run !== false;

  const previewRows = useMemo(() => {
    const all = Array.isArray(preview?.all) ? preview.all : [];
    if (showSkip) return all;
    return all.filter((r) => r.decision && r.decision !== 'skip');
  }, [preview, showSkip]);

  const counts = preview?.counts || {};
  const lastRun = runs[0] || null;

  if (loading) {
    return embedded
      ? <p className="text-muted">Загрузка…</p>
      : <div className="card"><p className="text-muted">Загрузка…</p></div>;
  }

  return (
    <div className={embedded ? undefined : 'card'} style={embedded ? { marginTop: 4 } : undefined}>
      <div style={{ display: 'flex', justifyContent: 'space-between', gap: 12, flexWrap: 'wrap', alignItems: 'flex-start' }}>
        <div style={{ maxWidth: 640 }}>
          {embedded ? (
            <h2 style={{ fontSize: 18, margin: '0 0 4px' }}>Пульс</h2>
          ) : (
            <h1 className="title">Пульс акций</h1>
          )}
          <p style={{ ...hintStyle, marginBottom: 0 }}>
            Сам чередует вход и выход из акций, чтобы и продажи шли, и медиана цены не падала.
            {!embedded && (
              <>
                {' '}
                <Link to="/prices/promotions">К списку акций</Link>
              </>
            )}
          </p>
        </div>
        <button
          type="button"
          onClick={() => setShowHelp((v) => !v)}
          style={{ fontSize: 13, color: 'var(--primary)', background: 'none', border: 'none', cursor: 'pointer', padding: 4 }}
        >
          {showHelp ? 'Скрыть справку' : 'Как это работает?'}
        </button>
      </div>

      {showHelp && (
        <div style={boxStyle}>
          <p style={{ ...hintStyle, marginBottom: 8, color: 'inherit' }}>
            Цикл для каждого товара: <strong>набор цены</strong> → <strong>удар в акции</strong> →{' '}
            <strong>выход</strong> → снова набор. После выхода на Ozon цена ставится к продажной из
            «Цен» (если нет — к минимальной).
          </p>
          <p style={{ ...hintStyle, marginBottom: 0, color: 'inherit' }}>
            Обычно: 1) посмотреть план → 2) при необходимости записать фазы без МП → 3) снять
            «Только проверка» и отправить. Ночной cron (~1:20 МСК) тоже уважает режим проверки.
            WB умеет только вход.
          </p>
        </div>
      )}

      <div
        style={{
          marginTop: 14,
          display: 'flex',
          gap: 8,
          flexWrap: 'wrap',
          alignItems: 'center',
        }}
      >
        <span
          style={{
            padding: '4px 10px',
            borderRadius: 6,
            fontSize: 13,
            fontWeight: 600,
            background: safeMode ? 'rgba(234,179,8,0.18)' : 'rgba(239,68,68,0.15)',
            border: `1px solid ${safeMode ? 'rgba(202,138,4,0.45)' : 'rgba(220,38,38,0.4)'}`,
          }}
        >
          {safeMode ? 'Режим проверки — на МП не пишем' : 'Боевой режим — пишет на МП'}
        </span>
        {ports.map((p) => (
          <span
            key={p.id}
            title={p.id === 'wb' ? 'Только вход' : p.id === 'ozon' ? 'Вход, выход, бустинг' : 'Вход и выход'}
            style={{
              padding: '4px 8px',
              borderRadius: 6,
              border: '1px solid var(--border,#e5e7eb)',
              fontSize: 12,
              background: p.ready && (policy?.marketplaces || []).includes(p.id)
                ? 'rgba(34,197,94,0.12)'
                : 'transparent',
              color: p.ready ? 'inherit' : 'var(--muted)',
              opacity: p.ready ? 1 : 0.55,
            }}
          >
            {p.label}
            {!p.ready ? ' · нет ключей' : p.id === 'wb' ? ' · вход' : ''}
          </span>
        ))}
        {lastRun && (
          <span style={{ fontSize: 12, color: 'var(--muted)', marginLeft: 'auto' }}>
            Последний прогон: {lastRun.dry_run ? 'без МП' : 'на МП'} ·{' '}
            {new Date(lastRun.started_at).toLocaleString('ru-RU', {
              day: '2-digit',
              month: '2-digit',
              hour: '2-digit',
              minute: '2-digit',
            })}
          </span>
        )}
      </div>

      {message && (
        <p
          style={{
            marginTop: 12,
            marginBottom: 0,
            color: message.startsWith('Ошибка') ? 'var(--danger, #ef4444)' : 'var(--primary)',
            fontSize: 14,
          }}
        >
          {message}
        </p>
      )}

      {/* Главный блок действий */}
      <section style={{ ...boxStyle, marginTop: 16, background: 'transparent' }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', gap: 12, flexWrap: 'wrap', alignItems: 'baseline' }}>
          <h2 style={{ fontSize: 16, margin: 0 }}>Что сделать сейчас</h2>
          <label style={{ fontSize: 12, color: 'var(--muted)', display: 'inline-flex', gap: 6, alignItems: 'center' }}>
            Симуляция фазы
            <select
              value={forcePhase}
              onChange={(e) => setForcePhase(e.target.value)}
              style={{ fontSize: 12 }}
              title="Только для проверки «что было бы», если у всех сейчас эта фаза"
            >
              <option value="">Как по календарю</option>
              <option value="A">Все в A</option>
              <option value="B">Все в B</option>
              <option value="C">Все в C</option>
            </select>
          </label>
        </div>

        <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', marginTop: 12 }}>
          <Button type="button" variant="primary" onClick={runPreview} disabled={busy || !policy}>
            {busy ? '…' : '1. Посмотреть план'}
          </Button>
          <Button type="button" variant="secondary" onClick={runDry} disabled={busy || !policy}>
            2. Записать фазы (без МП)
          </Button>
          <Button
            type="button"
            variant="primary"
            onClick={runLive}
            disabled={busy || !policy || safeMode}
            title={safeMode ? 'Сначала снимите «Только проверка» в настройках' : 'Отправить на маркетплейс'}
          >
            3. Отправить на МП
          </Button>
        </div>
        <p style={{ ...hintStyle, marginTop: 8, marginBottom: 0 }}>
          Шаг 1 ничего не меняет. Шаг 2 двигает календарь фаз в ERP. Шаг 3 — реальные изменения на
          площадке (нужен боевой режим).
        </p>

        {preview && (
          <div
            style={{
              marginTop: 14,
              display: 'flex',
              gap: 8,
              flexWrap: 'wrap',
              alignItems: 'center',
            }}
          >
            <CountChip label="выйти" value={counts.leave || 0} color={DECISION_COLOR.leave} />
            <CountChip label="войти" value={counts.join || 0} color={DECISION_COLOR.join} />
            <CountChip label="бустинг" value={counts.set_level || 0} color={DECISION_COLOR.set_level} />
            <CountChip label="без изменений" value={counts.skip || 0} color="var(--muted)" />
            <label style={{ marginLeft: 'auto', fontSize: 12, display: 'inline-flex', gap: 6, alignItems: 'center' }}>
              <input type="checkbox" checked={showSkip} onChange={(e) => setShowSkip(e.target.checked)} />
              Показать «без изменений»
            </label>
          </div>
        )}

        {preview?.errors?.length > 0 && (
          <ul style={{ fontSize: 13, color: 'var(--danger, #ef4444)', marginTop: 8 }}>
            {preview.errors.map((err, i) => (
              <li key={i}>{err.marketplace}: {err.error}</li>
            ))}
          </ul>
        )}

        {previewRows.length > 0 ? (
          <div className="prices-table-container" style={{ overflowX: 'auto', marginTop: 12 }}>
            <table className="prices-table table">
              <thead>
                <tr>
                  <th>Товар</th>
                  <th>Действие</th>
                  <th>Цена</th>
                  <th>МП / акция</th>
                  <th>Почему</th>
                </tr>
              </thead>
              <tbody>
                {previewRows.slice(0, 200).map((row, idx) => (
                  <tr key={`${row.marketplace}-${row.action_id}-${row.our_product_id}-${idx}`}>
                    <td style={{ maxWidth: 260 }} title={productLabel(row)}>
                      <div style={{ fontWeight: 500, overflow: 'hidden', textOverflow: 'ellipsis' }}>
                        {productLabel(row)}
                      </div>
                      <div style={{ fontSize: 11, color: 'var(--muted)' }}>
                        {PHASE_RU[row.phase] || row.phase}
                        {row.segment && row.segment !== 'normal' ? ` · ${SEGMENTS.find((s) => s.id === row.segment)?.label || row.segment}` : ''}
                      </div>
                    </td>
                    <td>
                      <span style={{ color: DECISION_COLOR[row.decision] || 'inherit', fontWeight: 600 }}>
                        {DECISION_RU[row.decision] || row.decision}
                      </span>
                      {row.target_level != null ? (
                        <span style={{ fontSize: 12, color: 'var(--muted)' }}> {row.target_level}%</span>
                      ) : null}
                    </td>
                    <td>{row.target_price != null ? `${row.target_price} ₽` : '—'}</td>
                    <td style={{ fontSize: 12, maxWidth: 200 }}>
                      <div>{row.marketplace}</div>
                      <div
                        style={{ color: 'var(--muted)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}
                        title={row.action_title || row.action_id}
                      >
                        {row.action_title || row.action_id}
                      </div>
                    </td>
                    <td style={{ fontSize: 12, color: 'var(--muted)', maxWidth: 280 }} title={row.reason}>
                      {row.reason}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
            {previewRows.length > 200 && (
              <p className="text-muted small">Показаны первые 200 из {previewRows.length}</p>
            )}
          </div>
        ) : preview ? (
          <p className="text-muted" style={{ marginTop: 12, marginBottom: 0 }}>
            Сейчас менять нечего. Попробуйте симуляцию фазы B или проверьте список акций.
          </p>
        ) : (
          <p className="text-muted" style={{ marginTop: 12, marginBottom: 0 }}>
            Нажмите «Посмотреть план», чтобы увидеть, что пульс сделает.
          </p>
        )}
      </section>

      {policy && (
        <Collapsible
          title="Настройки"
          open={openSettings}
          onToggle={() => setOpenSettings((v) => !v)}
          badge={safeMode ? 'проверка' : 'боевой'}
        >
          <p style={hintStyle}>После правок нажмите «Сохранить».</p>
          <div style={{ display: 'grid', gap: 12, maxWidth: 820 }}>
            <div>
              <div style={{ fontSize: 13, marginBottom: 6 }}>Маркетплейсы</div>
              <div style={{ display: 'flex', gap: 12, flexWrap: 'wrap' }}>
                {ports.map((p) => (
                  <label
                    key={p.id}
                    style={{ display: 'inline-flex', gap: 4, alignItems: 'center', fontSize: 13, opacity: p.ready ? 1 : 0.5 }}
                  >
                    <input
                      type="checkbox"
                      checked={(policy.marketplaces || []).includes(p.id)}
                      disabled={!p.ready}
                      onChange={() => toggleMp(p.id)}
                    />
                    {p.label}
                  </label>
                ))}
              </div>
            </div>

            <div style={{ display: 'flex', gap: 16, flexWrap: 'wrap' }}>
              <label style={{ fontSize: 13 }}>
                Дней набор (A)
                <br />
                <input
                  type="number"
                  min={1}
                  max={90}
                  value={policy.phase_a_days}
                  onChange={(e) => setPolicy({ ...policy, phase_a_days: Number(e.target.value) })}
                  style={{ width: 72, marginTop: 4 }}
                />
              </label>
              <label style={{ fontSize: 13 }}>
                Дней удар (B)
                <br />
                <input
                  type="number"
                  min={1}
                  max={60}
                  value={policy.phase_b_days}
                  onChange={(e) => setPolicy({ ...policy, phase_b_days: Number(e.target.value) })}
                  style={{ width: 72, marginTop: 4 }}
                />
              </label>
              <label style={{ fontSize: 13 }}>
                Дней выход (C)
                <br />
                <input
                  type="number"
                  min={1}
                  max={30}
                  value={phaseCDays}
                  onChange={(e) => setPhaseCDays(e.target.value)}
                  style={{ width: 72, marginTop: 4 }}
                />
              </label>
              <label style={{ fontSize: 13 }} title="Если за 30 дней товар слишком долго в ударе — выводим">
                Макс. удар за 30 дн.
                <br />
                <input
                  type="number"
                  min={0.05}
                  max={1}
                  step={0.01}
                  value={policy.max_b_share_30d}
                  onChange={(e) => setPolicy({ ...policy, max_b_share_30d: Number(e.target.value) })}
                  style={{ width: 72, marginTop: 4 }}
                />
                <span style={{ marginLeft: 6, color: 'var(--muted)' }}>≈ {maxBSharePct}%</span>
              </label>
            </div>

            <label style={{ fontSize: 13, display: 'flex', gap: 8, alignItems: 'flex-start' }}>
              <input
                type="checkbox"
                checked={policy.require_profit_ge_markup !== false}
                onChange={(e) => setPolicy({ ...policy, require_profit_ge_markup: e.target.checked })}
                style={{ marginTop: 3 }}
              />
              <span>Не заходить, если прибыль меньше мин. наценки</span>
            </label>
            <label style={{ fontSize: 13, display: 'flex', gap: 8, alignItems: 'flex-start' }}>
              <input
                type="checkbox"
                checked={policy.allow_below_floor_stock === true}
                onChange={(e) => setPolicy({ ...policy, allow_below_floor_stock: e.target.checked })}
                style={{ marginTop: 3 }}
              />
              <span>Сток в ударе: можно ниже мин. цены</span>
            </label>
            <label style={{ fontSize: 13, display: 'flex', gap: 8, alignItems: 'flex-start' }}>
              <input
                type="checkbox"
                checked={policy.dry_run !== false}
                onChange={(e) => setPolicy({ ...policy, dry_run: e.target.checked })}
                style={{ marginTop: 3 }}
              />
              <span>
                <strong>Только проверка</strong> — cron и кнопки не пишут на МП
              </span>
            </label>
            <div>
              <Button type="button" variant="secondary" onClick={savePolicy} disabled={saving}>
                {saving ? 'Сохранение…' : 'Сохранить настройки'}
              </Button>
            </div>
          </div>
        </Collapsible>
      )}

      <Collapsible
        title="Особые товары"
        open={openSegments}
        onToggle={() => setOpenSegments((v) => !v)}
        badge={assignments.length ? `${assignments.length}` : 'все обычные'}
      >
        <p style={hintStyle}>
          По умолчанию все «Обычные». Исключения: хит, сток, новинка — для товара или категории.
        </p>
        <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'flex-start', marginBottom: 12 }}>
          <select
            value={assignMode}
            onChange={(e) => {
              setAssignMode(e.target.value);
              clearPickedProduct();
            }}
            style={{ marginTop: 2 }}
          >
            <option value="product">Товар</option>
            <option value="category">Категория</option>
          </select>
          {assignMode === 'product' ? (
            <div
              className="price-history-search"
              ref={productSuggestRef}
              style={{ position: 'relative', minWidth: 260, flex: '1 1 260px' }}
            >
              <input
                value={productQuery}
                onChange={(e) => {
                  setProductQuery(e.target.value);
                  setSelectedProduct(null);
                }}
                onFocus={() => productSuggest.length && setProductSuggestOpen(true)}
                placeholder="Название, артикул или штрихкод…"
                autoComplete="off"
                style={{ width: '100%' }}
                onKeyDown={(e) => {
                  if (e.key !== 'Enter') return;
                  e.preventDefault();
                  if (productSuggest.length === 1) pickProduct(productSuggest[0]);
                  else if (selectedProduct) addAssignment();
                }}
              />
              {productSearchLoading && (
                <p className="text-muted small" style={{ margin: '4px 0 0' }}>Поиск…</p>
              )}
              {selectedProduct && !productSuggestOpen && (
                <p className="text-muted small" style={{ margin: '4px 0 0' }}>
                  Выбран: {selectedProduct.sku || `#${selectedProduct.id}`}
                  {selectedProduct.name ? ` — ${selectedProduct.name}` : ''}{' '}
                  <button type="button" onClick={clearPickedProduct} style={{ fontSize: 12 }}>
                    сбросить
                  </button>
                </p>
              )}
              {productSuggestOpen && productSuggest.length > 0 && (
                <ul className="price-history-suggest" style={{ zIndex: 20 }}>
                  {productSuggest.map((p) => (
                    <li key={p.id}>
                      <button type="button" onClick={() => pickProduct(p)}>
                        <div className="sku">{p.sku || `#${p.id}`}</div>
                        <div className="name">{p.name || '—'}</div>
                      </button>
                    </li>
                  ))}
                </ul>
              )}
            </div>
          ) : (
            <select
              value={assignCategoryId}
              onChange={(e) => setAssignCategoryId(e.target.value)}
              style={{ maxWidth: 280, marginTop: 2 }}
            >
              <option value="">Выберите категорию…</option>
              {categories.map((c) => (
                <option key={c.id} value={c.id}>{c.name || c.path || `#${c.id}`}</option>
              ))}
            </select>
          )}
          <select value={assignSegment} onChange={(e) => setAssignSegment(e.target.value)} style={{ marginTop: 2 }}>
            {SEGMENTS.filter((s) => s.id !== 'normal').map((s) => (
              <option key={s.id} value={s.id}>
                {s.label}{SEGMENT_HINT[s.id] ? ` — ${SEGMENT_HINT[s.id]}` : ''}
              </option>
            ))}
          </select>
          <Button type="button" variant="secondary" onClick={addAssignment} disabled={busy} style={{ marginTop: 2 }}>
            Добавить
          </Button>
        </div>
        {assignments.length === 0 ? (
          <p className="text-muted" style={{ margin: 0 }}>Правил нет.</p>
        ) : (
          <ul style={{ fontSize: 13, margin: 0, paddingLeft: 18 }}>
            {assignments.map((a) => (
              <li key={a.id} style={{ marginBottom: 4 }}>
                {SEGMENTS.find((s) => s.id === a.segment)?.label || a.segment}
                {a.product_id ? ` · ${a.product_sku || a.product_id}` : ''}
                {a.user_category_id ? ` · ${a.category_name || a.user_category_id}` : ''}
                {' '}
                <button type="button" onClick={() => removeAssignment(a.id)} style={{ fontSize: 12 }}>
                  удалить
                </button>
              </li>
            ))}
          </ul>
        )}
      </Collapsible>

      <Collapsible
        title="Фазы товаров"
        open={openStates}
        onToggle={() => setOpenStates((v) => !v)}
        badge={states.length ? `${Math.min(states.length, 50)}${states.length > 50 ? '+' : ''}` : 'пусто'}
      >
        <p style={hintStyle}>После записанного прогона — где каждый товар в цикле A→B→C.</p>
        {states.length === 0 ? (
          <p className="text-muted" style={{ margin: 0 }}>Пока пусто — сделайте шаг 2 «Записать фазы».</p>
        ) : (
          <div className="prices-table-container" style={{ overflowX: 'auto' }}>
            <table className="prices-table table">
              <thead>
                <tr>
                  <th>Товар</th>
                  <th>Фаза</th>
                  <th>С</th>
                  <th>МП</th>
                  <th>Последнее</th>
                </tr>
              </thead>
              <tbody>
                {states.slice(0, 50).map((s) => (
                  <tr key={s.id}>
                    <td>{s.product_sku || s.our_product_id || '—'}</td>
                    <td>{PHASE_RU[s.phase] || s.phase}</td>
                    <td style={{ fontSize: 12 }}>
                      {s.phase_started_at ? new Date(s.phase_started_at).toLocaleDateString('ru-RU') : '—'}
                    </td>
                    <td style={{ fontSize: 12 }}>{s.marketplace} · {s.action_external_id}</td>
                    <td style={{ fontSize: 12, color: 'var(--muted)' }}>
                      {DECISION_RU[s.last_decision?.type] || s.last_decision?.type || '—'}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Collapsible>

      <Collapsible
        title="Журнал"
        open={openRuns}
        onToggle={() => setOpenRuns((v) => !v)}
        badge={runs.length ? `${Math.min(runs.length, 10)}` : null}
      >
        {runs.length === 0 ? (
          <p className="text-muted" style={{ margin: 0 }}>Прогонов ещё не было.</p>
        ) : (
          <ul style={{ fontSize: 13, margin: 0, paddingLeft: 18 }}>
            {runs.slice(0, 10).map((r) => (
              <li key={r.id} style={{ marginBottom: 4 }}>
                #{r.id} · {r.dry_run ? 'без МП' : 'на МП'} · {r.status} ·{' '}
                {new Date(r.started_at).toLocaleString('ru-RU')}
                {r.counts ? (
                  <>
                    {' · '}
                    ↓{r.counts.leave || 0} ↑{r.counts.join || 0} ⚡{r.counts.set_level || 0}
                  </>
                ) : null}
              </li>
            ))}
          </ul>
        )}
      </Collapsible>

      {!policies.length && (
        <p className="text-muted" style={{ marginTop: 16 }}>
          Настройки появятся автоматически при первой загрузке.
        </p>
      )}
    </div>
  );
}

function CountChip({ label, value, color }) {
  return (
    <span
      style={{
        padding: '4px 10px',
        borderRadius: 6,
        border: '1px solid var(--border,#e5e7eb)',
        fontSize: 13,
      }}
    >
      <strong style={{ color }}>{value}</strong>
      <span style={{ color: 'var(--muted)', marginLeft: 6 }}>{label}</span>
    </span>
  );
}
