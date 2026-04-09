/**
 * Attributes Page
 * Атрибуты товаров: создание и типы. Привязка атрибутов к категориям — в форме категории.
 */

import React, { useState, useEffect } from 'react';
import { productAttributesApi } from '../../services/productAttributes.api';
import { Button } from '../../components/common/Button/Button';
import { Modal } from '../../components/common/Modal/Modal';
import './Attributes.css';

const TYPE_LABELS = {
  text: 'Текст',
  checkbox: 'Флажок',
  number: 'Число',
  date: 'Дата',
  dictionary: 'Словарь'
};

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
      dictionary_values: type === 'dictionary' ? sortDict(dictionaryValues) : undefined
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
      <p className="subtitle">Создание атрибутов для товаров. Привязка атрибутов к категориям — в разделе «Категории». Типы: Текст, Флажок, Число, Дата, Словарь.</p>

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
        size="medium"
      >
        <AttributeForm
          attribute={editing}
          onSubmit={handleSubmit}
          onCancel={() => { setModalOpen(false); setEditing(null); }}
        />
      </Modal>
    </div>
  );
}
