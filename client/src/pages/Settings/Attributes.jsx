/**
 * Attributes Page
 * Справочник атрибутов. Связь с характеристиками МП задаётся по каждой категории.
 */

import React, { useState, useEffect } from 'react';
import { productAttributesApi } from '../../services/productAttributes.api';
import { userCategoriesApi } from '../../services/userCategories.api';
import { Button } from '../../components/common/Button/Button';
import { Modal } from '../../components/common/Modal/Modal';
import { AttributeMpLinkFields } from '../../components/common/AttributeMpLinkFields/AttributeMpLinkFields.jsx';
import {
  attrMpLinksHasAny,
  emptyAttrMpLinks,
  formatAttrMpLinksSummary,
  normalizeAttrMpLinks,
} from '../../utils/productAttributeMpLinks.js';
import { withMpOfferFieldAttrs } from '../../utils/productMpFieldLinks.js';
import { useAuth } from '../../context/AuthContext.jsx';
import {
  isComputedAttrType,
  isSystemPriceAttr,
  PRODUCT_FORMULA_FIELDS,
  validateFormula,
} from '../../utils/attributeFormula.js';
import './Attributes.css';

const TYPE_LABELS = {
  text: 'Текст',
  checkbox: 'Флажок',
  number: 'Число',
  date: 'Дата',
  dictionary: 'Словарь',
  computed: 'Вычисляемое поле',
};

function mpAttrsFromResponse(res) {
  const raw = res?.data ?? res;
  if (Array.isArray(raw)) return raw;
  if (Array.isArray(raw?.attributes)) return raw.attributes;
  if (Array.isArray(raw?.data)) return raw.data;
  return [];
}

function wbAttrKey(a) {
  const id = a?.charcID ?? a?.characteristic_id ?? a?.id ?? a?.attribute_id ?? a?.name;
  return id != null ? String(id) : String(a?.name || '');
}

function wbAttrName(a) {
  return a?.name ?? a?.charcName ?? a?.characteristic_name ?? '';
}

function linksOfCategory(cat, attributeId) {
  const map = cat?.attribute_mp_links && typeof cat.attribute_mp_links === 'object'
    ? cat.attribute_mp_links
    : {};
  return normalizeAttrMpLinks(map[String(attributeId)] ?? map[attributeId]);
}

function categoryHasAttribute(cat, attributeId) {
  return (cat?.attribute_ids || []).map((id) => String(id)).includes(String(attributeId));
}

function categoryPathName(cat, all) {
  const parentId = cat?.parent_id ?? cat?.parentId;
  if (!parentId) return cat?.name || String(cat?.id || '');
  const parent = (all || []).find((c) => String(c.id) === String(parentId));
  return parent ? `${parent.name} / ${cat.name}` : cat.name;
}

function patchCategoryAttributeState(cat, attributeId, nextLinks) {
  const ids = [...new Set([...(cat.attribute_ids || []).map(String), String(attributeId)])];
  return {
    ...cat,
    attribute_ids: ids,
    attribute_mp_links: {
      ...(cat.attribute_mp_links || {}),
      [String(attributeId)]: nextLinks,
    },
  };
}

function CategoryMpLinksPanel({ attributeId }) {
  const { selectedOrganizationId } = useAuth();
  const [categories, setCategories] = useState([]);
  const [openCatId, setOpenCatId] = useState('');
  const [addCatId, setAddCatId] = useState('');
  const [links, setLinks] = useState(() => emptyAttrMpLinks());
  const [ozonOptions, setOzonOptions] = useState([]);
  const [wbOptions, setWbOptions] = useState([]);
  const [ymOptions, setYmOptions] = useState([]);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setAddCatId('');
    userCategoriesApi
      .getAll()
      .then((res) => {
        if (cancelled) return;
        const list = Array.isArray(res?.data) ? res.data : [];
        setCategories(list);
        const linked = list.filter((c) => categoryHasAttribute(c, attributeId));
        const withLinks = linked.find((c) => attrMpLinksHasAny(linksOfCategory(c, attributeId)));
        setOpenCatId(String((withLinks || linked[0])?.id || ''));
      })
      .catch(() => {
        if (!cancelled) setCategories([]);
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [attributeId]);

  const linkedCategories = categories
    .filter((c) => categoryHasAttribute(c, attributeId))
    .slice()
    .sort((a, b) => String(a.name || '').localeCompare(String(b.name || ''), 'ru'));
  const unlinkedCategories = categories
    .filter((c) => !categoryHasAttribute(c, attributeId))
    .slice()
    .sort((a, b) => String(categoryPathName(a, categories)).localeCompare(String(categoryPathName(b, categories)), 'ru'));
  const openCat = categories.find((c) => String(c.id) === String(openCatId)) || null;

  useEffect(() => {
    if (!openCatId) {
      setLinks(emptyAttrMpLinks());
      setOzonOptions([]);
      setWbOptions([]);
      setYmOptions([]);
      return undefined;
    }
    const cat = categories.find((c) => String(c.id) === String(openCatId));
    if (!cat) {
      setLinks(emptyAttrMpLinks());
      setOzonOptions([]);
      setWbOptions([]);
      setYmOptions([]);
      return undefined;
    }
    setLinks(linksOfCategory(cat, attributeId));
    setOzonOptions(withMpOfferFieldAttrs('ozon', []));
    setWbOptions(withMpOfferFieldAttrs('wb', []));
    setYmOptions(withMpOfferFieldAttrs('ym', []));
    let cancelled = false;
    Promise.all([
      userCategoriesApi.getMarketplaceAttributes(cat.id, 'ozon', {
        organizationId: selectedOrganizationId || undefined,
      }).catch(() => null),
      userCategoriesApi.getMarketplaceAttributes(cat.id, 'wb', {
        organizationId: selectedOrganizationId || undefined,
      }).catch(() => null),
      userCategoriesApi.getMarketplaceAttributes(cat.id, 'ym', {
        organizationId: selectedOrganizationId || undefined,
      }).catch(() => null),
    ]).then(([oz, wb, ym]) => {
      if (cancelled) return;
      setOzonOptions(withMpOfferFieldAttrs('ozon', mpAttrsFromResponse(oz)));
      setWbOptions(withMpOfferFieldAttrs('wb', mpAttrsFromResponse(wb)));
      setYmOptions(withMpOfferFieldAttrs('ym', mpAttrsFromResponse(ym)));
    });
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [openCatId, attributeId, selectedOrganizationId]);

  const persistLinks = async (cat, next) => {
    setSaving(true);
    try {
      await userCategoriesApi.updateAttributeMpLinks(cat.id, attributeId, next);
      setCategories((prev) =>
        prev.map((c) =>
          String(c.id) === String(cat.id) ? patchCategoryAttributeState(c, attributeId, next) : c
        )
      );
      if (String(cat.id) === String(openCatId)) setLinks(next);
    } catch (err) {
      alert(err?.response?.data?.message || err?.response?.data?.error || 'Не удалось сохранить связь');
    } finally {
      setSaving(false);
    }
  };

  const addCategory = async () => {
    const cat = categories.find((c) => String(c.id) === String(addCatId));
    if (!cat) return;
    await persistLinks(cat, emptyAttrMpLinks());
    setOpenCatId(String(cat.id));
    setAddCatId('');
  };

  const copySources = linkedCategories.filter(
    (c) => String(c.id) !== String(openCatId) && attrMpLinksHasAny(linksOfCategory(c, attributeId))
  );

  if (loading) {
    return <p className="muted" style={{ margin: 0 }}>Загрузка категорий…</p>;
  }

  return (
    <div className="attribute-category-mp-links">
      <p className="muted" style={{ margin: '0 0 10px' }}>
        У каждой категории свой набор сопоставлений OZ / WB / ЯМ — они не затирают друг друга.
        {saving ? ' Сохранение…' : ' Изменения сохраняются сразу.'}
      </p>
      {unlinkedCategories.length > 0 ? (
        <div className="attribute-cat-mp-add">
          <select
            className="form-select form-select-sm"
            value={addCatId}
            onChange={(e) => setAddCatId(e.target.value)}
            disabled={saving}
          >
            <option value="">Другая категория…</option>
            {unlinkedCategories.map((c) => (
              <option key={c.id} value={c.id}>
                {categoryPathName(c, categories)}
              </option>
            ))}
          </select>
          <button
            type="button"
            className="btn btn-outline-secondary btn-sm"
            disabled={!addCatId || saving}
            onClick={() => void addCategory()}
          >
            Добавить и настроить
          </button>
        </div>
      ) : null}
      {linkedCategories.length === 0 ? (
        <p className="muted" style={{ margin: 0 }}>
          Атрибут ещё не привязан ни к одной категории. Выберите категорию выше — для неё можно задать свой набор сопоставлений.
        </p>
      ) : (
        <div className="attribute-cat-mp-list">
          {linkedCategories.map((c) => {
            const isOpen = String(c.id) === String(openCatId);
            const summary = formatAttrMpLinksSummary(linksOfCategory(c, attributeId));
            return (
              <div key={c.id} className={`attribute-cat-mp-card${isOpen ? ' is-open' : ''}`}>
                <button
                  type="button"
                  className="attribute-cat-mp-card__head"
                  onClick={() => setOpenCatId(String(c.id))}
                >
                  <span className="attribute-cat-mp-card__name">{categoryPathName(c, categories)}</span>
                  <span className="attribute-cat-mp-card__summary">{summary}</span>
                </button>
                {isOpen && openCat ? (
                  <div className="attribute-cat-mp-card__body">
                    {copySources.length > 0 ? (
                      <div className="attribute-cat-mp-copy">
                        <span className="muted">Скопировать связи из</span>
                        {copySources.map((src) => (
                          <button
                            key={src.id}
                            type="button"
                            className="btn btn-outline-secondary btn-sm"
                            onClick={() => void persistLinks(openCat, linksOfCategory(src, attributeId))}
                          >
                            {src.name}
                          </button>
                        ))}
                      </div>
                    ) : null}
                    <AttributeMpLinkFields
                      links={links}
                      onChange={(next) => void persistLinks(openCat, next)}
                      ozonOptions={ozonOptions}
                      wbOptions={wbOptions}
                      ymOptions={ymOptions}
                      getWbId={wbAttrKey}
                      getWbName={wbAttrName}
                    />
                  </div>
                ) : null}
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}

function AttributeForm({ attribute, attributes = [], onSubmit, onCancel }) {
  const [name, setName] = useState(attribute?.name || '');
  const [type, setType] = useState(attribute?.type || 'text');
  const [formula, setFormula] = useState(attribute?.formula || '');
  const systemLocked = isSystemPriceAttr(attribute);
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
    onSubmit({
      name: name.trim(),
      type,
      dictionary_values: type === 'dictionary' ? sortDict(dictionaryValues) : undefined,
      formula: isComputedAttrType(type) ? String(formula || '').trim() : '',
    });
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
        />
      </div>
      <div className="form-group">
        <label>Тип</label>
        <select
          value={type}
          onChange={(e) => setType(e.target.value)}
          disabled={systemLocked}
        >
          {Object.entries(TYPE_LABELS).map(([value, label]) => (
            <option key={value} value={value}>{label}</option>
          ))}
        </select>
        {systemLocked ? (
          <p className="form-hint">Системное поле карточки: тип менять нельзя, формулу и ручной ввод — можно.</p>
        ) : null}
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
              .filter((a) => String(a.id) !== String(attribute?.id || ''))
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
      {type === 'dictionary' && (
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
        <label>Сопоставления по категориям</label>
        {attribute?.id ? (
          <CategoryMpLinksPanel attributeId={attribute.id} />
        ) : (
          <p className="muted" style={{ margin: 0 }}>
            Сначала сохраните атрибут, затем снова откройте его — здесь можно выбрать категорию и задать для неё свой набор характеристик OZ / WB / ЯМ.
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
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [modalOpen, setModalOpen] = useState(false);
  const [editing, setEditing] = useState(null);

  const load = async () => {
    setLoading(true);
    setError(null);
    try {
      const attrRes = await productAttributesApi.getAll();
      setList(attrRes?.data || []);
    } catch (err) {
      setError(err?.message || 'Ошибка загрузки');
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    load();
  }, []);

  const handleCreate = () => {
    setEditing(null);
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
        Откройте атрибут кнопкой «Изменить»: название и тип — общие. Тип «Вычисляемое поле» считает значение по формуле
        (себестоимость и другие атрибуты карточки). «Цена до скидки» и «Цена после скидки» всегда есть в карточке товара.
        Сопоставление с характеристиками Ozon / WB / Яндекс.Маркета задаётся только в категории.
      </p>

      <div className="attributes-toolbar">
        <Button variant="primary" onClick={handleCreate}>➕ Добавить атрибут</Button>
      </div>

      <div className="attributes-table-wrap">
        {list.length === 0 ? (
          <div className="empty-state">
            <p>Атрибутов пока нет</p>
            <Button onClick={handleCreate}>Создать первый атрибут</Button>
          </div>
        ) : (
          <table className="attributes-table">
            <thead>
              <tr>
                <th>Название</th>
                <th>Тип</th>
                <th>Формула</th>
                <th style={{ width: 100 }}></th>
              </tr>
            </thead>
            <tbody>
              {list.map((attr) => (
                <tr key={attr.id}>
                  <td>
                    {attr.name}
                    {isSystemPriceAttr(attr) ? (
                      <span className="attr-system-badge">карточка</span>
                    ) : null}
                  </td>
                  <td>{TYPE_LABELS[attr.type] || attr.type}</td>
                  <td className="formula-cell">{isComputedAttrType(attr.type) ? (attr.formula || '—') : '—'}</td>
                  <td>
                    <Button variant="secondary" size="small" onClick={() => handleEdit(attr)}>Изменить</Button>
                    {!isSystemPriceAttr(attr) ? (
                      <Button variant="secondary" size="small" onClick={() => handleDelete(attr.id)} className="btn-delete">Удалить</Button>
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
        onClose={() => { setModalOpen(false); setEditing(null); }}
        title={editing ? 'Редактировать атрибут' : 'Добавить атрибут'}
        size="large"
        scrollable
      >
        <AttributeForm
          key={editing?.id || 'new'}
          attribute={editing}
          attributes={list}
          onSubmit={handleSubmit}
          onCancel={() => { setModalOpen(false); setEditing(null); }}
        />
      </Modal>
    </div>
  );
}
