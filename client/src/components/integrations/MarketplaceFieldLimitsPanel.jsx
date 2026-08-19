/**
 * Правая панель: лимиты длины полей карточки для выбранного маркетплейса.
 */

import React, { useEffect, useMemo, useState } from 'react';
import { Button } from '../common/Button/Button.jsx';
import { marketplaceCabinetsApi } from '../../services/marketplaceCabinets.api.js';
import {
  MP_LIMITABLE_FIELDS,
  normalizeFieldLimits,
  parseCabinetConfig,
} from '../../utils/marketplaceFieldLimits.js';

const TYPE_LABEL = {
  ozon: 'Ozon',
  wildberries: 'Wildberries',
  yandex: 'Яндекс.Маркет',
};

function newRule(availableFields) {
  return {
    field: availableFields[0]?.key || 'name',
    max_length: availableFields[0]?.key === 'name' ? 60 : 5000,
  };
}

export function MarketplaceFieldLimitsPanel({
  marketplaceType,
  organizationId,
  cabinets,
  onSaved,
}) {
  const fields = MP_LIMITABLE_FIELDS[marketplaceType] || MP_LIMITABLE_FIELDS.ozon;
  const typeCabinets = useMemo(
    () => (cabinets || []).filter((c) => c.marketplace_type === marketplaceType),
    [cabinets, marketplaceType]
  );

  const [rules, setRules] = useState([]);
  const [saving, setSaving] = useState(false);
  const [message, setMessage] = useState('');
  const [error, setError] = useState('');

  useEffect(() => {
    const source = typeCabinets.find((c) => parseCabinetConfig(c.config).field_limits) || typeCabinets[0];
    const cfg = parseCabinetConfig(source?.config);
    setRules(normalizeFieldLimits(cfg.field_limits));
    setMessage('');
    setError('');
  }, [typeCabinets, marketplaceType]);

  const used = new Set(rules.map((r) => r.field));
  const availableToAdd = fields.filter((f) => !used.has(f.key));

  const handleAdd = () => {
    if (!availableToAdd.length) return;
    setRules((prev) => [...prev, newRule(availableToAdd)]);
    setMessage('');
  };

  const handleChange = (index, key, value) => {
    setRules((prev) =>
      prev.map((rule, i) => {
        if (i !== index) return rule;
        if (key === 'max_length') {
          const n = value === '' ? '' : Number(value);
          return { ...rule, max_length: n };
        }
        return { ...rule, [key]: value };
      })
    );
    setMessage('');
  };

  const handleRemove = (index) => {
    setRules((prev) => prev.filter((_, i) => i !== index));
    setMessage('');
  };

  const handleSave = async () => {
    if (!organizationId) {
      setError('Выберите организацию');
      return;
    }
    if (!typeCabinets.length) {
      setError('Сначала добавьте кабинет слева — лимиты сохраняются в его настройках.');
      return;
    }
    const normalized = normalizeFieldLimits(
      rules.map((r) => ({
        field: r.field,
        max_length: Number(r.max_length),
      }))
    );
    const unknown = normalized.filter((r) => !fields.some((f) => f.key === r.field));
    if (unknown.length) {
      setError('Выберите поле из списка');
      return;
    }
    setSaving(true);
    setError('');
    setMessage('');
    try {
      await Promise.all(
        typeCabinets.map((cab) => {
          const cfg = parseCabinetConfig(cab.config);
          return marketplaceCabinetsApi.update(organizationId, cab.id, {
            config: { ...cfg, field_limits: normalized },
          });
        })
      );
      setRules(normalized);
      setMessage('Лимиты сохранены');
      onSaved?.();
    } catch (err) {
      setError(err?.response?.data?.message || err?.message || 'Не удалось сохранить лимиты');
    } finally {
      setSaving(false);
    }
  };

  return (
    <aside className="marketplace-field-limits">
      <h3 className="marketplace-field-limits__title">Лимиты полей</h3>
      <p className="marketplace-field-limits__hint">
        Для {TYPE_LABEL[marketplaceType] || marketplaceType}: выберите поле и максимум символов.
        При превышении поле подсветится красным в карточке товара и в массовом редактировании.
        При сохранении и отправке на маркетплейс появится уведомление.
      </p>

      {rules.length === 0 ? (
        <div className="marketplace-field-limits__empty">Ограничения не заданы</div>
      ) : (
        <div className="marketplace-field-limits__list">
          {rules.map((rule, index) => {
            const options = fields.filter((f) => f.key === rule.field || !used.has(f.key));
            return (
              <div key={`${rule.field}-${index}`} className="marketplace-field-limits__row">
                <select
                  className="input"
                  value={rule.field}
                  onChange={(e) => handleChange(index, 'field', e.target.value)}
                  aria-label="Поле"
                >
                  {options.map((f) => (
                    <option key={f.key} value={f.key}>
                      {f.label}
                    </option>
                  ))}
                </select>
                <input
                  type="number"
                  className="input"
                  min="1"
                  step="1"
                  placeholder="макс."
                  value={rule.max_length}
                  onChange={(e) => handleChange(index, 'max_length', e.target.value)}
                  aria-label="Не более символов"
                />
                <span className="marketplace-field-limits__suffix">симв.</span>
                <button
                  type="button"
                  className="marketplace-field-limits__remove"
                  onClick={() => handleRemove(index)}
                  aria-label="Удалить ограничение"
                >
                  ×
                </button>
              </div>
            );
          })}
        </div>
      )}

      <div className="marketplace-field-limits__actions">
        <Button
          type="button"
          variant="secondary"
          size="small"
          onClick={handleAdd}
          disabled={!availableToAdd.length}
        >
          + Добавить поле
        </Button>
        <Button type="button" variant="primary" size="small" onClick={handleSave} disabled={saving}>
          {saving ? 'Сохранение…' : 'Сохранить лимиты'}
        </Button>
      </div>
      {error ? <div className="marketplace-field-limits__error">{error}</div> : null}
      {message ? <div className="marketplace-field-limits__ok">{message}</div> : null}
    </aside>
  );
}
