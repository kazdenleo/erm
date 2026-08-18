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
import './Attributes.css';

const TYPE_LABELS = {
  text: 'Текст',
  checkbox: 'Флажок',
  number: 'Число',
  date: 'Дата',
  dictionary: 'Словарь'
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

function CategoryMpLinksPanel({ attributeId }) {
  const [categories, setCategories] = useState([]);
  const [openCatId, setOpenCatId] = useState('');
  const [links, setLinks] = useState(() => emptyAttrMpLinks());
  const [ozonOptions, setOzonOptions] = useState([]);
  const [wbOptions, setWbOptions] = useState([]);
  const [ymOptions, setYmOptions] = useState([]);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    userCategoriesApi
      .getAll()
      .then((res) => {
        if (cancelled) return;
        const list = Array.isArray(res?.data) ? res.data : [];
        const linked = list.filter((c) =>
          (c.attribute_ids || []).map((id) => String(id)).includes(String(attributeId))
        );
        setCategories(linked);
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
    let cancelled = false;
    Promise.all([
      userCategoriesApi.getMarketplaceAttributes(cat.id, 'ozon').catch(() => null),
      userCategoriesApi.getMarketplaceAttributes(cat.id, 'wb').catch(() => null),
      userCategoriesApi.getMarketplaceAttributes(cat.id, 'ym').catch(() => null),
    ]).then(([oz, wb, ym]) => {
      if (cancelled) return;
      setOzonOptions(mpAttrsFromResponse(oz));
      setWbOptions(mpAttrsFromResponse(wb));
      setYmOptions(mpAttrsFromResponse(ym));
    });
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [openCatId, attributeId]);

  const persistLinks = async (cat, next) => {
    setSaving(true);
    try {
      await userCategoriesApi.updateAttributeMpLinks(cat.id, attributeId, next);
      setCategories((prev) =>
        prev.map((c) =>
          String(c.id) === String(cat.id)
            ? {
                ...c,
                attribute_mp_links: {
                  ...(c.attribute_mp_links || {}),
                  [String(attributeId)]: next,
                },
              }
            : c
        )
      );
      if (String(cat.id) === String(openCatId)) setLinks(next);
    } catch (err) {
      alert(err?.response?.data?.message || err?.response?.data?.error || 'Не удалось сохранить связь');
    } finally {
      setSaving(false);
    }
  };

  const copySources = categories.filter(
    (c) => String(c.id) !== String(openCatId) && attrMpLinksHasAny(linksOfCategory(c, attributeId))
  );

  if (loading) {
    return <p className="muted" style={{ margin: 0 }}>Загрузка категорий…</p>;
  }
  if (!categories.length) {
    return (
      <p className="muted" style={{ margin: 0 }}>
        Этот атрибут ещё не добавлен ни в одну категорию. Добавьте его в
        {' '}<strong>Настройки → Категории</strong> (карандаш у категории), затем вернитесь сюда.
      </p>
    );
  }

  return (
    <div className="attribute-category-mp-links">
      <p className="muted" style={{ margin: '0 0 10px' }}>
        Связи хранятся отдельно для каждой категории и не затирают друг друга.
        {saving ? ' Сохранение…' : ' Изменения сохраняются сразу.'}
      </p>
      <div className="attribute-cat-mp-list">
        {categories.map((c) => {
          const isOpen = String(c.id) === String(openCatId);
          const summary = formatAttrMpLinksSummary(linksOfCategory(c, attributeId));
          return (
            <div key={c.id} className={`attribute-cat-mp-card${isOpen ? ' is-open' : ''}`}>
              <button
                type="button"
                className="attribute-cat-mp-card__head"
                onClick={() => setOpenCatId(String(c.id))}
              >
                <span className="attribute-cat-mp-card__name">{c.name}</span>
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
    </div>
  );
}

function AttributeForm({ attribute, onSubmit, onCancel }) {
  const [name, setName] = useState(attribute?.name || '');
  const [type, setType] = useState(attribute?.type || 'text');
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

  const handleSubmit = (e) => {
    e.preventDefault();
    if (!name.trim()) {
      setError('Введите название атрибута');
      return;
    }
    setError('');
    onSubmit({
      name: name.trim(),
      type,
      dictionary_values: type === 'dictionary' ? sortDict(dictionaryValues) : undefined,
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
        <select value={type} onChange={(e) => setType(e.target.value)}>
          {Object.entries(TYPE_LABELS).map(([value, label]) => (
            <option key={value} value={value}>{label}</option>
          ))}
        </select>
      </div>
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
        <label>Связь с маркетплейсами по категориям</label>
        {attribute?.id ? (
          <CategoryMpLinksPanel attributeId={attribute.id} />
        ) : (
          <p className="muted" style={{ margin: 0 }}>
            Сначала сохраните атрибут, затем снова откройте его — здесь появятся категории и выбор характеристик OZ / WB / ЯМ.
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
        Откройте атрибут кнопкой «Изменить» — связи с Ozon / Wildberries / Яндекс.Маркетом задаются отдельно для каждой категории и сохраняются в базе.
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
                <th style={{ width: 100 }}></th>
              </tr>
            </thead>
            <tbody>
              {list.map((attr) => (
                <tr key={attr.id}>
                  <td>{attr.name}</td>
                  <td>{TYPE_LABELS[attr.type] || attr.type}</td>
                  <td>
                    <Button variant="secondary" size="small" onClick={() => handleEdit(attr)}>Изменить</Button>
                    <Button variant="secondary" size="small" onClick={() => handleDelete(attr.id)} className="btn-delete">Удалить</Button>
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
          onSubmit={handleSubmit}
          onCancel={() => { setModalOpen(false); setEditing(null); }}
        />
      </Modal>
    </div>
  );
}
