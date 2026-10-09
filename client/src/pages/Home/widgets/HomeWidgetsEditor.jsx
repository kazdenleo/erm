/**
 * Редактор раскладки главной: состав, порядок, размер и период виджетов.
 */

import React, { useEffect, useState } from 'react';
import { Button } from '../../../components/common/Button/Button';
import { Modal } from '../../../components/common/Modal/Modal';
import { WIDGETS, WIDGET_GROUPS, WIDGET_SIZES, createWidgetItem } from './widgetRegistry';

export function HomeWidgetsEditor({ isOpen, items, canUseWidget, canUseLink, saving, onClose, onSave, onReset }) {
  const [draft, setDraft] = useState(items);

  useEffect(() => {
    if (isOpen) setDraft(items);
  }, [isOpen, items]);

  const update = (uid, patch) => setDraft((d) => d.map((it) => (it.uid === uid ? { ...it, ...patch } : it)));
  const move = (idx, dir) =>
    setDraft((d) => {
      const j = idx + dir;
      if (j < 0 || j >= d.length) return d;
      const next = [...d];
      [next[idx], next[j]] = [next[j], next[idx]];
      return next;
    });
  const remove = (uid) => setDraft((d) => d.filter((it) => it.uid !== uid));
  const add = (type) => setDraft((d) => [...d, createWidgetItem(type)]);

  const visibleDraft = draft.filter((it) => WIDGETS[it.type] && canUseWidget(WIDGETS[it.type]));
  const presentTypes = new Set(draft.map((it) => it.type));

  return (
    <Modal isOpen={isOpen} onClose={onClose} title="Настройка главной" size="large" scrollable>
      <div className="home-widgets-editor">
        <div className="home-widgets-editor__section-title">На главной</div>
        {visibleDraft.length === 0 && <div className="text-muted small mb-3">Пока пусто — добавьте виджеты ниже.</div>}
        <div className="home-widgets-editor__list">
          {visibleDraft.map((it) => {
            const def = WIDGETS[it.type];
            const idx = draft.indexOf(it);
            const Settings = def.SettingsComponent;
            return (
              <div key={it.uid} className="home-widgets-editor__item">
                <div className="home-widgets-editor__item-head">
                  <div className="home-widgets-editor__order">
                    <button
                      type="button"
                      className="btn btn-sm btn-light"
                      title="Выше"
                      disabled={idx === 0}
                      onClick={() => move(idx, -1)}
                    >
                      ↑
                    </button>
                    <button
                      type="button"
                      className="btn btn-sm btn-light"
                      title="Ниже"
                      disabled={idx === draft.length - 1}
                      onClick={() => move(idx, 1)}
                    >
                      ↓
                    </button>
                  </div>
                  <div className="home-widgets-editor__name">
                    <div className="fw-semibold">{def.title}</div>
                    <div className="text-muted small">{def.description}</div>
                  </div>
                  <select
                    className="form-select form-select-sm home-widgets-editor__select"
                    value={it.size}
                    onChange={(e) => update(it.uid, { size: e.target.value })}
                    title="Ширина"
                  >
                    {WIDGET_SIZES.map((s) => (
                      <option key={s.value} value={s.value}>
                        {s.label}
                      </option>
                    ))}
                  </select>
                  {def.periods && (
                    <select
                      className="form-select form-select-sm home-widgets-editor__select"
                      value={it.settings?.period || def.defaultPeriod}
                      onChange={(e) => update(it.uid, { settings: { ...it.settings, period: e.target.value } })}
                      title="Период"
                    >
                      {def.periods.map((p) => (
                        <option key={p.value} value={p.value}>
                          {p.label}
                        </option>
                      ))}
                    </select>
                  )}
                  <button
                    type="button"
                    className="btn btn-sm btn-outline-danger"
                    title="Убрать с главной"
                    onClick={() => remove(it.uid)}
                  >
                    ✕
                  </button>
                </div>
                {Settings && (
                  <div className="home-widgets-editor__item-settings">
                    <Settings
                      settings={it.settings || {}}
                      canUse={canUseLink}
                      onChange={(settings) => update(it.uid, { settings })}
                    />
                  </div>
                )}
              </div>
            );
          })}
        </div>

        <div className="home-widgets-editor__section-title mt-4">Добавить виджет</div>
        {WIDGET_GROUPS.map((g) => {
          const defs = Object.entries(WIDGETS).filter(([, def]) => def.group === g.value && canUseWidget(def));
          if (defs.length === 0) return null;
          return (
            <div key={g.value} className="mb-3">
              <div className="text-muted small fw-semibold mb-2">{g.label}</div>
              <div className="home-widgets-editor__catalog">
                {defs.map(([type, def]) => {
                  const disabled = presentTypes.has(type) && !def.multiple;
                  return (
                    <button
                      key={type}
                      type="button"
                      className="home-widgets-editor__catalog-item"
                      disabled={disabled}
                      onClick={() => add(type)}
                      title={disabled ? 'Уже на главной' : 'Добавить на главную'}
                    >
                      <span className="fw-semibold">
                        {disabled ? '✓ ' : '+ '}
                        {def.title}
                      </span>
                      <span className="text-muted small">
                        {disabled ? 'Уже на главной — убрать можно в списке выше' : def.description}
                      </span>
                    </button>
                  );
                })}
              </div>
            </div>
          );
        })}

        <div className="d-flex flex-wrap justify-content-between gap-2 mt-3 pt-3 border-top">
          <Button type="button" variant="secondary" size="small" disabled={saving} onClick={onReset}>
            Вернуть стандартную
          </Button>
          <div className="d-flex gap-2">
            <Button type="button" variant="secondary" size="small" disabled={saving} onClick={onClose}>
              Отмена
            </Button>
            <Button type="button" variant="primary" size="small" disabled={saving} onClick={() => onSave(draft)}>
              {saving ? 'Сохранение…' : 'Сохранить'}
            </Button>
          </div>
        </div>
      </div>
    </Modal>
  );
}
