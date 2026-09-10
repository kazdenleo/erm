/**
 * Attributes Page
 * Справочник атрибутов. Связь с характеристиками МП задаётся здесь: на все категории или на выбранные.
 */

import React, { useState, useEffect, useMemo } from 'react';
import { productAttributesApi } from '../../services/productAttributes.api';
import { userCategoriesApi } from '../../services/userCategories.api';
import { Button } from '../../components/common/Button/Button';
import { Modal } from '../../components/common/Modal/Modal';
import { AttributeCategoryMpLinksPanel } from './AttributeCategoryMpLinksPanel.jsx';
import { MpMappedMpBadges } from '../../components/common/MpFieldLinkToggles/MpFieldLinkToggles.jsx';
import {
  ATTR_MP_CODES,
  attrMpLinksHasAny,
  normalizeAttrMpLinks,
} from '../../utils/productAttributeMpLinks.js';
import { normalizeCategoryDedicatedCharcLinks } from '../../utils/productMpFieldLinks.js';
import {
  isComputedAttrType,
  isSystemPriceAttr,
  PRODUCT_FORMULA_FIELDS,
  validateFormula,
} from '../../utils/attributeFormula.js';
import { isEditableAttrType } from '../../utils/editableAttribute.js';
import { useAiEnabled } from '../../hooks/useAiEnabled.js';
import {
  isSystemCardAttr,
  isSystemMainFieldAttr,
  SYSTEM_MAIN_FIELD_KEYS,
} from '../../utils/systemMainFieldAttributes.js';
import './Attributes.css';

const TYPE_LABELS = {
  text: 'Текст',
  checkbox: 'Флажок',
  number: 'Число',
  date: 'Дата',
  dictionary: 'Словарь',
  computed: 'Вычисляемое поле',
  editable: 'Редактируемое поле',
};

const TYPE_OPTIONS_CUSTOM = Object.entries(TYPE_LABELS);
const TYPE_OPTIONS_MAIN = Object.entries(TYPE_LABELS).filter(
  ([value]) => value !== 'dictionary' && value !== 'checkbox' && value !== 'date'
);

function linksOfCategoryForAttr(cat, attr) {
  if (isSystemMainFieldAttr(attr)) {
    const dedicated = normalizeCategoryDedicatedCharcLinks(cat?.mp_field_links);
    return normalizeAttrMpLinks(dedicated[attr.system_key]);
  }
  const map = cat?.attribute_mp_links && typeof cat.attribute_mp_links === 'object'
    ? cat.attribute_mp_links
    : {};
  return normalizeAttrMpLinks(map[String(attr.id)] ?? map[attr.id]);
}

function collectAttrLinkStats(attr, categories) {
  if (isSystemPriceAttr(attr)) {
    return { na: true, mps: [], catCount: 0, total: 0, mixed: false };
  }
  const list = Array.isArray(categories) ? categories : [];
  const total = list.length;
  if (!total) return { na: false, mps: [], catCount: 0, total: 0, mixed: false };
  const perCat = list.map((cat) => linksOfCategoryForAttr(cat, attr));
  const withLinks = perCat.filter((links) => attrMpLinksHasAny(links));
  const mps = ATTR_MP_CODES.filter((mp) => withLinks.some((links) => (links[mp] || []).length > 0));
  const sigs = new Set(withLinks.map((links) => JSON.stringify(links)));
  return {
    na: false,
    mps,
    catCount: withLinks.length,
    total,
    mixed: sigs.size > 1,
  };
}

function AttrLinksCell({ stats }) {
  if (!stats || stats.na) return <span className="muted">—</span>;
  if (!stats.catCount) return <span className="muted">нет</span>;
  const scope =
    stats.catCount === stats.total
      ? 'все категории'
      : `${stats.catCount} из ${stats.total} кат.`;
  return (
    <div className="attributes-links-cell">
      <MpMappedMpBadges mps={stats.mps} size={16} />
      <span className="muted">
        {scope}
        {stats.mixed ? ' · разные' : ''}
      </span>
    </div>
  );
}

function AttributeForm({ attribute, attributes = [], onSubmit, onCancel }) {
  const { enabled: aiIntegrationEnabled } = useAiEnabled();
  const [name, setName] = useState(attribute?.name || '');
  const [type, setType] = useState(attribute?.type || 'text');
  const [formula, setFormula] = useState(attribute?.formula || '');
  const [showRelatedFields, setShowRelatedFields] = useState(
    !!(attribute?.show_related_fields ?? attribute?.showRelatedFields)
  );
  const [aiChatEnabled, setAiChatEnabled] = useState(
    !!(attribute?.ai_chat_enabled ?? attribute?.aiChatEnabled)
  );
  const isSystem = isSystemCardAttr(attribute);
  const isMainField = isSystemMainFieldAttr(attribute);
  const priceLocked = isSystemPriceAttr(attribute);
  const typeLocked = priceLocked;
  const nameLocked = isSystem;
  const typeOptions = isMainField || priceLocked ? TYPE_OPTIONS_MAIN : TYPE_OPTIONS_CUSTOM;
  const sortDict = (arr) => [...arr].sort((a, b) => String(a).localeCompare(String(b), 'ru'));
  const [dictionaryValues, setDictionaryValues] = useState(
    attribute?.dictionary_values && Array.isArray(attribute.dictionary_values)
      ? sortDict(attribute.dictionary_values)
      : []
  );
  const [newDictItem, setNewDictItem] = useState('');
  const [error, setError] = useState('');

  const addDictionaryValue = () => {
    const v = newDictItem.trim();
    if (!v) return;
    setDictionaryValues((prev) => {
      const next = prev.includes(v) ? prev : [...prev, v];
      return next.sort((a, b) => String(a).localeCompare(String(b), 'ru'));
    });
    setNewDictItem('');
  };

  const removeDictionaryValue = (v) => {
    setDictionaryValues((prev) => prev.filter((x) => x !== v));
  };

  const insertFormulaToken = (token) => {
    setFormula((prev) => `${prev || ''}${token}`);
  };

  const handleSubmit = (e) => {
    e.preventDefault();
    if (!name.trim()) {
      setError('Введите название атрибута');
      return;
    }
    if (isComputedAttrType(type) && String(formula || '').trim()) {
      const formulaError = validateFormula(formula);
      if (formulaError) {
        setError(formulaError);
        return;
      }
    }
    setError('');
    const payload = {
      type,
      dictionary_values: type === 'dictionary' ? sortDict(dictionaryValues) : undefined,
      formula: isComputedAttrType(type) ? String(formula || '').trim() : '',
      show_related_fields: isEditableAttrType(type) ? !!showRelatedFields : false,
      ai_chat_enabled: isEditableAttrType(type) ? !!aiChatEnabled : false,
    };
    if (!nameLocked) payload.name = name.trim();
    onSubmit(payload);
  };

  return (
    <form onSubmit={handleSubmit} className="attribute-form">
      {error && <div className="form-error">{error}</div>}
      <div className="form-group">
        <label>Название</label>
        <input
          type="text"
          value={name}
          onChange={(e) => setName(e.target.value)}
          placeholder="Например: Цвет, Размер"
          disabled={nameLocked}
        />
        {isMainField ? (
          <p className="form-hint">
            Поле вкладки «Основное» карточки товара (ключ: <code>{attribute.system_key}</code>).
            Значение хранится в карточке, здесь настраивается только тип отображения.
          </p>
        ) : null}
        {priceLocked ? (
          <p className="form-hint">Системное поле цены карточки: тип менять нельзя, формулу и ручной ввод — можно.</p>
        ) : null}
      </div>
      <div className="form-group">
        <label>Тип</label>
        <select
          value={type}
          onChange={(e) => setType(e.target.value)}
          disabled={typeLocked}
        >
          {typeOptions.map(([value, label]) => (
            <option key={value} value={value}>{label}</option>
          ))}
        </select>
      </div>
      {isComputedAttrType(type) && (
        <div className="form-group">
          <label>Формула</label>
          <textarea
            className="formula-input"
            rows={3}
            value={formula}
            onChange={(e) => setFormula(e.target.value)}
            placeholder="{cost} * 1.5 + {additional_expenses}"
          />
          <p className="form-hint">
            Математика: + − * / и скобки. Поля можно писать как <code>{'{cost}'}</code> или просто <code>cost</code>.
            Пример: <code>{'{cost} * 1.4'}</code>, <code>{'(cost)*4'}</code>, <code>{'{себестоимость} + {additional_expenses}'}</code>.
            Если формула пустая, значение можно просто ввести в карточке товара.
          </p>
          <div className="formula-chips">
            {PRODUCT_FORMULA_FIELDS.map((field) => (
              <button
                key={field.key}
                type="button"
                className="formula-chip"
                onClick={() => insertFormulaToken(`{${field.key}}`)}
              >
                {field.label}
              </button>
            ))}
            {(attributes || [])
              .filter((a) => String(a.id) !== String(attribute?.id || '') && !isSystemMainFieldAttr(a))
              .slice()
              .sort((a, b) => String(a.name || '').localeCompare(String(b.name || ''), 'ru'))
              .map((a) => (
                <button
                  key={a.id}
                  type="button"
                  className="formula-chip"
                  onClick={() => insertFormulaToken(`{${a.name}}`)}
                >
                  {a.name}
                </button>
              ))}
          </div>
        </div>
      )}
      {isEditableAttrType(type) && (
        <div className="form-group">
          <label className="form-check-label d-flex align-items-center gap-2">
            <input
              type="checkbox"
              className="form-check-input m-0"
              checked={showRelatedFields}
              onChange={(e) => setShowRelatedFields(e.target.checked)}
            />
            Показывать связанные поля
          </label>
          <p className="form-hint">
            В массовом редактировании при правке открывается окно с основным значением и связанными полями
            маркетплейсов (как у «Название» и «Описание»).
          </p>
        </div>
      )}
      {isEditableAttrType(type) && aiIntegrationEnabled ? (
        <div className="form-group">
          <label className="form-check-label d-flex align-items-center gap-2">
            <input
              type="checkbox"
              className="form-check-input m-0"
              checked={aiChatEnabled}
              onChange={(e) => setAiChatEnabled(e.target.checked)}
            />
            ИИ-чат в редакторе
          </label>
          <p className="form-hint">
            В попапе редактирования — чат GigaChat: модель видит выбранные поля карточки (название, OEM, бренд…)
            и может заполнить это поле и связанные характеристики МП. Результат применяется кнопкой «Вставить».
          </p>
        </div>
      ) : null}
      {type === 'dictionary' && !isMainField && (
        <div className="form-group">
          <label>Значения словаря</label>
          <div className="dictionary-editor">
            <div className="dictionary-list">
              {sortDict(dictionaryValues).map((v) => (
                <span key={v} className="dict-tag">
                  {v}
                  <button type="button" onClick={() => removeDictionaryValue(v)} aria-label="Удалить">×</button>
                </span>
              ))}
            </div>
            <div className="dictionary-add">
              <input
                type="text"
                value={newDictItem}
                onChange={(e) => setNewDictItem(e.target.value)}
                placeholder="Добавить значение"
                onKeyDown={(e) => e.key === 'Enter' && (e.preventDefault(), addDictionaryValue())}
              />
              <Button type="button" variant="secondary" size="small" onClick={addDictionaryValue}>Добавить</Button>
            </div>
          </div>
        </div>
      )}
      <div className="form-group">
        <label>Связь с маркетплейсами</label>
        {isMainField ? (
          <AttributeCategoryMpLinksPanel dedicatedKey={attribute.system_key} />
        ) : priceLocked ? (
          <p className="muted" style={{ margin: 0 }}>
            Цены не сопоставляются с характеристиками карточки маркетплейса.
          </p>
        ) : attribute?.id ? (
          <AttributeCategoryMpLinksPanel attributeId={attribute.id} />
        ) : (
          <p className="muted" style={{ margin: 0 }}>
            Сначала сохраните атрибут, затем откройте его снова — здесь можно задать связь OZ / WB / ЯМ
            сразу для всех категорий или только для выбранных.
          </p>
        )}
      </div>
      <div className="form-actions">
        <Button type="button" variant="secondary" onClick={onCancel}>Отмена</Button>
        <Button type="submit" variant="primary">Сохранить</Button>
      </div>
    </form>
  );
}

export function Attributes() {
  const [list, setList] = useState([]);
  const [categories, setCategories] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [modalOpen, setModalOpen] = useState(false);
  const [editing, setEditing] = useState(null);
  const [tab, setTab] = useState('default');

  const load = async ({ silent = false } = {}) => {
    if (!silent) {
      setLoading(true);
      setError(null);
    }
    try {
      const [attrRes, catRes] = await Promise.all([
        productAttributesApi.getAll(),
        userCategoriesApi.getAll().catch(() => ({ data: [] })),
      ]);
      setList(attrRes?.data || []);
      setCategories(Array.isArray(catRes?.data) ? catRes.data : []);
    } catch (err) {
      if (!silent) setError(err?.message || 'Ошибка загрузки');
    } finally {
      if (!silent) setLoading(false);
    }
  };

  useEffect(() => {
    load();
  }, []);

  const defaultList = useMemo(() => {
    const system = (list || []).filter((a) => isSystemCardAttr(a));
    const order = new Map([
      ...SYSTEM_MAIN_FIELD_KEYS.map((k, i) => [k, i]),
      ['price_before_discount', 100],
      ['price_after_discount', 101],
    ]);
    return system.slice().sort((a, b) => {
      const ka = String(a.system_key || '');
      const kb = String(b.system_key || '');
      const oa = order.has(ka) ? order.get(ka) : 50;
      const ob = order.has(kb) ? order.get(kb) : 50;
      if (oa !== ob) return oa - ob;
      return String(a.name || '').localeCompare(String(b.name || ''), 'ru');
    });
  }, [list]);

  const customList = useMemo(
    () =>
      (list || [])
        .filter((a) => !isSystemCardAttr(a))
        .slice()
        .sort((a, b) => String(a.name || '').localeCompare(String(b.name || ''), 'ru')),
    [list]
  );

  const visibleList = tab === 'default' ? defaultList : customList;

  const linkStatsById = useMemo(() => {
    const out = new Map();
    for (const attr of list || []) {
      out.set(String(attr.id), collectAttrLinkStats(attr, categories));
    }
    return out;
  }, [list, categories]);

  const closeModal = () => {
    setModalOpen(false);
    setEditing(null);
    void load({ silent: true });
  };

  const handleCreate = () => {
    setEditing(null);
    setTab('custom');
    setModalOpen(true);
  };

  const handleEdit = (attr) => {
    setEditing(attr);
    setModalOpen(true);
  };

  const handleSubmit = async (data) => {
    try {
      if (editing) {
        await productAttributesApi.update(editing.id, data);
      } else {
        await productAttributesApi.create(data);
      }
      setModalOpen(false);
      setEditing(null);
      await load();
    } catch (err) {
      console.error(err);
      alert('Ошибка сохранения: ' + (err?.response?.data?.message || err?.message));
    }
  };

  const handleDelete = async (id) => {
    if (!window.confirm('Удалить этот атрибут?')) return;
    try {
      await productAttributesApi.delete(id);
      await load();
    } catch (err) {
      alert('Ошибка удаления: ' + (err?.response?.data?.message || err?.message));
    }
  };

  if (loading) return <div className="attributes-page card"><p className="loading">Загрузка...</p></div>;
  if (error) return <div className="attributes-page card"><p className="error">Ошибка: {error}</p></div>;

  return (
    <div className="attributes-page card">
      <h1 className="title">Атрибуты</h1>
      <p className="subtitle">
        «По умолчанию» — поля карточки (Название, Описание, цены и т.д.): тип, связанные поля и сопоставление
        с характеристиками OZ / WB / ЯМ на все категории или на выбранные.
        «Свои» — атрибуты, которые вы создаёте; связь с маркетплейсами задаётся так же.
      </p>

      <div className="attributes-tabs" role="tablist">
        <button
          type="button"
          role="tab"
          aria-selected={tab === 'default'}
          className={`attributes-tab${tab === 'default' ? ' is-active' : ''}`}
          onClick={() => setTab('default')}
        >
          По умолчанию
          <span className="attributes-tab-count">{defaultList.length}</span>
        </button>
        <button
          type="button"
          role="tab"
          aria-selected={tab === 'custom'}
          className={`attributes-tab${tab === 'custom' ? ' is-active' : ''}`}
          onClick={() => setTab('custom')}
        >
          Свои
          <span className="attributes-tab-count">{customList.length}</span>
        </button>
      </div>

      <div className="attributes-toolbar">
        {tab === 'custom' ? (
          <Button variant="primary" onClick={handleCreate}>➕ Добавить атрибут</Button>
        ) : (
          <p className="attributes-toolbar-hint">
            Системные поля нельзя удалить. Откройте «Изменить», чтобы сменить тип и задать связь с маркетплейсами.
          </p>
        )}
      </div>

      <div className="attributes-table-wrap">
        {visibleList.length === 0 ? (
          <div className="empty-state">
            {tab === 'custom' ? (
              <>
                <p>Своих атрибутов пока нет</p>
                <Button onClick={handleCreate}>Создать первый атрибут</Button>
              </>
            ) : (
              <p>
                Системные поля ещё не загружены. Обновите страницу после миграции{' '}
                <code>188_system_main_field_attributes</code>.
              </p>
            )}
          </div>
        ) : (
          <table className="attributes-table">
            <thead>
              <tr>
                <th>Название</th>
                <th>Тип</th>
                <th>Настройки</th>
                <th>Связи</th>
                <th style={{ width: 140 }}></th>
              </tr>
            </thead>
            <tbody>
              {visibleList.map((attr) => (
                <tr key={attr.id}>
                  <td>
                    {attr.name}
                  </td>
                  <td>{TYPE_LABELS[attr.type] || attr.type}</td>
                  <td className="formula-cell">
                    {isComputedAttrType(attr.type)
                      ? attr.formula || '—'
                      : isEditableAttrType(attr.type) && attr.show_related_fields
                        ? 'связанные поля'
                        : '—'}
                  </td>
                  <td>
                    <AttrLinksCell stats={linkStatsById.get(String(attr.id))} />
                  </td>
                  <td>
                    <Button variant="secondary" size="small" onClick={() => handleEdit(attr)}>
                      Изменить
                    </Button>
                    {!isSystemCardAttr(attr) ? (
                      <Button
                        variant="secondary"
                        size="small"
                        onClick={() => handleDelete(attr.id)}
                        className="btn-delete"
                      >
                        Удалить
                      </Button>
                    ) : null}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>

      <Modal
        isOpen={modalOpen}
        onClose={closeModal}
        title={
          editing
            ? isSystemCardAttr(editing)
              ? `Поле карточки: ${editing.name}`
              : 'Редактировать атрибут'
            : 'Добавить атрибут'
        }
        size="large"
        scrollable
      >
        <AttributeForm
          key={editing?.id || 'new'}
          attribute={editing}
          attributes={list}
          onSubmit={handleSubmit}
          onCancel={closeModal}
        />
      </Modal>
    </div>
  );
}
