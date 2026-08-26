/**
 * Правая панель: лимиты длины/числа слов полей карточки для выбранного маркетплейса.
 */

import React, { useEffect, useMemo, useRef, useState } from 'react';
import { Button } from '../common/Button/Button.jsx';
import { marketplaceCabinetsApi } from '../../services/marketplaceCabinets.api.js';
import { productAttributesApi } from '../../services/productAttributes.api.js';
import { userCategoriesApi } from '../../services/userCategories.api.js';
import { isSystemPriceAttr } from '../../utils/attributeFormula.js';
import { isOzonAnnotationAttr, isOzonNameAttr } from '../../utils/ozonCardTextAttrs.js';
import { isOzonBrandAttr } from '../../utils/ozonBrandAttr.js';
import { normalizeAttrMpLinks } from '../../utils/productAttributeMpLinks.js';
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

const MP_CODE = {
  ozon: 'ozon',
  wildberries: 'wb',
  yandex: 'ym',
};

function unwrapList(res) {
  if (Array.isArray(res)) return res;
  if (Array.isArray(res?.data)) return res.data;
  if (Array.isArray(res?.data?.data)) return res.data.data;
  return [];
}

function mpAttrsFromResponse(res) {
  const raw = res?.data ?? res;
  if (Array.isArray(raw)) return raw;
  if (Array.isArray(raw?.attributes)) return raw.attributes;
  if (Array.isArray(raw?.data)) return raw.data;
  return [];
}

function parseMappings(raw) {
  if (!raw) return {};
  if (typeof raw === 'string') {
    try {
      const parsed = JSON.parse(raw);
      return parsed && typeof parsed === 'object' ? parsed : {};
    } catch {
      return {};
    }
  }
  return typeof raw === 'object' ? raw : {};
}

function categoryHasMpMapping(cat, mpCode) {
  const mm = parseMappings(cat?.marketplace_mappings ?? cat?.marketplaceMappings);
  if (mpCode === 'ozon') {
    return !!(mm.ozon || mm.ozon_description_category_id || mm.ozonDescriptionCategoryId);
  }
  if (mpCode === 'wb') return !!(mm.wb || mm.wildberries || mm.wb_subject_id || mm.wbSubjectId);
  if (mpCode === 'ym') return !!(mm.ym || mm.yandex);
  return false;
}

function mappingSignature(cat, mpCode) {
  const mm = parseMappings(cat?.marketplace_mappings ?? cat?.marketplaceMappings);
  if (mpCode === 'ozon') {
    const composite = mm.ozon != null ? String(mm.ozon).trim() : '';
    if (composite) return `ozon:${composite}`;
    const d = mm.ozon_description_category_id ?? mm.ozonDescriptionCategoryId;
    const t = mm.ozon_type_id ?? mm.ozonTypeId;
    if (d && t) return `ozon:${d}_${t}`;
    return '';
  }
  if (mpCode === 'wb') {
    const id = mm.wb ?? mm.wildberries ?? mm.wb_subject_id ?? mm.wbSubjectId;
    return id ? `wb:${id}` : '';
  }
  if (mpCode === 'ym') {
    const id = mm.ym ?? mm.yandex;
    return id ? `ym:${id}` : '';
  }
  return '';
}

function mpAttrIdentity(mpCode, attr) {
  if (mpCode === 'wb') {
    const id = attr?.charcID ?? attr?.characteristic_id ?? attr?.id ?? attr?.attribute_id ?? attr?.name;
    const name = attr?.name ?? attr?.charcName ?? attr?.characteristic_name ?? '';
    return { id: id != null ? String(id).trim() : '', name: String(name).trim() };
  }
  const id = attr?.id ?? attr?.attribute_id;
  const name = attr?.name ?? '';
  return { id: id != null ? String(id).trim() : '', name: String(name).trim() };
}

function dedicatedFields(marketplaceType) {
  return (MP_LIMITABLE_FIELDS[marketplaceType] || []).map((f) => ({
    ...f,
    group: 'Карточка',
  }));
}

function mergeFields(current, incoming) {
  const seen = new Set(current.map((f) => f.key));
  const out = [...current];
  for (const field of incoming) {
    if (!field?.key || seen.has(field.key)) continue;
    seen.add(field.key);
    out.push(field);
  }
  return out;
}

function fieldsFromCategoryMpLinks(cats, mpCode, groupLabel) {
  const fields = [];
  const seen = new Set();
  for (const cat of cats || []) {
    const map = cat?.attribute_mp_links;
    if (!map || typeof map !== 'object') continue;
    for (const raw of Object.values(map)) {
      const links = normalizeAttrMpLinks(raw);
      for (const entry of links[mpCode] || []) {
        if (!entry.id) continue;
        const key = `${mpCode}:${entry.id}`;
        if (seen.has(key)) continue;
        seen.add(key);
        fields.push({
          key,
          label: entry.name || `ID ${entry.id}`,
          group: groupLabel,
        });
      }
    }
  }
  return fields;
}

function LimitFieldSelect({ value, optionGroups, onChange, ariaLabel }) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState('');
  const rootRef = useRef(null);

  useEffect(() => {
    if (!open) return undefined;
    const onDoc = (e) => {
      if (rootRef.current && !rootRef.current.contains(e.target)) setOpen(false);
    };
    document.addEventListener('mousedown', onDoc);
    return () => document.removeEventListener('mousedown', onDoc);
  }, [open]);

  const selected = optionGroups.flatMap(([, list]) => list).find((f) => f.key === value);
  const qn = query.trim().toLowerCase();
  const filtered = optionGroups
    .map(([label, list]) => [
      label,
      qn ? list.filter((f) => `${f.label} ${f.key}`.toLowerCase().includes(qn)) : list,
    ])
    .filter(([, list]) => list.length);

  return (
    <div className="marketplace-field-limits__picker" ref={rootRef}>
      <button
        type="button"
        className="input marketplace-field-limits__picker-btn"
        onClick={() => setOpen((v) => !v)}
        aria-label={ariaLabel}
        title={selected?.label || value}
      >
        {selected?.label || value || 'Поле'}
      </button>
      {open ? (
        <div className="marketplace-field-limits__picker-menu">
          <input
            autoFocus
            type="search"
            className="input marketplace-field-limits__picker-search"
            placeholder="Найти атрибут…"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
          />
          {filtered.length === 0 ? (
            <div className="marketplace-field-limits__empty">Ничего не найдено</div>
          ) : (
            filtered.map(([label, list]) => (
              <div key={label}>
                <div className="marketplace-field-limits__picker-group">{label}</div>
                {list.map((f) => (
                  <button
                    key={f.key}
                    type="button"
                    className={`marketplace-field-limits__picker-item${f.key === value ? ' is-active' : ''}`}
                    onClick={() => {
                      onChange(f.key);
                      setOpen(false);
                      setQuery('');
                    }}
                  >
                    {f.label}
                  </button>
                ))}
              </div>
            ))
          )}
        </div>
      ) : null}
    </div>
  );
}

function newRule(available) {
  const field = available[0];
  const kind = field?.kind || 'chars';
  return {
    field: field?.key || 'name',
    field_label: field?.label || '',
    kind,
    max: kind === 'words' ? 10 : field?.key === 'name' ? 60 : 5000,
  };
}

function ruleDedupeKey(rule) {
  return `${rule.field}::${rule.kind === 'words' ? 'words' : 'chars'}`;
}

export function MarketplaceFieldLimitsPanel({
  marketplaceType,
  organizationId,
  cabinets,
  onSaved,
}) {
  const typeCabinets = useMemo(
    () => (cabinets || []).filter((c) => c.marketplace_type === marketplaceType),
    [cabinets, marketplaceType]
  );

  const [catalog, setCatalog] = useState(() => dedicatedFields(marketplaceType));
  const [catalogStatus, setCatalogStatus] = useState('');
  const [fieldFilter, setFieldFilter] = useState('');
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

  useEffect(() => {
    let cancelled = false;
    const mpCode = MP_CODE[marketplaceType] || 'ozon';
    const groupLabel = `Характеристики ${TYPE_LABEL[marketplaceType] || mpCode}`;

    const run = async () => {
      setCatalog(dedicatedFields(marketplaceType));
      setCatalogStatus('Загрузка атрибутов ERP…');

      let next = dedicatedFields(marketplaceType);
      try {
        const res = await productAttributesApi.getAll();
        const attrs = unwrapList(res);
        const erp = [];
        for (const attr of attrs) {
          if (!attr?.id || isSystemPriceAttr(attr)) continue;
          erp.push({
            key: `erp:${attr.id}`,
            label: attr.name || `Атрибут ${attr.id}`,
            group: 'Атрибуты ERP',
          });
        }
        next = mergeFields(next, erp);
        if (!cancelled) setCatalog(next);
      } catch {
        /* список ERP не обязателен */
      }

      if (cancelled) return;
      setCatalogStatus('Загрузка характеристик маркетплейса…');

      try {
        const catsRes = await userCategoriesApi.getAll();
        const cats = unwrapList(catsRes);
        next = mergeFields(next, fieldsFromCategoryMpLinks(cats, mpCode, groupLabel));
        if (!cancelled) setCatalog(next);

        const mapped = cats.filter((c) => categoryHasMpMapping(c, mpCode));
        const unique = [];
        const seenMap = new Set();
        for (const cat of mapped) {
          const sig = mappingSignature(cat, mpCode);
          if (!sig || seenMap.has(sig)) continue;
          seenMap.add(sig);
          unique.push(cat);
        }
        const queue = unique.slice(0, 80);
        for (let i = 0; i < queue.length; i += 4) {
          if (cancelled) return;
          const chunk = queue.slice(i, i + 4);
          const results = await Promise.all(
            chunk.map((cat) =>
              userCategoriesApi
                .getMarketplaceAttributes(cat.id, mpCode, { organizationId })
                .catch(() => null)
            )
          );
          const incoming = [];
          for (const res of results) {
            for (const attr of mpAttrsFromResponse(res)) {
              if (mpCode === 'ozon') {
                if (isOzonNameAttr(attr) || isOzonAnnotationAttr(attr) || isOzonBrandAttr(attr)) continue;
              }
              const { id, name } = mpAttrIdentity(mpCode, attr);
              if (!id) continue;
              incoming.push({
                key: `${mpCode}:${id}`,
                label: name || `ID ${id}`,
                group: groupLabel,
              });
            }
          }
          if (incoming.length) {
            next = mergeFields(next, incoming);
            if (!cancelled) setCatalog(next);
          }
        }
      } catch {
        /* характеристики МП подгружаются по возможности */
      }

      if (!cancelled) setCatalogStatus('');
    };

    run();
    return () => {
      cancelled = true;
    };
  }, [marketplaceType, organizationId]);

  const used = new Set(rules.map(ruleDedupeKey));
  const filterNorm = fieldFilter.trim().toLowerCase();
  const filteredCatalog = useMemo(() => {
    if (!filterNorm) return catalog;
    return catalog.filter((f) =>
      `${f.label} ${f.key} ${f.group}`.toLowerCase().includes(filterNorm)
    );
  }, [catalog, filterNorm]);

  const availableCombos = [];
  for (const field of catalog) {
    for (const kind of ['chars', 'words']) {
      if (!used.has(`${field.key}::${kind}`)) {
        availableCombos.push({ ...field, kind });
      }
    }
  }

  const handleAdd = () => {
    if (!availableCombos.length) return;
    const preferred = filterNorm
      ? availableCombos.find((f) => `${f.label} ${f.key}`.toLowerCase().includes(filterNorm))
      : availableCombos[0];
    setRules((prev) => [...prev, newRule(preferred ? [preferred] : availableCombos)]);
    setMessage('');
  };

  const handleChange = (index, key, value) => {
    setRules((prev) =>
      prev.map((rule, i) => {
        if (i !== index) return rule;
        if (key === 'max') {
          const n = value === '' ? '' : Number(value);
          return { ...rule, max: n };
        }
        if (key === 'field') {
          const meta = catalog.find((f) => f.key === value);
          return { ...rule, field: value, field_label: meta?.label || rule.field_label };
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
        field_label: r.field_label || catalog.find((f) => f.key === r.field)?.label || '',
        kind: r.kind === 'words' ? 'words' : 'chars',
        max: Number(r.max),
      }))
    );
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

  const catalogCounts = useMemo(() => {
    const counts = { card: 0, erp: 0, mp: 0 };
    for (const f of catalog) {
      if (f.group === 'Карточка') counts.card += 1;
      else if (f.group === 'Атрибуты ERP') counts.erp += 1;
      else counts.mp += 1;
    }
    return counts;
  }, [catalog]);

  return (
    <aside className="marketplace-field-limits">
      <h3 className="marketplace-field-limits__title">Лимиты полей</h3>
      <p className="marketplace-field-limits__hint">
        Для {TYPE_LABEL[marketplaceType] || marketplaceType}: поле карточки, атрибут ERP или
        характеристика маркетплейса. Лимит — по символам или по словам (слова разделяются пробелом,
        запятой или точкой с запятой). При превышении поле краснеет в карточке и в массовом
        редактировании; при сохранении и отправке на МП появится уведомление.
      </p>
      <div className="marketplace-field-limits__meta">
        В списке: {catalogCounts.card} полей карточки, {catalogCounts.erp} атрибутов ERP
        {catalogCounts.mp ? `, ${catalogCounts.mp} характеристик МП` : ''}
        {catalogStatus ? ` · ${catalogStatus}` : ''}
      </div>

      <input
        type="search"
        className="input marketplace-field-limits__search"
        placeholder="Поиск поля или атрибута…"
        value={fieldFilter}
        onChange={(e) => setFieldFilter(e.target.value)}
      />

      {rules.length === 0 ? (
        <div className="marketplace-field-limits__empty">Ограничения не заданы</div>
      ) : (
        <div className="marketplace-field-limits__list">
          {rules.map((rule, index) => {
            const selected = catalog.find((f) => f.key === rule.field);
            const options = filteredCatalog.filter((f) => {
              if (f.key === rule.field) return true;
              return !used.has(`${f.key}::${rule.kind === 'words' ? 'words' : 'chars'}`);
            });
            const optionGroups = [];
            const grouped = new Map();
            for (const f of options) {
              const g = f.group || 'Прочее';
              if (!grouped.has(g)) grouped.set(g, []);
              grouped.get(g).push(f);
            }
            for (const [label, list] of grouped.entries()) optionGroups.push([label, list]);
            if (selected && !options.some((f) => f.key === selected.key)) {
              optionGroups.unshift(['Выбрано', [selected]]);
            }
            return (
              <div key={`${rule.field}-${rule.kind}-${index}`} className="marketplace-field-limits__row">
                <LimitFieldSelect
                  value={rule.field}
                  optionGroups={optionGroups}
                  onChange={(next) => handleChange(index, 'field', next)}
                  ariaLabel="Поле"
                />
                <select
                  className="input"
                  value={rule.kind === 'words' ? 'words' : 'chars'}
                  onChange={(e) => handleChange(index, 'kind', e.target.value)}
                  aria-label="Тип лимита"
                >
                  <option value="chars">символы</option>
                  <option value="words">слова</option>
                </select>
                <input
                  type="number"
                  className="input"
                  min="1"
                  step="1"
                  placeholder="макс."
                  value={rule.max}
                  onChange={(e) => handleChange(index, 'max', e.target.value)}
                  aria-label={rule.kind === 'words' ? 'Не более слов' : 'Не более символов'}
                />
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
          disabled={!availableCombos.length}
        >
          + Добавить поле
        </Button>
        <Button type="button" variant="primary" size="small" onClick={handleSave} disabled={saving}>
          {saving ? 'Сохранение…' : 'Сохранить лимиты'}
        </Button>
      </div>
      {error ? <div className="marketplace-field-limits__error">{error}</div> : null}
      {message ? <div className="marketplace-field-limits__ok">{message}</div> : null}
      {filteredCatalog.length === 0 && fieldFilter.trim() ? (
        <div className="marketplace-field-limits__empty">Ничего не найдено по «{fieldFilter}»</div>
      ) : null}
    </aside>
  );
}
