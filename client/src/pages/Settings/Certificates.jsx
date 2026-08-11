/**
 * Certificates Page
 * Настройки → Сертификаты: реестр сертификатов/деклараций с привязкой бренд + категория.
 */

import React, { useMemo, useState, useEffect } from 'react';
import { certificatesApi } from '../../services/certificates.api';
import { useBrands } from '../../hooks/useBrands';
import { useUserCategories } from '../../hooks/useUserCategories';
import { Button } from '../../components/common/Button/Button';
import { Modal } from '../../components/common/Modal/Modal';
import { CertificatesTnVedSection } from './CertificatesTnVedSection';
import './Certificates.css';

const DOC_TYPE_LABELS = {
  certificate: 'Сертификат соответствия',
  declaration: 'Декларация',
  registration: 'Свидетельство гос. регистрации',
};

function toDateOnly(v) {
  if (!v) return '';
  const s = String(v);
  return s.includes('T') ? s.slice(0, 10) : s.slice(0, 10);
}

function daysUntil(dateStr) {
  if (!dateStr) return null;
  const d = new Date(`${toDateOnly(dateStr)}T00:00:00`);
  if (Number.isNaN(d.getTime())) return null;
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  return Math.round((d.getTime() - today.getTime()) / 86400000);
}

function emptyForm() {
  return {
    certificate_number: '',
    document_type: 'certificate',
    brand_id: '',
    user_category_ids: [],
    valid_from: '',
    valid_to: '',
  };
}

function CertificateForm({
  form,
  setForm,
  brands,
  categories,
  categorySearch,
  setCategorySearch,
  photoFile,
  setPhotoFile,
  editing,
  error,
  onSubmit,
  onCancel,
  saving,
}) {
  const selectedCategorySet = useMemo(
    () => new Set((form.user_category_ids || []).map(String)),
    [form.user_category_ids]
  );

  const filteredCategories = useMemo(() => {
    const q = String(categorySearch || '').trim().toLowerCase();
    const list = Array.isArray(categories) ? categories : [];
    if (!q) return list;
    return list.filter((c) => String(c.name || '').toLowerCase().includes(q));
  }, [categories, categorySearch]);

  const toggleCategory = (id) => {
    const sid = String(id);
    setForm((prev) => {
      const curr = new Set((prev.user_category_ids || []).map(String));
      if (curr.has(sid)) curr.delete(sid);
      else curr.add(sid);
      return { ...prev, user_category_ids: Array.from(curr) };
    });
  };

  return (
    <form onSubmit={onSubmit} className="certificate-form">
      {error && <div className="form-error">{error}</div>}

      <div className="form-row">
        <div className="form-group">
          <label>Номер <span className="req">*</span></label>
          <input
            type="text"
            value={form.certificate_number}
            onChange={(e) => setForm((p) => ({ ...p, certificate_number: e.target.value }))}
            placeholder="Номер документа"
            required
          />
        </div>
        <div className="form-group">
          <label>Тип документа</label>
          <select
            value={form.document_type}
            onChange={(e) => setForm((p) => ({ ...p, document_type: e.target.value }))}
          >
            {Object.entries(DOC_TYPE_LABELS).map(([value, label]) => (
              <option key={value} value={value}>{label}</option>
            ))}
          </select>
        </div>
      </div>

      <div className="form-group">
        <label>Бренд <span className="req">*</span></label>
        <select
          value={form.brand_id}
          onChange={(e) => setForm((p) => ({ ...p, brand_id: e.target.value }))}
          required
        >
          <option value="">Выберите бренд</option>
          {(brands || []).map((b) => (
            <option key={b.id} value={b.id}>{b.name}</option>
          ))}
        </select>
      </div>

      <div className="form-group">
        <label>Категории <span className="req">*</span></label>
        <p className="form-hint">Нужны бренд и хотя бы одна категория — вместе, не по отдельности.</p>
        <input
          type="text"
          className="category-search"
          placeholder="Поиск категории…"
          value={categorySearch}
          onChange={(e) => setCategorySearch(e.target.value)}
        />
        <div className="category-checkboxes">
          {filteredCategories.length === 0 ? (
            <div className="muted">Ничего не найдено</div>
          ) : (
            filteredCategories.map((cat) => (
              <label key={cat.id} className="checkbox-label">
                <input
                  type="checkbox"
                  checked={selectedCategorySet.has(String(cat.id))}
                  onChange={() => toggleCategory(cat.id)}
                />
                <span>{cat.name}</span>
              </label>
            ))
          )}
        </div>
        {(form.user_category_ids || []).length > 0 && (
          <div className="selected-tags">
            {(form.user_category_ids || []).map((id) => {
              const cat = (categories || []).find((c) => String(c.id) === String(id));
              return (
                <span key={String(id)} className="tag">{cat?.name || id}</span>
              );
            })}
          </div>
        )}
      </div>

      <div className="form-row">
        <div className="form-group">
          <label>Дата начала</label>
          <input
            type="date"
            value={form.valid_from}
            onChange={(e) => setForm((p) => ({ ...p, valid_from: e.target.value }))}
          />
        </div>
        <div className="form-group">
          <label>Дата окончания</label>
          <input
            type="date"
            value={form.valid_to}
            onChange={(e) => setForm((p) => ({ ...p, valid_to: e.target.value }))}
          />
        </div>
      </div>

      <div className="form-group">
        <label>Файл (фото / PDF)</label>
        <input
          type="file"
          accept="image/*,.pdf,application/pdf"
          onChange={(e) => setPhotoFile(e.target.files?.[0] || null)}
        />
        <p className="form-hint">Можно загрузить изображение или PDF (до 20 МБ).</p>
        {photoFile && (
          <p className="form-hint">Выбран файл: {photoFile.name}</p>
        )}
        {!photoFile && (editing?.photo_url || editing?.photoUrl) && (
          <p className="form-hint">
            <a href={editing.photo_url || editing.photoUrl} target="_blank" rel="noreferrer">
              Открыть текущий файл
            </a>
          </p>
        )}
      </div>

      <div className="form-actions">
        <Button type="button" variant="secondary" onClick={onCancel} disabled={saving}>Отмена</Button>
        <Button type="submit" variant="primary" disabled={saving}>
          {saving ? 'Сохранение…' : 'Сохранить'}
        </Button>
      </div>
    </form>
  );
}

export function Certificates() {
  const { brands, loading: brandsLoading } = useBrands();
  const { categories, loading: categoriesLoading } = useUserCategories();
  const [activeTab, setActiveTab] = useState('documents');
  const [list, setList] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [modalOpen, setModalOpen] = useState(false);
  const [editing, setEditing] = useState(null);
  const [form, setForm] = useState(emptyForm());
  const [formError, setFormError] = useState('');
  const [categorySearch, setCategorySearch] = useState('');
  const [photoFile, setPhotoFile] = useState(null);
  const [saving, setSaving] = useState(false);
  const [filterBrandId, setFilterBrandId] = useState('');
  const [filterDocType, setFilterDocType] = useState('');

  const brandNameById = useMemo(() => {
    const map = {};
    for (const b of brands || []) map[String(b.id)] = b.name;
    return map;
  }, [brands]);

  const load = async () => {
    setLoading(true);
    setError(null);
    try {
      const opts = {};
      if (filterBrandId) opts.brandId = filterBrandId;
      const res = await certificatesApi.getAll(opts);
      setList(res?.data || []);
    } catch (err) {
      setError(err?.message || 'Ошибка загрузки');
      setList([]);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [filterBrandId]);

  const filteredList = useMemo(() => {
    if (!filterDocType) return list;
    return list.filter((c) => String(c.document_type || 'certificate') === filterDocType);
  }, [list, filterDocType]);

  const openCreate = () => {
    setEditing(null);
    setForm(emptyForm());
    setFormError('');
    setCategorySearch('');
    setPhotoFile(null);
    setModalOpen(true);
  };

  const openEdit = (c) => {
    setEditing(c);
    setForm({
      certificate_number: c.certificate_number || '',
      document_type: c.document_type || 'certificate',
      brand_id: c.brand_id != null ? String(c.brand_id) : '',
      user_category_ids: Array.isArray(c.user_category_ids)
        ? c.user_category_ids.map(String)
        : [],
      valid_from: toDateOnly(c.valid_from),
      valid_to: toDateOnly(c.valid_to),
    });
    setFormError('');
    setCategorySearch('');
    setPhotoFile(null);
    setModalOpen(true);
  };

  const closeModal = () => {
    setModalOpen(false);
    setEditing(null);
    setForm(emptyForm());
    setFormError('');
    setCategorySearch('');
    setPhotoFile(null);
  };

  const handleSubmit = async (e) => {
    e.preventDefault();
    const number = String(form.certificate_number || '').trim();
    if (!number) {
      setFormError('Введите номер документа');
      return;
    }
    if (!form.brand_id) {
      setFormError('Выберите бренд');
      return;
    }
    const categoryIds = (form.user_category_ids || [])
      .map((x) => Number(x))
      .filter((n) => Number.isFinite(n) && n > 0);
    if (categoryIds.length === 0) {
      setFormError('Выберите хотя бы одну категорию');
      return;
    }

    setSaving(true);
    setFormError('');
    try {
      const payload = {
        certificate_number: number,
        document_type: form.document_type || 'certificate',
        brand_id: Number(form.brand_id),
        user_category_ids: categoryIds,
        valid_from: form.valid_from || null,
        valid_to: form.valid_to || null,
      };
      let saved;
      if (editing?.id) {
        saved = (await certificatesApi.update(editing.id, payload))?.data;
      } else {
        saved = (await certificatesApi.create(payload))?.data;
      }
      if (saved?.id && photoFile) {
        await certificatesApi.uploadPhoto(saved.id, photoFile);
      }
      closeModal();
      await load();
    } catch (err) {
      setFormError(err?.response?.data?.message || err?.message || 'Ошибка сохранения');
    } finally {
      setSaving(false);
    }
  };

  const handleDelete = async (id) => {
    if (!window.confirm('Удалить этот документ?')) return;
    try {
      await certificatesApi.remove(id);
      await load();
    } catch (err) {
      alert(err?.response?.data?.message || err?.message || 'Ошибка удаления');
    }
  };

  const pageLoading = loading || brandsLoading || categoriesLoading;

  if (pageLoading && list.length === 0 && activeTab === 'documents') {
    return <div className="certificates-page card"><p className="loading">Загрузка...</p></div>;
  }
  if (error && list.length === 0 && activeTab === 'documents') {
    return <div className="certificates-page card"><p className="error">Ошибка: {error}</p></div>;
  }

  return (
    <div className="certificates-page card">
      <h1 className="title">Сертификаты</h1>
      <p className="subtitle">
        Документы соответствия и коды ТН ВЭД с привязкой бренд + категория.
        В товары с этой парой подставятся данные и уйдут на маркетплейсы вместе с характеристиками.
      </p>

      <div className="certificates-tabs" role="tablist">
        <button
          type="button"
          role="tab"
          className={`certificates-tab${activeTab === 'documents' ? ' is-active' : ''}`}
          aria-selected={activeTab === 'documents'}
          onClick={() => setActiveTab('documents')}
        >
          Документы
        </button>
        <button
          type="button"
          role="tab"
          className={`certificates-tab${activeTab === 'tnved' ? ' is-active' : ''}`}
          aria-selected={activeTab === 'tnved'}
          onClick={() => setActiveTab('tnved')}
        >
          ТН ВЭД
        </button>
      </div>

      {activeTab === 'tnved' ? (
        <CertificatesTnVedSection brands={brands} categories={categories} />
      ) : (
        <>
      <div className="certificates-toolbar">
        <div className="filters">
          <select
            value={filterBrandId}
            onChange={(e) => setFilterBrandId(e.target.value)}
            aria-label="Фильтр по бренду"
          >
            <option value="">Все бренды</option>
            {(brands || []).map((b) => (
              <option key={b.id} value={b.id}>{b.name}</option>
            ))}
          </select>
          <select
            value={filterDocType}
            onChange={(e) => setFilterDocType(e.target.value)}
            aria-label="Фильтр по типу"
          >
            <option value="">Все типы</option>
            {Object.entries(DOC_TYPE_LABELS).map(([value, label]) => (
              <option key={value} value={value}>{label}</option>
            ))}
          </select>
        </div>
        <Button variant="primary" onClick={openCreate}>➕ Добавить</Button>
      </div>

      <div className="certificates-table-wrap">
        {filteredList.length === 0 ? (
          <div className="empty-state">
            <p>Документов пока нет</p>
            <Button onClick={openCreate}>Добавить первый</Button>
          </div>
        ) : (
          <table className="certificates-table">
            <thead>
              <tr>
                <th>Номер</th>
                <th>Тип</th>
                <th>Бренд</th>
                <th>Категории</th>
                <th>Начало</th>
                <th>Окончание</th>
                <th>Статус</th>
                <th style={{ width: 160 }}></th>
              </tr>
            </thead>
            <tbody>
              {filteredList.map((c) => {
                const days = daysUntil(c.valid_to);
                const expired = days != null && days < 0;
                const expSoon = days != null && days >= 0 && days <= 30;
                return (
                  <tr
                    key={c.id}
                    className={expired ? 'row-expired' : expSoon ? 'row-expiring' : undefined}
                  >
                    <td className="cell-strong">{c.certificate_number}</td>
                    <td>
                      <span className="type-badge">
                        {DOC_TYPE_LABELS[c.document_type] || DOC_TYPE_LABELS.certificate}
                      </span>
                    </td>
                    <td>{c.brand_name || brandNameById[String(c.brand_id)] || '—'}</td>
                    <td className="categories-cell">
                      {Array.isArray(c.user_categories) && c.user_categories.length > 0 ? (
                        <div className="selected-tags">
                          {c.user_categories.slice(0, 4).map((cat) => (
                            <span key={cat.id} className="tag">{cat.name}</span>
                          ))}
                          {c.user_categories.length > 4 && (
                            <span className="muted">+{c.user_categories.length - 4}</span>
                          )}
                        </div>
                      ) : (
                        '—'
                      )}
                    </td>
                    <td className="nowrap">{toDateOnly(c.valid_from) || '—'}</td>
                    <td className="nowrap">{toDateOnly(c.valid_to) || '—'}</td>
                    <td>
                      {expired ? (
                        <span className="status-expired">Истёк</span>
                      ) : expSoon ? (
                        <span className="status-expiring">Истекает через {days} дн.</span>
                      ) : (
                        <span className="muted">Ок</span>
                      )}
                    </td>
                    <td>
                      <Button variant="secondary" size="small" onClick={() => openEdit(c)}>Изменить</Button>
                      <Button
                        variant="secondary"
                        size="small"
                        className="btn-delete"
                        onClick={() => handleDelete(c.id)}
                      >
                        Удалить
                      </Button>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        )}
      </div>

      <Modal
        isOpen={modalOpen}
        onClose={closeModal}
        title={editing ? 'Редактировать документ' : 'Добавить документ'}
        size="large"
      >
        <CertificateForm
          form={form}
          setForm={setForm}
          brands={brands}
          categories={categories}
          categorySearch={categorySearch}
          setCategorySearch={setCategorySearch}
          photoFile={photoFile}
          setPhotoFile={setPhotoFile}
          editing={editing}
          error={formError}
          onSubmit={handleSubmit}
          onCancel={closeModal}
          saving={saving}
        />
      </Modal>
        </>
      )}
    </div>
  );
}
