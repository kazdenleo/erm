/**
 * Pricing Strategies Page
 * Настройка стратегий ценообразования
 */

import React, { useCallback, useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { Button } from '../../components/common/Button/Button';
import { Modal } from '../../components/common/Modal/Modal';
import { pricingStrategiesApi } from '../../services/pricingStrategies.api.js';
import './PricingStrategies.css';

const MODE_LABELS = {
  floor: 'Минимум (пол)',
  target_margin: 'Целевая маржа',
  competitor: 'От конкурентов (WB/YM)',
  sales: 'От продаж',
  hybrid: 'Гибрид: конкуренты + продажи',
};

function emptyForm(defaultsHybrid) {
  return {
    name: '',
    description: '',
    mode: 'hybrid',
    is_active: true,
    is_default: false,
    config: defaultsHybrid || {
      target_margin_percent: 25,
      competitor: { enabled: true, agg: 'min', offset_rub: 0, offset_percent: -1, if_missing: 'keep_base' },
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

  const load = useCallback(async () => {
    try {
      setLoading(true);
      setError(null);
      const [listRes, defRes] = await Promise.all([
        pricingStrategiesApi.list(),
        pricingStrategiesApi.getDefaults(),
      ]);
      setList(listRes?.data || []);
      setSettings(
        listRes?.settings || {
          enabled: true,
          defaultStrategy: null,
        }
      );
      setDefaults(defRes?.data || null);
    } catch (e) {
      setError(e.response?.data?.message || e.message);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    load();
  }, [load]);

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

  const openCreate = () => {
    setEditing(null);
    setForm(emptyForm(defaults?.defaultConfig?.hybrid));
    setModalOpen(true);
  };

  const openEdit = (row) => {
    setEditing(row);
    setForm({
      name: row.name || '',
      description: row.description || '',
      mode: row.mode || 'hybrid',
      is_active: row.is_active !== false,
      is_default: row.is_default === true,
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
        is_default: form.is_default === true,
        config: form.config,
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

  if (loading) return <div className="loading">Загрузка стратегий...</div>;
  if (error) return <div className="error">Ошибка: {error}</div>;

  const showCompetitor = form.mode === 'competitor' || form.mode === 'hybrid';
  const showSales = form.mode === 'sales' || form.mode === 'hybrid';
  const showMargin = form.mode === 'target_margin' || form.mode === 'hybrid';
  const strategiesOn = settings.enabled !== false;
  const defaultRow =
    settings.defaultStrategy ||
    list.find((r) => r.is_default === true) ||
    null;

  return (
    <div className="card pricing-strategies-page">
      <div style={{ display: 'flex', justifyContent: 'space-between', gap: 12, flexWrap: 'wrap', alignItems: 'flex-start' }}>
        <div>
          <h1 className="title">Стратегии цен</h1>
          <p className="subtitle">
            Правила расчёта фактической цены. Минимум (пол) всегда нижняя граница.{' '}
            <Link to="/prices">← к ценам</Link>
          </p>
        </div>
        <Button variant="primary" onClick={openCreate} disabled={!strategiesOn}>
          Добавить стратегию
        </Button>
      </div>

      {message && (
        <div style={{ marginTop: 12, fontSize: 13, color: message.startsWith('Ошибка') ? 'var(--danger,#ef4444)' : 'var(--primary)' }}>
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
                Сейчас для товаров без отдельной настройки действует:{' '}
                <strong>
                  {defaultRow
                    ? `«${defaultRow.name}» (${MODE_LABELS[defaultRow.mode] || defaultRow.mode})`
                    : 'нет стратегии по умолчанию — цена вручную'}
                </strong>
                . Порядок: товар → организация → стратегия «по умолчанию».
              </>
            ) : (
              <>
                Авторасчёт фактической цены отключён для всего кабинета. На странице «Цены» поле «факт»
                редактируется вручную; «до скидки» и % тоже.
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
        <p><strong>Режимы:</strong></p>
        <ul>
          <li><strong>Минимум</strong> — цена продажи = рассчитанный пол</li>
          <li><strong>Целевая маржа</strong> — себестоимость + %</li>
          <li><strong>Конкуренты</strong> — WB/YM (на Ozon данных нет → шаг пропускается)</li>
          <li><strong>Продажи</strong> — при высокой скорости продаж поднимаем цену, при низкой снижаем</li>
          <li><strong>Гибрид</strong> — маржа/пол → конкуренты → продажи</li>
        </ul>
        <p style={{ marginTop: 8, marginBottom: 0 }}>
          Чтобы стратегия реально применялась: она должна быть <strong>активна</strong>, и либо стоять
          «по умолчанию», либо быть привязана к товару/организации. Выключенные в списке не работают.
        </p>
      </div>

      <div className="pricing-strategies-list" style={{ marginTop: 16 }}>
        {list.length === 0 ? (
          <div className="empty-state">Стратегий пока нет — будут созданы пресеты при первом открытии.</div>
        ) : (
          list.map((row) => (
            <div
              key={row.id}
              className={`pricing-strategy-item ${row.is_active === false || !strategiesOn ? 'inactive' : ''}`}
            >
              <div style={{ flex: 1 }}>
                <div style={{ fontWeight: 600, fontSize: 14 }}>
                  {row.name}
                  {!strategiesOn ? (
                    <span className="pricing-strategy-badge muted">глобально выкл.</span>
                  ) : (
                    <>
                      {row.is_default && <span className="pricing-strategy-badge">сейчас по умолчанию</span>}
                      {row.is_active === false && (
                        <span className="pricing-strategy-badge muted">не применяется</span>
                      )}
                      {row.is_active !== false && !row.is_default && (
                        <span className="pricing-strategy-badge muted">только по привязке</span>
                      )}
                    </>
                  )}
                </div>
                <div style={{ fontSize: 12, color: 'var(--muted)', marginTop: 4 }}>
                  {MODE_LABELS[row.mode] || row.mode}
                  {row.description ? ` · ${row.description}` : ''}
                </div>
              </div>
              <div style={{ display: 'flex', gap: 8 }}>
                <Button variant="secondary" size="small" onClick={() => openEdit(row)}>Изменить</Button>
                <Button variant="secondary" size="small" onClick={() => handleDelete(row)} style={{ color: '#fca5a5' }}>
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
            <label className="form-label">Название</label>
            <input
              className="form-control form-control-sm"
              value={form.name}
              onChange={(e) => setForm((p) => ({ ...p, name: e.target.value }))}
            />
          </div>
          <div className="col-md-4">
            <label className="form-label">Режим</label>
            <select
              className="form-select form-select-sm"
              value={form.mode}
              onChange={(e) => onModeChange(e.target.value)}
            >
              {Object.entries(MODE_LABELS).map(([k, label]) => (
                <option key={k} value={k}>{label}</option>
              ))}
            </select>
          </div>
          <div className="col-12">
            <label className="form-label">Описание</label>
            <textarea
              className="form-control form-control-sm"
              rows={2}
              value={form.description}
              onChange={(e) => setForm((p) => ({ ...p, description: e.target.value }))}
            />
          </div>

          {showMargin && (
            <div className="col-md-4">
              <label className="form-label">Целевая маржа, %</label>
              <input
                type="number"
                className="form-control form-control-sm"
                value={form.config.target_margin_percent ?? 25}
                onChange={(e) => setConfigField('target_margin_percent', Number(e.target.value))}
              />
            </div>
          )}

          <div className="col-md-4">
            <label className="form-label">Коридор без изменений, %</label>
            <input
              type="number"
              className="form-control form-control-sm"
              value={form.config.band_percent ?? 2}
              onChange={(e) => setConfigField('band_percent', Number(e.target.value))}
            />
          </div>
          <div className="col-md-4">
            <label className="form-label">Макс. изменение за раз, %</label>
            <input
              type="number"
              className="form-control form-control-sm"
              value={form.config.max_change_percent ?? 12}
              onChange={(e) => setConfigField('max_change_percent', Number(e.target.value))}
            />
          </div>

          {showCompetitor && (
            <>
              <div className="col-12"><h6 className="mb-0 mt-2">Конкуренты (WB / YM)</h6></div>
              <div className="col-md-3">
                <label className="form-label">Агрегация</label>
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
                <label className="form-label">Отступ, %</label>
                <input
                  type="number"
                  className="form-control form-control-sm"
                  value={form.config.competitor?.offset_percent ?? -1}
                  onChange={(e) => setConfigField('competitor.offset_percent', Number(e.target.value))}
                />
              </div>
              <div className="col-md-3">
                <label className="form-label">Отступ, ₽</label>
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
                  <label className="form-check-label" htmlFor="compEnabled">Учитывать конкурентов</label>
                </div>
                <p className="text-muted small mb-0">На Ozon шаг конкурентов пропускается — нет данных витрины.</p>
              </div>
            </>
          )}

          {showSales && (
            <>
              <div className="col-12"><h6 className="mb-0 mt-2">Продажи (FBS, delivered)</h6></div>
              <div className="col-md-3">
                <label className="form-label">Окно, дней</label>
                <input
                  type="number"
                  className="form-control form-control-sm"
                  value={form.config.sales?.window_days ?? 14}
                  onChange={(e) => setConfigField('sales.window_days', Number(e.target.value))}
                />
              </div>
              <div className="col-md-3">
                <label className="form-label">Высокие продажи, шт/день</label>
                <input
                  type="number"
                  step="0.1"
                  className="form-control form-control-sm"
                  value={form.config.sales?.high_per_day ?? 1}
                  onChange={(e) => setConfigField('sales.high_per_day', Number(e.target.value))}
                />
              </div>
              <div className="col-md-3">
                <label className="form-label">Низкие продажи, шт/день</label>
                <input
                  type="number"
                  step="0.1"
                  className="form-control form-control-sm"
                  value={form.config.sales?.low_per_day ?? 0.1}
                  onChange={(e) => setConfigField('sales.low_per_day', Number(e.target.value))}
                />
              </div>
              <div className="col-md-3">
                <label className="form-label">Шаг вверх при высоких, %</label>
                <input
                  type="number"
                  className="form-control form-control-sm"
                  value={form.config.sales?.high_step_percent ?? 3}
                  onChange={(e) => setConfigField('sales.high_step_percent', Number(e.target.value))}
                />
              </div>
              <div className="col-md-3">
                <label className="form-label">Шаг вниз при низких, %</label>
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
                  <label className="form-check-label" htmlFor="salesEnabled">Учитывать продажи</label>
                </div>
              </div>
            </>
          )}

          <div className="col-12 d-flex gap-4">
            <div className="form-check form-switch">
              <input
                className="form-check-input"
                type="checkbox"
                id="stratActive"
                checked={form.is_active === true}
                onChange={(e) => setForm((p) => ({ ...p, is_active: e.target.checked }))}
              />
              <label className="form-check-label" htmlFor="stratActive">Активна</label>
            </div>
            <div className="form-check form-switch">
              <input
                className="form-check-input"
                type="checkbox"
                id="stratDefault"
                checked={form.is_default === true}
                onChange={(e) => setForm((p) => ({ ...p, is_default: e.target.checked }))}
              />
              <label className="form-check-label" htmlFor="stratDefault">По умолчанию для кабинета</label>
            </div>
          </div>
        </div>

        <div className="d-flex justify-content-end gap-2 mt-4">
          <Button type="button" variant="secondary" onClick={() => setModalOpen(false)}>Отмена</Button>
          <Button type="button" variant="primary" onClick={handleSave} disabled={saving}>
            {saving ? 'Сохранение…' : 'Сохранить'}
          </Button>
        </div>
      </Modal>
    </div>
  );
}
