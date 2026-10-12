/**
 * Настройки адресного хранения склада: режим, шаблон адреса, учёт количества, размер этикетки.
 */

import React, { useEffect, useMemo, useState } from 'react';
import { Button } from '../../components/common/Button/Button';
import { addressStorageApi, addressStorageError } from '../../services/addressStorage.api';
import { MODE_LABELS } from './addressStorageUtils';

const SAMPLE_VALUES = ['A', '01', '3', '2', '1', '1'];

export function AddressSettingsTab({ warehouseId, settings, locations, onSaved }) {
  const [form, setForm] = useState(settings);
  const [saving, setSaving] = useState(false);
  const [message, setMessage] = useState(null);

  useEffect(() => {
    setForm(settings);
    setMessage(null);
  }, [settings]);

  const levelsLocked = locations.length > 0;
  const sample = useMemo(
    () => form.levels.map((_, i) => SAMPLE_VALUES[i] || '1').join(form.separator || '-'),
    [form.levels, form.separator]
  );

  const set = (patch) => setForm((f) => ({ ...f, ...patch }));
  const setLevel = (i, label) =>
    set({ levels: form.levels.map((l, idx) => (idx === i ? { ...l, label } : l)) });

  const save = async () => {
    setSaving(true);
    setMessage(null);
    try {
      const saved = await addressStorageApi.saveSettings(warehouseId, {
        enabled: form.enabled,
        mode: form.mode,
        trackQuantities: form.trackQuantities,
        levels: form.levels,
        separator: form.separator,
        labelWidthMm: Number(form.labelWidthMm),
        labelHeightMm: Number(form.labelHeightMm),
      });
      onSaved?.(saved);
      setMessage({ ok: true, text: 'Настройки сохранены' });
    } catch (e) {
      setMessage({ ok: false, text: addressStorageError(e).message });
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="address-settings">
      <section className="address-settings__block">
        <label className="address-settings__switch">
          <input type="checkbox" checked={form.enabled} onChange={(e) => set({ enabled: e.target.checked })} />
          <span>
            <strong>Адресное хранение на этом складе</strong>
            <span className="muted-hint d-block">
              Адреса ячеек появятся в сборке заказов, сборе FBO-поставок и карточке товара.
            </span>
          </span>
        </label>
      </section>

      <section className="address-settings__block">
        <h4 className="address-settings__title">Как товары лежат на складе</h4>
        {Object.entries(MODE_LABELS).map(([key, label]) => (
          <label key={key} className="address-settings__radio">
            <input type="radio" name="mode" checked={form.mode === key} onChange={() => set({ mode: key })} />
            <span>{label}</span>
          </label>
        ))}
      </section>

      <section className="address-settings__block">
        <label className="address-settings__switch">
          <input
            type="checkbox"
            checked={form.trackQuantities}
            onChange={(e) => set({ trackQuantities: e.target.checked })}
          />
          <span>
            <strong>Учитывать количество в каждой ячейке</strong>
            <span className="muted-hint d-block">
              Выключено — система знает только, где лежит товар. Включено — сколько штук в какой ячейке;
              новый приход попадает в «Без адреса», его размещают на вкладке «Размещение». Отгрузки и списания
              снимают товар сначала с закреплённой ячейки.
            </span>
          </span>
        </label>
      </section>

      <section className="address-settings__block">
        <h4 className="address-settings__title">Шаблон адреса</h4>
        {levelsLocked ? (
          <p className="muted-hint">
            На складе уже есть ячейки — число уровней менять нельзя, названия и разделитель можно.
          </p>
        ) : null}
        <div className="address-settings__levels">
          {form.levels.map((l, i) => (
            <div key={i} className="address-settings__level">
              <span className="muted-hint">{i + 1}.</span>
              <input
                className="form-control form-control-sm"
                value={l.label}
                maxLength={32}
                onChange={(e) => setLevel(i, e.target.value)}
              />
              {!levelsLocked && form.levels.length > 1 ? (
                <button
                  type="button"
                  className="btn btn-link btn-sm text-danger"
                  title="Убрать уровень"
                  onClick={() => set({ levels: form.levels.filter((_, idx) => idx !== i) })}
                >
                  ✕
                </button>
              ) : null}
            </div>
          ))}
          {!levelsLocked && form.levels.length < 6 ? (
            <button
              type="button"
              className="btn btn-link btn-sm"
              onClick={() => set({ levels: [...form.levels, { key: `level${form.levels.length + 1}`, label: '' }] })}
            >
              + уровень
            </button>
          ) : null}
        </div>
        <div className="address-settings__row">
          <label>
            Разделитель{' '}
            <input
              className="form-control form-control-sm address-settings__sep"
              value={form.separator}
              maxLength={3}
              onChange={(e) => set({ separator: e.target.value })}
            />
          </label>
          <span>
            Пример: <code className="address-code">{sample}</code>{' '}
            <span className="muted-hint">({form.levels.map((l) => l.label || '?').join(' → ')})</span>
          </span>
        </div>
        <p className="muted-hint mb-0">
          На вкладке «Стеллажи» последние два уровня показываются как полки и ячейки, остальные — как стеллаж.
        </p>
      </section>

      <section className="address-settings__block">
        <h4 className="address-settings__title">Этикетка ячейки</h4>
        <div className="address-settings__row">
          <label>
            Ширина, мм{' '}
            <input
              type="number"
              className="form-control form-control-sm address-settings__num"
              value={form.labelWidthMm}
              min={15}
              max={200}
              onChange={(e) => set({ labelWidthMm: e.target.value })}
            />
          </label>
          <label>
            Высота, мм{' '}
            <input
              type="number"
              className="form-control form-control-sm address-settings__num"
              value={form.labelHeightMm}
              min={15}
              max={200}
              onChange={(e) => set({ labelHeightMm: e.target.value })}
            />
          </label>
        </div>
      </section>

      <div className="address-settings__actions">
        <Button onClick={save} disabled={saving}>
          {saving ? 'Сохранение…' : 'Сохранить'}
        </Button>
        {message ? (
          <span className={message.ok ? 'text-success' : 'text-danger'} role="status">
            {message.text}
          </span>
        ) : null}
      </div>
    </div>
  );
}
