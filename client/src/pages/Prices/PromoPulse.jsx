/**
 * Пульс акций — автоматическое участие в акциях по фазам A/B/C.
 */

import React, { useCallback, useEffect, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import { Button } from '../../components/common/Button/Button';
import { promoPulseApi } from '../../services/promoPulse.api.js';
import { categoriesApi } from '../../services/categories.api.js';
import { searchProductsCombined } from '../../utils/productSearch.js';
import './Prices.css';
import './PriceHistory.css';

const SEGMENTS = [
  { id: 'normal', label: 'Обычный' },
  { id: 'hero', label: 'Хит — можно дольше в ударе' },
  { id: 'stock', label: 'Сток — можно ниже мин. цены' },
  { id: 'new', label: 'Новинка — сначала только набор цены' },
];

const DECISION_RU = {
  join: 'Войти в акцию',
  leave: 'Выйти из акции',
  set_level: 'Поставить уровень бустинга',
  skip: 'Ничего не делать',
};

const hintStyle = {
  fontSize: 13,
  lineHeight: 1.45,
  color: 'var(--muted, #6b7280)',
  margin: '0 0 8px',
};

const boxStyle = {
  marginTop: 16,
  padding: '14px 16px',
  border: '1px solid var(--border, #e5e7eb)',
  borderRadius: 8,
  background: 'rgba(148,163,184,0.08)',
  maxWidth: 820,
};

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
  const [showHelp, setShowHelp] = useState(true);

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
        setMessage(
          `Предпросмотр (ничего не меняли на МП): войти ${res.counts?.join || 0}, бустинг ${res.counts?.set_level || 0}, выйти ${res.counts?.leave || 0}, без действия ${res.counts?.skip || 0}`
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
        setMessage('Ошибка: ' + (res?.error || 'прогон'));
      } else {
        setPreview(res);
        setMessage(
          res.notice ||
            `Прогон #${res.runId} сохранён в журнал. На маркетплейс ничего не отправляли.`
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
      setMessage(
        'Сначала снимите галку «Только проверка, без записи на МП», сохраните настройки — и тогда можно отправлять.'
      );
      return;
    }
    if (
      !window.confirm(
        'Отправить решения на маркетплейс?\n\nТовары могут войти в акции, выйти из них или сменить цену бустинга. Это уже реальное изменение.'
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
        setMessage(res.notice || `Прогон #${res.runId}: команды отправлены на МП`);
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
      setMessage('Правило сегмента сохранено');
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

  if (loading) {
    return embedded
      ? <p className="text-muted">Загрузка…</p>
      : <div className="card"><p className="text-muted">Загрузка…</p></div>;
  }

  const actionable = (preview?.all || []).filter((r) => r.decision && r.decision !== 'skip');

  return (
    <div className={embedded ? undefined : 'card'} style={embedded ? { marginTop: 4 } : undefined}>
      <div style={{ display: 'flex', justifyContent: 'space-between', gap: 12, flexWrap: 'wrap' }}>
        <div>
          {embedded ? (
            <h2 style={{ fontSize: 18, margin: '0 0 4px' }}>Пульс акций</h2>
          ) : (
            <h1 className="title">Пульс акций</h1>
          )}
          <p className={embedded ? undefined : 'subtitle'} style={{ maxWidth: 720, ...(embedded ? hintStyle : {}) }}>
            Автоматически решает, какие товары в каких акциях держать, чтобы и в акциях участвовать,
            и среднюю цену (медиану) не ронять слишком сильно.
            {!embedded && (
              <>
                {' '}
                <Link to="/prices/promotions">Ручные акции</Link>
                {' · '}
                <Link to="/prices/strategies">Стратегии цен</Link>
              </>
            )}
          </p>
        </div>
        <Button type="button" variant="secondary" onClick={() => setShowHelp((v) => !v)}>
          {showHelp ? 'Скрыть справку' : 'Как это работает'}
        </Button>
      </div>

      {showHelp && (
        <div style={boxStyle}>
          <p style={{ ...hintStyle, marginBottom: 10, color: 'inherit' }}>
            <strong>Зачем.</strong> Если всегда сидеть на максимальном бустинге — медиана цены падает,
            и потом в акции сложнее попасть выгодно. Пульс чередует три режима для каждого товара в акции:
          </p>
          <ol style={{ ...hintStyle, margin: '0 0 12px', paddingLeft: 20, color: 'inherit' }}>
            <li>
              <strong>A — набор цены</strong> ({policy?.phase_a_days || 14} дн.): из эластичных акций
              выходим или не заходим глубоко, чтобы «обычная» цена подросла.
            </li>
            <li>
              <strong>B — удар</strong> ({policy?.phase_b_days || 7} дн.): входим на лучший допустимый
              бустинг / цену акции (не ниже пола и не ниже мин. наценки, если так настроено).
            </li>
            <li>
              <strong>C — выход</strong> ({phaseCDays} дн.): выходим из акции, затем снова A.
            </li>
          </ol>
          <p style={{ ...hintStyle, marginBottom: 10, color: 'inherit' }}>
            <strong>Безопасность.</strong> По умолчанию включена только проверка: решения считаются,
            на Ozon / WB / YM ничего не пишется. Ночной cron (~1:20 МСК) тоже уважает эту галку.
            Реальная отправка — только после снятия «Только проверка» и кнопки «Отправить на МП».
          </p>
          <p style={{ ...hintStyle, marginBottom: 0, color: 'inherit' }}>
            <strong>Отличия МП.</strong> Ozon — вход, выход и уровни бустинга. Яндекс — вход и выход.
            Wildberries — только вход (их API не умеет вывести из акции этим способом).
          </p>
        </div>
      )}

      {message && (
        <p style={{ marginTop: 12, color: message.startsWith('Ошибка') ? 'var(--danger,#ef4444)' : 'var(--primary)' }}>
          {message}
        </p>
      )}

      <div style={{ marginTop: 16, display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'center' }}>
        <span style={{ fontSize: 13, color: 'var(--muted)' }}>Подключено:</span>
        {ports.map((p) => (
          <span
            key={p.id}
            title={
              p.id === 'ozon'
                ? 'Вход, выход, бустинг'
                : p.id === 'wb'
                  ? 'Только вход в акцию'
                  : 'Вход и выход'
            }
            style={{
              padding: '4px 10px',
              borderRadius: 6,
              border: '1px solid var(--border,#e5e7eb)',
              fontSize: 13,
              background: p.ready ? 'rgba(34,197,94,0.12)' : 'rgba(148,163,184,0.15)',
              color: p.ready ? 'inherit' : 'var(--muted)',
            }}
          >
            {p.label}
            {p.id === 'wb' ? ' · только вход' : ''}
          </span>
        ))}
      </div>

      {policy && (
        <section style={{ marginTop: 24, maxWidth: 820 }}>
          <h2 style={{ fontSize: 16, marginBottom: 4 }}>Настройки цикла</h2>
          <p style={hintStyle}>
            Сколько дней товар живёт в каждой фазе и какие ограничения на цену. После правок нажмите
            «Сохранить».
          </p>
          <div style={{ display: 'grid', gap: 12 }}>
            <div>
              <div style={{ fontSize: 13, marginBottom: 6 }}>Маркетплейсы в этом пульсе</div>
              <div style={{ display: 'flex', gap: 12, flexWrap: 'wrap' }}>
                {ports.map((p) => (
                  <label key={p.id} style={{ display: 'inline-flex', gap: 4, alignItems: 'center', fontSize: 13, opacity: p.ready ? 1 : 0.5 }}>
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
                Дней в фазе A (набор)
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
                Дней в фазе B (удар)
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
                Дней в фазе C (выход)
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
              <label style={{ fontSize: 13 }} title="Если за 30 дней товар уже слишком долго был в ударе — принудительно выводим">
                Макс. доля удара за 30 дней
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
            <p style={hintStyle}>
              Пример: доля 0,33 ≈ не больше трети месяца в фазе B. Хиты (сегмент «Хит») этот лимит не
              режет.
            </p>

            <label style={{ fontSize: 13, display: 'flex', gap: 8, alignItems: 'flex-start' }}>
              <input
                type="checkbox"
                checked={policy.require_profit_ge_markup !== false}
                onChange={(e) => setPolicy({ ...policy, require_profit_ge_markup: e.target.checked })}
                style={{ marginTop: 3 }}
              />
              <span>
                Не заходить в акцию, если прибыль меньше мин. наценки из карточки
                <br />
                <span style={hintStyle}>Защита от убыточных уровней бустинга.</span>
              </span>
            </label>
            <label style={{ fontSize: 13, display: 'flex', gap: 8, alignItems: 'flex-start' }}>
              <input
                type="checkbox"
                checked={policy.allow_below_floor_stock === true}
                onChange={(e) => setPolicy({ ...policy, allow_below_floor_stock: e.target.checked })}
                style={{ marginTop: 3 }}
              />
              <span>
                Для сегмента «Сток» в фазе B разрешить цену ниже минимальной
                <br />
                <span style={hintStyle}>Только если товару явно назначен сегмент «Сток».</span>
              </span>
            </label>
            <label style={{ fontSize: 13, display: 'flex', gap: 8, alignItems: 'flex-start' }}>
              <input
                type="checkbox"
                checked={policy.dry_run !== false}
                onChange={(e) => setPolicy({ ...policy, dry_run: e.target.checked })}
                style={{ marginTop: 3 }}
              />
              <span>
                Только проверка, без записи на маркетплейс
                <br />
                <span style={hintStyle}>
                  Рекомендуем держать включённой, пока не убедитесь по предпросмотру. Снимите и
                  сохраните — тогда появится кнопка реальной отправки.
                </span>
              </span>
            </label>
            <div>
              <Button type="button" variant="secondary" onClick={savePolicy} disabled={saving}>
                {saving ? 'Сохранение…' : 'Сохранить настройки'}
              </Button>
            </div>
          </div>
        </section>
      )}

      <section style={{ marginTop: 28 }}>
        <h2 style={{ fontSize: 16, marginBottom: 4 }}>Что сделает пульс сейчас</h2>
        <p style={hintStyle}>
          Сначала смотрите предпросмотр. «Сохранить прогон» запишет решения в журнал и сдвинет фазы,
          но на МП не отправит. «Отправить на МП» — уже реальные изменения (нужно снять галку проверки).
        </p>
        <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'center', marginBottom: 12 }}>
          <label style={{ fontSize: 13 }}>
            Показать, как будто сейчас фаза{' '}
            <select value={forcePhase} onChange={(e) => setForcePhase(e.target.value)}>
              <option value="">Как по календарю у товара</option>
              <option value="A">A — набор цены</option>
              <option value="B">B — удар</option>
              <option value="C">C — выход</option>
            </select>
          </label>
          <Button type="button" variant="primary" onClick={runPreview} disabled={busy || !policy}>
            {busy ? '…' : 'Предпросмотр'}
          </Button>
          <Button type="button" variant="secondary" onClick={runDry} disabled={busy || !policy}>
            Сохранить прогон (без МП)
          </Button>
          <Button
            type="button"
            variant="primary"
            onClick={runLive}
            disabled={busy || !policy || policy.dry_run !== false}
            title={
              policy?.dry_run !== false
                ? 'Снимите «Только проверка» и сохраните'
                : 'Отправить решения на маркетплейс'
            }
          >
            Отправить на МП
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
                  <th title="Сколько дней за 30 суток товар уже был в ударе (B)">Дней удара / 30</th>
                  <th>Действие</th>
                  <th>Цена</th>
                  <th>Бустинг</th>
                  <th>Почему</th>
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
                    <td>{DECISION_RU[row.decision] || row.decision}</td>
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
          <p className="text-muted">
            Сейчас нечего менять (все решения «ничего не делать»). Попробуйте симуляцию фазы B или
            проверьте, что товары есть в акциях на вкладке «Акции».
          </p>
        ) : null}
      </section>

      <section style={{ marginTop: 28, maxWidth: 820 }}>
        <h2 style={{ fontSize: 16, marginBottom: 4 }}>Особые товары (сегменты)</h2>
        <p style={hintStyle}>
          По умолчанию все товары «Обычные». Можно назначить исключение товару или целой категории
          (сначала смотрим товар, потом категорию).
        </p>
        <ul style={{ ...hintStyle, paddingLeft: 18, marginBottom: 12 }}>
          <li><strong>Хит</strong> — можно дольше держать удар, лимит доли B не срабатывает.</li>
          <li><strong>Сток</strong> — в ударе можно уйти ниже мин. цены (если галка выше включена).</li>
          <li><strong>Новинка</strong> — пока держим режим набора цены (A), без глубокого бустинга.</li>
        </ul>
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
            <div className="price-history-search" ref={productSuggestRef} style={{ position: 'relative', minWidth: 260, flex: '1 1 260px' }}>
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
                  {selectedProduct.name ? ` — ${selectedProduct.name}` : ''}
                  {' '}
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
            {SEGMENTS.map((s) => (
              <option key={s.id} value={s.id}>{s.label}</option>
            ))}
          </select>
          <Button type="button" variant="secondary" onClick={addAssignment} disabled={busy} style={{ marginTop: 2 }}>
            Добавить правило
          </Button>
        </div>
        {assignments.length === 0 ? (
          <p className="text-muted">Правил нет — все товары в сегменте «Обычный».</p>
        ) : (
          <ul style={{ fontSize: 13 }}>
            {assignments.map((a) => (
              <li key={a.id} style={{ display: 'flex', gap: 8, alignItems: 'center', marginBottom: 4 }}>
                <span>
                  {SEGMENTS.find((s) => s.id === a.segment)?.label || a.segment}
                  {a.product_id ? ` · товар ${a.product_sku || a.product_id}` : ''}
                  {a.user_category_id ? ` · категория ${a.category_name || a.user_category_id}` : ''}
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

      <section style={{ marginTop: 28 }}>
        <h2 style={{ fontSize: 16, marginBottom: 4 }}>Где сейчас каждый товар</h2>
        <p style={hintStyle}>
          После сохранённого прогона здесь видно текущую фазу по связке «товар + акция». От неё
          считается календарь A → B → C.
        </p>
        {states.length === 0 ? (
          <p className="text-muted">Пока пусто — сделайте «Сохранить прогон (без МП)».</p>
        ) : (
          <div className="prices-table-container" style={{ overflowX: 'auto' }}>
            <table className="prices-table table">
              <thead>
                <tr>
                  <th>МП</th>
                  <th>Акция</th>
                  <th>Товар</th>
                  <th>Фаза</th>
                  <th>С какой даты</th>
                  <th>Последнее решение</th>
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
                      {DECISION_RU[s.last_decision?.type] || s.last_decision?.type || '—'}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>

      <section style={{ marginTop: 28 }}>
        <h2 style={{ fontSize: 16, marginBottom: 4 }}>Журнал прогонов</h2>
        <p style={hintStyle}>История ручных и ночных прогонов. «без МП» = только расчёт и фазы.</p>
        {runs.length === 0 ? (
          <p className="text-muted">Прогонов ещё не было.</p>
        ) : (
          <ul style={{ fontSize: 13 }}>
            {runs.slice(0, 10).map((r) => (
              <li key={r.id}>
                #{r.id} · {r.dry_run ? 'без МП' : 'на МП'} · {r.status} ·{' '}
                {new Date(r.started_at).toLocaleString('ru-RU')}
                {r.counts ? (
                  <>
                    {' · '}
                    войти {r.counts.join || 0}, бустинг {r.counts.set_level || 0}, выйти {r.counts.leave || 0}
                  </>
                ) : null}
              </li>
            ))}
          </ul>
        )}
      </section>

      {!policies.length && (
        <p className="text-muted" style={{ marginTop: 16 }}>
          Настройки появятся автоматически при первой загрузке.
        </p>
      )}
    </div>
  );
}
