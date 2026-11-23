/**
 * Pricing Strategies Page
 * Расчёт + где применяется — всё внутри карточки стратегии.
 */

import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { Button } from '../../components/common/Button/Button';
import { Modal } from '../../components/common/Modal/Modal';
import { pricingStrategiesApi } from '../../services/pricingStrategies.api.js';
import { brandsApi } from '../../services/brands.api.js';
import { userCategoriesApi } from '../../services/userCategories.api.js';
import { productsApi } from '../../services/products.api.js';
import './PricingStrategies.css';

const MODE_LABELS = {
  floor: 'Минимум (пол)',
  target_margin: 'Целевая маржа',
  competitor: 'От конкурентов (WB/YM)',
  sales: 'От продаж',
  hybrid: 'Гибрид: конкуренты + продажи',
};

const SCOPE_LABELS = {
  product: 'Товар',
  brand: 'Бренд',
  category: 'Категория',
  profile: 'Весь кабинет',
};

const MP_LABELS = {
  ozon: 'Ozon',
  wb: 'Wildberries',
  ym: 'Яндекс Маркет',
};

function emptyForm(defaultsHybrid) {
  return {
    name: '',
    description: '',
    mode: 'hybrid',
    is_active: true,
    is_default: false,
    assignments: [],
    config: defaultsHybrid || {
      target_margin_percent: 25,
      competitor: {
        enabled: true,
        agg: 'min',
        offset_rub: 0,
        offset_percent: -1,
        if_missing: 'keep_base',
      },
      sales: {
        enabled: true,
        window_days: 14,
        high_per_day: 1,
        low_per_day: 0.1,
        high_step_percent: 3,
        low_step_percent: 5,
        mid_action: 'hold',
      },
      band_percent: 2,
      max_change_percent: 12,
      always_above_floor: true,
    },
  };
}

function assignmentKey(item) {
  return `${item.scopeType}:${item.scopeId ?? ''}:${item.marketplace || ''}`;
}

function formatAssignment(item) {
  const scope = SCOPE_LABELS[item.scopeType] || item.scopeType;
  const name =
    item.scopeType === 'profile'
      ? ''
      : item.scopeName
        ? `: ${item.scopeName}`
        : item.scopeId
          ? `: #${item.scopeId}`
          : '';
  const mp = item.marketplace ? ` · ${MP_LABELS[item.marketplace] || item.marketplace}` : ' · все МП';
  return `${scope}${name}${mp}`;
}

/** Подпись поля с подсказкой при наведении (подсказка только на тексте, не на select/input внутри). */
function FieldLabel({ children, hint, className = 'form-label' }) {
  const text = String(hint || '').trim();
  const kids = React.Children.toArray(children);
  const titleNode = kids[0];
  const rest = kids.slice(1);
  return (
    <label className={className}>
      <span className={text ? 'pricing-field-label-hint' : undefined}>
        {titleNode}
        {text ? (
          <span className="pricing-field-info-hint" role="tooltip">
            {text}
          </span>
        ) : null}
      </span>
      {rest}
    </label>
  );
}

const FIELD_HINTS = {
  name: 'Короткое имя стратегии в списке и в подсказках на странице «Цены».',
  mode: 'Как считается фактическая цена: от пола, маржи, конкурентов, продаж или гибрид.',
  description: 'Пояснение для себя — на расчёт не влияет.',
  target_margin:
    'Желаемая валовая маржа от себестоимости: цена ≈ себестоимость / (1 − %). Не опускается ниже рассчитанного минимума (пола).',
  band_percent:
    'Если новая цена отличается от текущей меньше чем на этот %, цену не меняем — чтобы не дёргать карточку из‑за мелких колебаний.',
  max_change_percent:
    'За один пересчёт цена может вырасти или упасть не больше чем на этот % от текущей. Крупные сдвиги растягиваются на несколько шагов.',
  competitor_agg: 'Какую цену конкурентов берём за ориентир: минимум, медиану или среднее.',
  competitor_offset_percent:
    'Сдвиг относительно цены конкурентов в процентах. Отрицательное значение — чуть дешевле конкурентов.',
  competitor_offset_rub:
    'Дополнительный сдвиг в рублях после процентного. Можно комбинировать с «Отступ, %».',
  sales_window: 'За сколько последних дней считаем среднюю скорость продаж (доставлено FBS).',
  sales_high: 'Если продаж в день больше этого порога — считаем спрос высоким и поднимаем цену.',
  sales_low: 'Если продаж в день меньше этого порога — считаем спрос слабым и снижаем цену.',
  sales_high_step: 'На сколько % поднимаем цену при высоких продажах (за один пересчёт, с учётом лимита шага).',
  sales_low_step: 'На сколько % снижаем цену при низких продажах (не ниже пола).',
  apply_scope: 'На что вешать эту стратегию: товар, бренд, категория или весь кабинет.',
  apply_marketplace:
    'Ограничить назначение одним маркетплейсом или оставить «Все МП». Узкое правило (товар+МП) сильнее широкого.',
};

export function PricingStrategies() {
  const [list, setList] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [defaults, setDefaults] = useState(null);
  const [settings, setSettings] = useState({ enabled: true, defaultStrategy: null });
  const [settingsSaving, setSettingsSaving] = useState(false);
  const [modalOpen, setModalOpen] = useState(false);
  const [editing, setEditing] = useState(null);
  const [form, setForm] = useState(() => emptyForm());
  const [saving, setSaving] = useState(false);
  const [message, setMessage] = useState(null);
  const [brands, setBrands] = useState([]);
  const [categories, setCategories] = useState([]);

  const [addScopeType, setAddScopeType] = useState('brand');
  const [addScopeId, setAddScopeId] = useState('');
  const [addMarketplace, setAddMarketplace] = useState('');
  const [productQuery, setProductQuery] = useState('');
  const [productHits, setProductHits] = useState([]);
  const [productSearching, setProductSearching] = useState(false);

  const load = useCallback(async () => {
    try {
      setLoading(true);
      setError(null);
      const [listRes, defRes, brandsRes, catsRes] = await Promise.all([
        pricingStrategiesApi.list(),
        pricingStrategiesApi.getDefaults(),
        brandsApi.getAll().catch(() => ({ data: [] })),
        userCategoriesApi.getAll().catch(() => ({ data: [] })),
      ]);
      setList(listRes?.data || []);
      setSettings(
        listRes?.settings || {
          enabled: true,
          defaultStrategy: null,
        }
      );
      setDefaults(defRes?.data || null);
      const brandList = Array.isArray(brandsRes?.data)
        ? brandsRes.data
        : Array.isArray(brandsRes)
          ? brandsRes
          : [];
      setBrands(brandList.filter(Boolean));
      const catList = Array.isArray(catsRes?.data)
        ? catsRes.data
        : Array.isArray(catsRes)
          ? catsRes
          : [];
      setCategories(catList.filter(Boolean));
    } catch (e) {
      setError(e.response?.data?.message || e.message);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  useEffect(() => {
    if (addScopeType !== 'product') {
      setProductHits([]);
      return undefined;
    }
    const q = productQuery.trim();
    if (q.length < 2) {
      setProductHits([]);
      return undefined;
    }
    let cancelled = false;
    const t = setTimeout(async () => {
      setProductSearching(true);
      try {
        const res = await productsApi.getAll({ search: q, limit: 12 });
        const rows = Array.isArray(res?.data) ? res.data : Array.isArray(res) ? res : [];
        if (!cancelled) setProductHits(rows.filter(Boolean).slice(0, 12));
      } catch {
        if (!cancelled) setProductHits([]);
      } finally {
        if (!cancelled) setProductSearching(false);
      }
    }, 280);
    return () => {
      cancelled = true;
      clearTimeout(t);
    };
  }, [productQuery, addScopeType]);

  const toggleStrategiesEnabled = async () => {
    const next = !(settings.enabled !== false);
    setSettingsSaving(true);
    setMessage(null);
    try {
      const res = await pricingStrategiesApi.updateSettings({ enabled: next });
      setSettings(res?.data || { enabled: next, defaultStrategy: settings.defaultStrategy });
      setMessage(
        next
          ? 'Стратегии включены: фактическая цена считается по правилам.'
          : 'Стратегии выключены: фактическую цену задаёте вручную на странице «Цены».'
      );
    } catch (e) {
      setMessage('Ошибка: ' + (e.response?.data?.message || e.message));
    } finally {
      setSettingsSaving(false);
    }
  };

  const resetAddForm = () => {
    setAddScopeType('brand');
    setAddScopeId('');
    setAddMarketplace('');
    setProductQuery('');
    setProductHits([]);
  };

  const openCreate = () => {
    setEditing(null);
    setForm(emptyForm(defaults?.defaultConfig?.hybrid));
    resetAddForm();
    setModalOpen(true);
  };

  const openEdit = async (row) => {
    setEditing(row);
    resetAddForm();
    setForm({
      name: row.name || '',
      description: row.description || '',
      mode: row.mode || 'hybrid',
      is_active: row.is_active !== false,
      is_default: row.is_default === true,
      assignments: [],
      config: {
        ...emptyForm(defaults?.defaultConfig?.[row.mode || 'hybrid']).config,
        ...(row.config || {}),
        competitor: {
          ...emptyForm().config.competitor,
          ...(row.config?.competitor || {}),
        },
        sales: {
          ...emptyForm().config.sales,
          ...(row.config?.sales || {}),
        },
      },
    });
    setModalOpen(true);
    try {
      const res = await pricingStrategiesApi.getOne(row.id);
      const data = res?.data || res;
      const assignments = data?.assignments;
      setForm((prev) => ({
        ...prev,
        is_default: assignments?.isDefault === true || data?.is_default === true,
        assignments: Array.isArray(assignments?.items)
          ? assignments.items.map((it) => ({
              scopeType: it.scopeType || it.scope_type,
              scopeId: it.scopeId ?? it.scope_id ?? null,
              scopeName: it.scopeName || it.scope_name || null,
              marketplace: it.marketplace || null,
            }))
          : [],
      }));
    } catch (e) {
      setMessage('Не удалось загрузить назначения: ' + (e.response?.data?.message || e.message));
    }
  };

  const setConfigField = (path, value) => {
    setForm((prev) => {
      const next = { ...prev, config: { ...prev.config } };
      if (path.startsWith('competitor.')) {
        const key = path.slice('competitor.'.length);
        next.config.competitor = { ...next.config.competitor, [key]: value };
      } else if (path.startsWith('sales.')) {
        const key = path.slice('sales.'.length);
        next.config.sales = { ...next.config.sales, [key]: value };
      } else {
        next.config[path] = value;
      }
      return next;
    });
  };

  const onModeChange = (mode) => {
    const preset = defaults?.defaultConfig?.[mode];
    setForm((prev) => ({
      ...prev,
      mode,
      config: preset
        ? {
            ...preset,
            competitor: { ...preset.competitor },
            sales: { ...preset.sales },
          }
        : prev.config,
    }));
  };

  const addAssignment = (item) => {
    const next = {
      scopeType: item.scopeType,
      scopeId: item.scopeId ?? null,
      scopeName: item.scopeName || null,
      marketplace: item.marketplace || null,
    };
    setForm((prev) => {
      const key = assignmentKey(next);
      if ((prev.assignments || []).some((a) => assignmentKey(a) === key)) return prev;
      return { ...prev, assignments: [...(prev.assignments || []), next] };
    });
  };

  const handleAddAssignment = () => {
    if (addScopeType === 'profile') {
      addAssignment({
        scopeType: 'profile',
        scopeId: null,
        scopeName: null,
        marketplace: addMarketplace || null,
      });
      return;
    }
    if (addScopeType === 'product') {
      setMessage('Выберите товар из подсказок поиска');
      return;
    }
    if (!addScopeId) {
      setMessage(addScopeType === 'brand' ? 'Выберите бренд' : 'Выберите категорию');
      return;
    }
    const idNum = Number(addScopeId);
    const named =
      addScopeType === 'brand'
        ? brands.find((b) => Number(b.id) === idNum)
        : categories.find((c) => Number(c.id) === idNum);
    addAssignment({
      scopeType: addScopeType,
      scopeId: idNum,
      scopeName: named?.name || null,
      marketplace: addMarketplace || null,
    });
    setAddScopeId('');
  };

  const removeAssignment = (key) => {
    setForm((prev) => ({
      ...prev,
      assignments: (prev.assignments || []).filter((a) => assignmentKey(a) !== key),
    }));
  };

  const handleSave = async () => {
    if (!form.name.trim()) {
      setMessage('Укажите название');
      return;
    }
    try {
      setSaving(true);
      setMessage(null);
      const payload = {
        name: form.name.trim(),
        description: form.description || null,
        mode: form.mode,
        is_active: form.is_active === true,
        config: form.config,
        assignments: {
          isDefault: form.is_default === true,
          items: (form.assignments || []).map((a) => ({
            scopeType: a.scopeType,
            scopeId: a.scopeId,
            marketplace: a.marketplace || null,
          })),
        },
      };
      if (editing) await pricingStrategiesApi.update(editing.id, payload);
      else await pricingStrategiesApi.create(payload);
      setModalOpen(false);
      await load();
      setMessage(editing ? 'Стратегия сохранена' : 'Стратегия создана');
      setTimeout(() => setMessage(null), 4000);
    } catch (e) {
      setMessage('Ошибка: ' + (e.response?.data?.message || e.message));
    } finally {
      setSaving(false);
    }
  };

  const handleDelete = async (row) => {
    if (!window.confirm(`Удалить стратегию «${row.name}»?`)) return;
    try {
      await pricingStrategiesApi.remove(row.id);
      await load();
    } catch (e) {
      setMessage('Ошибка: ' + (e.response?.data?.message || e.message));
    }
  };

  const assignmentSummary = useMemo(() => {
    const map = new Map();
    for (const row of list) {
      const parts = [];
      if (row.is_default === true) parts.push('дефолт кабинета');
      const rc = Number(row.rules_count ?? row.rulesCount ?? 0);
      const pc = Number(row.products_count ?? row.productsCount ?? 0);
      if (rc > 0) parts.push(`правил: ${rc}`);
      if (pc > 0) parts.push(`товаров: ${pc}`);
      map.set(row.id, parts.length ? parts.join(' · ') : 'нигде не назначена');
    }
    return map;
  }, [list]);

  if (loading) return <div className="loading">Загрузка стратегий...</div>;
  if (error) return <div className="error">Ошибка: {error}</div>;

  const showCompetitor = form.mode === 'competitor' || form.mode === 'hybrid';
  const showSales = form.mode === 'sales' || form.mode === 'hybrid';
  const showMargin = form.mode === 'target_margin' || form.mode === 'hybrid';
  const strategiesOn = settings.enabled !== false;

  return (
    <div className="card pricing-strategies-page">
      <div
        style={{
          display: 'flex',
          justifyContent: 'space-between',
          gap: 12,
          flexWrap: 'wrap',
          alignItems: 'flex-start',
        }}
      >
        <div>
          <h1 className="title">Стратегии цен</h1>
          <p className="subtitle">
            В каждой стратегии — и формула цены, и где она действует (товары, бренды, категории, МП).{' '}
            <Link to="/prices">← к ценам</Link>
          </p>
        </div>
        <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
          <Link to="/prices/history" className="btn btn-secondary">
            История изменения цен
          </Link>
          <Button variant="primary" onClick={openCreate} disabled={!strategiesOn}>
            Добавить стратегию
          </Button>
        </div>
      </div>

      {message && (
        <div
          style={{
            marginTop: 12,
            fontSize: 13,
            color: message.startsWith('Ошибка') || message.startsWith('Не удалось')
              ? 'var(--danger,#ef4444)'
              : 'var(--primary)',
          }}
        >
          {message}
        </div>
      )}

      <div className={`pricing-strategies-master ${strategiesOn ? 'on' : 'off'}`}>
        <div className="pricing-strategies-master-text">
          <div className="pricing-strategies-master-title">
            {strategiesOn ? 'Стратегии включены' : 'Стратегии выключены'}
          </div>
          <div className="pricing-strategies-master-desc">
            {strategiesOn ? (
              <>
                Приоритет: товар+МП → товар → бренд → категория → дефолт кабинета. Более узкое
                назначение побеждает. Ручная цена на МП не перезаписывается.
              </>
            ) : (
              <>
                Авторасчёт фактической цены отключён. На странице «Цены» поле «факт» задаётся
                вручную.
              </>
            )}
          </div>
        </div>
        <label className="pricing-strategies-switch">
          <input
            type="checkbox"
            checked={strategiesOn}
            disabled={settingsSaving}
            onChange={toggleStrategiesEnabled}
          />
          <span>{strategiesOn ? 'Вкл.' : 'Выкл.'}</span>
        </label>
      </div>

      <div className="pricing-strategies-hint">
        <p>
          <strong>Режимы:</strong>
        </p>
        <ul>
          <li>
            <strong>Минимум</strong> — цена продажи = рассчитанный пол
          </li>
          <li>
            <strong>Целевая маржа</strong> — себестоимость + %
          </li>
          <li>
            <strong>Конкуренты</strong> — WB/YM (на Ozon данных нет → шаг пропускается)
          </li>
          <li>
            <strong>Продажи</strong> — при высокой скорости поднимаем цену, при низкой снижаем
          </li>
          <li>
            <strong>Гибрид</strong> — маржа/пол → конкуренты → продажи
          </li>
        </ul>
      </div>

      <div className="pricing-strategies-list" style={{ marginTop: 16 }}>
        {list.length === 0 ? (
          <div className="empty-state">
            Стратегий пока нет — будут созданы пресеты при первом открытии.
          </div>
        ) : (
          list.map((row) => (
            <div
              key={row.id}
              className={`pricing-strategy-item ${
                row.is_active === false || !strategiesOn ? 'inactive' : ''
              }`}
            >
              <div style={{ flex: 1 }}>
                <div style={{ fontWeight: 600, fontSize: 14 }}>
                  {row.name}
                  {!strategiesOn ? (
                    <span className="pricing-strategy-badge muted">глобально выкл.</span>
                  ) : (
                    <>
                      {row.is_active === false && (
                        <span className="pricing-strategy-badge muted">не применяется</span>
                      )}
                      {row.is_default === true && (
                        <span className="pricing-strategy-badge">дефолт</span>
                      )}
                      <span className="pricing-strategy-badge muted">
                        {assignmentSummary.get(row.id)}
                      </span>
                    </>
                  )}
                </div>
                <div style={{ fontSize: 12, color: 'var(--muted)', marginTop: 4 }}>
                  {MODE_LABELS[row.mode] || row.mode}
                  {row.description ? ` · ${row.description}` : ''}
                </div>
              </div>
              <div style={{ display: 'flex', gap: 8 }}>
                <Button variant="secondary" size="small" onClick={() => openEdit(row)}>
                  Изменить
                </Button>
                <Button
                  variant="secondary"
                  size="small"
                  onClick={() => handleDelete(row)}
                  style={{ color: '#fca5a5' }}
                >
                  Удалить
                </Button>
              </div>
            </div>
          ))
        )}
      </div>

      <Modal
        isOpen={modalOpen}
        onClose={() => setModalOpen(false)}
        title={editing ? 'Редактировать стратегию' : 'Новая стратегия'}
        size="large"
      >
        <div className="row g-3">
          <div className="col-md-8">
            <FieldLabel hint={FIELD_HINTS.name}>Название</FieldLabel>
            <input
              className="form-control form-control-sm"
              value={form.name}
              onChange={(e) => setForm((p) => ({ ...p, name: e.target.value }))}
            />
          </div>
          <div className="col-md-4">
            <FieldLabel hint={FIELD_HINTS.mode}>Режим</FieldLabel>
            <select
              className="form-select form-select-sm"
              value={form.mode}
              onChange={(e) => onModeChange(e.target.value)}
            >
              {Object.entries(MODE_LABELS).map(([k, label]) => (
                <option key={k} value={k}>
                  {label}
                </option>
              ))}
            </select>
          </div>
          <div className="col-12">
            <FieldLabel hint={FIELD_HINTS.description}>Описание</FieldLabel>
            <textarea
              className="form-control form-control-sm"
              rows={2}
              value={form.description}
              onChange={(e) => setForm((p) => ({ ...p, description: e.target.value }))}
            />
          </div>

          {showMargin && (
            <div className="col-md-4">
              <FieldLabel hint={FIELD_HINTS.target_margin}>Целевая маржа, %</FieldLabel>
              <input
                type="number"
                className="form-control form-control-sm"
                value={form.config.target_margin_percent ?? 25}
                onChange={(e) => setConfigField('target_margin_percent', Number(e.target.value))}
              />
            </div>
          )}

          <div className="col-md-4">
            <FieldLabel hint={FIELD_HINTS.band_percent}>Коридор без изменений, %</FieldLabel>
            <input
              type="number"
              className="form-control form-control-sm"
              value={form.config.band_percent ?? 2}
              onChange={(e) => setConfigField('band_percent', Number(e.target.value))}
            />
          </div>
          <div className="col-md-4">
            <FieldLabel hint={FIELD_HINTS.max_change_percent}>Макс. изменение за раз, %</FieldLabel>
            <input
              type="number"
              className="form-control form-control-sm"
              value={form.config.max_change_percent ?? 12}
              onChange={(e) => setConfigField('max_change_percent', Number(e.target.value))}
            />
          </div>

          {showCompetitor && (
            <>
              <div className="col-12">
                <h6 className="mb-0 mt-2">Конкуренты (WB / YM)</h6>
              </div>
              <div className="col-md-3">
                <FieldLabel hint={FIELD_HINTS.competitor_agg}>Агрегация</FieldLabel>
                <select
                  className="form-select form-select-sm"
                  value={form.config.competitor?.agg || 'min'}
                  onChange={(e) => setConfigField('competitor.agg', e.target.value)}
                >
                  <option value="min">Минимум</option>
                  <option value="median">Медиана</option>
                  <option value="avg">Среднее</option>
                </select>
              </div>
              <div className="col-md-3">
                <FieldLabel hint={FIELD_HINTS.competitor_offset_percent}>Отступ, %</FieldLabel>
                <input
                  type="number"
                  className="form-control form-control-sm"
                  value={form.config.competitor?.offset_percent ?? -1}
                  onChange={(e) =>
                    setConfigField('competitor.offset_percent', Number(e.target.value))
                  }
                />
              </div>
              <div className="col-md-3">
                <FieldLabel hint={FIELD_HINTS.competitor_offset_rub}>Отступ, ₽</FieldLabel>
                <input
                  type="number"
                  className="form-control form-control-sm"
                  value={form.config.competitor?.offset_rub ?? 0}
                  onChange={(e) => setConfigField('competitor.offset_rub', Number(e.target.value))}
                />
              </div>
              <div className="col-12">
                <div className="form-check form-switch">
                  <input
                    className="form-check-input"
                    type="checkbox"
                    id="compEnabled"
                    checked={form.config.competitor?.enabled !== false}
                    onChange={(e) => setConfigField('competitor.enabled', e.target.checked)}
                  />
                  <label className="form-check-label" htmlFor="compEnabled">
                    Учитывать конкурентов
                  </label>
                </div>
                <p className="text-muted small mb-0">
                  На Ozon шаг конкурентов пропускается — нет данных витрины.
                </p>
              </div>
            </>
          )}

          {showSales && (
            <>
              <div className="col-12">
                <h6 className="mb-0 mt-2">Продажи (FBS, delivered)</h6>
              </div>
              <div className="col-md-3">
                <FieldLabel hint={FIELD_HINTS.sales_window}>Окно, дней</FieldLabel>
                <input
                  type="number"
                  className="form-control form-control-sm"
                  value={form.config.sales?.window_days ?? 14}
                  onChange={(e) => setConfigField('sales.window_days', Number(e.target.value))}
                />
              </div>
              <div className="col-md-3">
                <FieldLabel hint={FIELD_HINTS.sales_high}>Высокие продажи, шт/день</FieldLabel>
                <input
                  type="number"
                  step="0.1"
                  className="form-control form-control-sm"
                  value={form.config.sales?.high_per_day ?? 1}
                  onChange={(e) => setConfigField('sales.high_per_day', Number(e.target.value))}
                />
              </div>
              <div className="col-md-3">
                <FieldLabel hint={FIELD_HINTS.sales_low}>Низкие продажи, шт/день</FieldLabel>
                <input
                  type="number"
                  step="0.1"
                  className="form-control form-control-sm"
                  value={form.config.sales?.low_per_day ?? 0.1}
                  onChange={(e) => setConfigField('sales.low_per_day', Number(e.target.value))}
                />
              </div>
              <div className="col-md-3">
                <FieldLabel hint={FIELD_HINTS.sales_high_step}>Шаг вверх при высоких, %</FieldLabel>
                <input
                  type="number"
                  className="form-control form-control-sm"
                  value={form.config.sales?.high_step_percent ?? 3}
                  onChange={(e) =>
                    setConfigField('sales.high_step_percent', Number(e.target.value))
                  }
                />
              </div>
              <div className="col-md-3">
                <FieldLabel hint={FIELD_HINTS.sales_low_step}>Шаг вниз при низких, %</FieldLabel>
                <input
                  type="number"
                  className="form-control form-control-sm"
                  value={form.config.sales?.low_step_percent ?? 5}
                  onChange={(e) => setConfigField('sales.low_step_percent', Number(e.target.value))}
                />
              </div>
              <div className="col-12">
                <div className="form-check form-switch">
                  <input
                    className="form-check-input"
                    type="checkbox"
                    id="salesEnabled"
                    checked={form.config.sales?.enabled !== false}
                    onChange={(e) => setConfigField('sales.enabled', e.target.checked)}
                  />
                  <label className="form-check-label" htmlFor="salesEnabled">
                    Учитывать продажи
                  </label>
                </div>
              </div>
            </>
          )}

          <div className="col-12">
            <hr style={{ margin: '8px 0 12px', borderColor: 'var(--border, #333)' }} />
            <h6 className="mb-1">Где применяется</h6>
            <p className="text-muted small mb-2">
              Назначьте стратегию на товары, бренды, категории или весь кабинет. Можно ограничить
              одним маркетплейсом.
            </p>

            <div className="form-check form-switch mb-3">
              <input
                className="form-check-input"
                type="checkbox"
                id="stratDefault"
                checked={form.is_default === true}
                onChange={(e) => setForm((p) => ({ ...p, is_default: e.target.checked }))}
              />
              <label className="form-check-label" htmlFor="stratDefault">
                Стратегия по умолчанию для всего кабинета
              </label>
            </div>

            {(form.assignments || []).length === 0 ? (
              <div className="empty-state" style={{ marginBottom: 12, padding: '8px 0' }}>
                Пока только дефолт (если включён) или нигде — добавьте область ниже.
              </div>
            ) : (
              <div className="pricing-strategies-list" style={{ marginBottom: 12 }}>
                {(form.assignments || []).map((a) => {
                  const key = assignmentKey(a);
                  return (
                    <div key={key} className="pricing-strategy-item" style={{ padding: '8px 10px' }}>
                      <div style={{ flex: 1, fontSize: 13 }}>{formatAssignment(a)}</div>
                      <Button
                        type="button"
                        variant="secondary"
                        size="small"
                        onClick={() => removeAssignment(key)}
                        style={{ color: '#fca5a5' }}
                      >
                        Убрать
                      </Button>
                    </div>
                  );
                })}
              </div>
            )}

            <div
              style={{
                display: 'grid',
                gridTemplateColumns: 'repeat(auto-fit, minmax(140px, 1fr))',
                gap: 8,
                alignItems: 'end',
              }}
            >
              <FieldLabel className="form-label mb-0" hint={FIELD_HINTS.apply_scope}>
                Область
                <select
                  className="form-select form-select-sm mt-1"
                  value={addScopeType}
                  onChange={(e) => {
                    setAddScopeType(e.target.value);
                    setAddScopeId('');
                    setProductQuery('');
                    setProductHits([]);
                  }}
                >
                  <option value="brand">Бренд</option>
                  <option value="category">Категория</option>
                  <option value="product">Товар</option>
                  <option value="profile">Весь кабинет</option>
                </select>
              </FieldLabel>

              {addScopeType === 'brand' ? (
                <label className="form-label mb-0">
                  Бренд
                  <select
                    className="form-select form-select-sm mt-1"
                    value={addScopeId}
                    onChange={(e) => setAddScopeId(e.target.value)}
                  >
                    <option value="">Выберите…</option>
                    {brands.map((b) => (
                      <option key={b.id} value={String(b.id)}>
                        {b.name || `#${b.id}`}
                      </option>
                    ))}
                  </select>
                </label>
              ) : null}

              {addScopeType === 'category' ? (
                <label className="form-label mb-0">
                  Категория
                  <select
                    className="form-select form-select-sm mt-1"
                    value={addScopeId}
                    onChange={(e) => setAddScopeId(e.target.value)}
                  >
                    <option value="">Выберите…</option>
                    {categories.map((c) => (
                      <option key={c.id} value={String(c.id)}>
                        {c.name || `#${c.id}`}
                      </option>
                    ))}
                  </select>
                </label>
              ) : null}

              {addScopeType === 'product' ? (
                <label className="form-label mb-0" style={{ gridColumn: 'span 2' }}>
                  Поиск товара
                  <input
                    className="form-control form-control-sm mt-1"
                    value={productQuery}
                    placeholder="SKU или название…"
                    onChange={(e) => setProductQuery(e.target.value)}
                  />
                </label>
              ) : null}

              <FieldLabel className="form-label mb-0" hint={FIELD_HINTS.apply_marketplace}>
                Маркетплейс
                <select
                  className="form-select form-select-sm mt-1"
                  value={addMarketplace}
                  onChange={(e) => setAddMarketplace(e.target.value)}
                >
                  <option value="">Все МП</option>
                  <option value="ozon">Ozon</option>
                  <option value="wb">Wildberries</option>
                  <option value="ym">Яндекс Маркет</option>
                </select>
              </FieldLabel>

              {addScopeType !== 'product' ? (
                <Button type="button" variant="secondary" size="small" onClick={handleAddAssignment}>
                  Добавить
                </Button>
              ) : null}
            </div>

            {addScopeType === 'product' ? (
              <div style={{ marginTop: 8 }}>
                {productSearching ? (
                  <div className="text-muted small">Поиск…</div>
                ) : productHits.length === 0 && productQuery.trim().length >= 2 ? (
                  <div className="text-muted small">Ничего не найдено</div>
                ) : (
                  <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
                    {productHits.map((p) => (
                      <button
                        key={p.id}
                        type="button"
                        className="btn btn-secondary btn-sm"
                        style={{ textAlign: 'left', fontSize: 12 }}
                        onClick={() => {
                          addAssignment({
                            scopeType: 'product',
                            scopeId: Number(p.id),
                            scopeName: p.name || p.sku || `#${p.id}`,
                            marketplace: addMarketplace || null,
                          });
                          setProductQuery('');
                          setProductHits([]);
                        }}
                      >
                        {p.sku ? `${p.sku} · ` : ''}
                        {p.name || `#${p.id}`}
                      </button>
                    ))}
                  </div>
                )}
              </div>
            ) : null}
          </div>

          <div className="col-12 d-flex gap-4">
            <div className="form-check form-switch">
              <input
                className="form-check-input"
                type="checkbox"
                id="stratActive"
                checked={form.is_active === true}
                onChange={(e) => setForm((p) => ({ ...p, is_active: e.target.checked }))}
              />
              <label className="form-check-label" htmlFor="stratActive">
                Активна
              </label>
            </div>
          </div>
        </div>

        <div className="d-flex justify-content-end gap-2 mt-4">
          <Button type="button" variant="secondary" onClick={() => setModalOpen(false)}>
            Отмена
          </Button>
          <Button type="button" variant="primary" onClick={handleSave} disabled={saving}>
            {saving ? 'Сохранение…' : 'Сохранить'}
          </Button>
        </div>
      </Modal>
    </div>
  );
}
