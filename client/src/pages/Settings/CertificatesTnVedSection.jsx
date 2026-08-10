/**
 * Секция ТН ВЭД на странице Настройки → Сертификаты
 */

import React, { useEffect, useMemo, useState } from 'react';
import { tnVedApi } from '../../services/tnVed.api';
import { Button } from '../../components/common/Button/Button';
import { Modal } from '../../components/common/Modal/Modal';

function emptyTnVedForm() {
  return {
    tn_ved_code: '',
    brand_id: '',
    user_category_ids: [],
  };
}

function TnVedCodePicker({ value, onChange, error }) {
  const [query, setQuery] = useState('');
  const [options, setOptions] = useState([]);
  const [loading, setLoading] = useState(false);
  const [open, setOpen] = useState(false);

  useEffect(() => {
    let cancelled = false;
    const t = setTimeout(async () => {
      setLoading(true);
      try {
        const res = await tnVedApi.searchCodes({ q: query, limit: 40 });
        if (!cancelled) setOptions(res?.data || []);
      } catch {
        if (!cancelled) setOptions([]);
      } finally {
        if (!cancelled) setLoading(false);
      }
    }, 200);
    return () => {
      cancelled = true;
      clearTimeout(t);
    };
  }, [query]);

  const selectedLabel = useMemo(() => {
    if (!value) return '';
    const hit = options.find((o) => o.code === value);
    return hit ? `${hit.code} — ${hit.name}` : value;
  }, [value, options]);

  return (
    <div className="form-group tnved-picker">
      <label>Код ТН ВЭД <span className="req">*</span></label>
      <p className="form-hint">Выберите код из справочника ТН ВЭД ЕАЭС (поиск по коду или названию).</p>
      {value && (
        <div className="tnved-selected">
          <span>{selectedLabel || value}</span>
          <button type="button" className="tnved-clear" onClick={() => onChange('')} aria-label="Сбросить">×</button>
        </div>
      )}
      <input
        type="text"
        className="category-search"
        placeholder="Поиск: 8708 или «амортизатор»…"
        value={query}
        onChange={(e) => {
          setQuery(e.target.value);
          setOpen(true);
        }}
        onFocus={() => setOpen(true)}
      />
      {open && (
        <div className="tnved-options">
          {loading ? (
            <div className="muted">Поиск…</div>
          ) : options.length === 0 ? (
            <div className="muted">Ничего не найдено</div>
          ) : (
            options.map((row) => (
              <button
                key={row.code}
                type="button"
                className={`tnved-option${value === row.code ? ' is-active' : ''}`}
                onClick={() => {
                  onChange(row.code);
                  setQuery('');
                  setOpen(false);
                }}
              >
                <strong>{row.code}</strong>
                <span>{row.name}</span>
              </button>
            ))
          )}
        </div>
      )}
      {error && <div className="form-error">{error}</div>}
    </div>
  );
}

export function CertificatesTnVedSection({ brands, categories }) {
  const [list, setList] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [filterBrandId, setFilterBrandId] = useState('');
  const [modalOpen, setModalOpen] = useState(false);
  const [editing, setEditing] = useState(null);
  const [form, setForm] = useState(emptyTnVedForm());
  const [formError, setFormError] = useState('');
  const [categorySearch, setCategorySearch] = useState('');
  const [saving, setSaving] = useState(false);

  const brandNameById = useMemo(() => {
    const map = {};
    for (const b of brands || []) map[String(b.id)] = b.name;
    return map;
  }, [brands]);

  const selectedCategorySet = useMemo(
    () => new Set((form.user_category_ids || []).map(String)),
    [form.user_category_ids]
  );

  const filteredCategories = useMemo(() => {
    const q = String(categorySearch || '').trim().toLowerCase();
    const listCats = Array.isArray(categories) ? categories : [];
    if (!q) return listCats;
    return listCats.filter((c) => String(c.name || '').toLowerCase().includes(q));
  }, [categories, categorySearch]);

  const load = async () => {
    setLoading(true);
    setError(null);
    try {
      const opts = {};
      if (filterBrandId) opts.brandId = filterBrandId;
      const res = await tnVedApi.getBindings(opts);
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

  const toggleCategory = (id) => {
    const sid = String(id);
    setForm((prev) => {
      const curr = new Set((prev.user_category_ids || []).map(String));
      if (curr.has(sid)) curr.delete(sid);
      else curr.add(sid);
      return { ...prev, user_category_ids: Array.from(curr) };
    });
  };

  const openCreate = () => {
    setEditing(null);
    setForm(emptyTnVedForm());
    setFormError('');
    setCategorySearch('');
    setModalOpen(true);
  };

  const openEdit = (row) => {
    setEditing(row);
    setForm({
      tn_ved_code: row.tn_ved_code || '',
      brand_id: row.brand_id != null ? String(row.brand_id) : '',
      user_category_ids: Array.isArray(row.user_category_ids) ? row.user_category_ids.map(String) : [],
    });
    setFormError('');
    setCategorySearch('');
    setModalOpen(true);
  };

  const closeModal = () => {
    setModalOpen(false);
    setEditing(null);
    setForm(emptyTnVedForm());
    setFormError('');
    setCategorySearch('');
  };

  const handleSubmit = async (e) => {
    e.preventDefault();
    if (!form.tn_ved_code) {
      setFormError('Выберите код ТН ВЭД из списка');
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
        tn_ved_code: form.tn_ved_code,
        brand_id: Number(form.brand_id),
        user_category_ids: categoryIds,
      };
      if (editing?.id) {
        await tnVedApi.updateBinding(editing.id, payload);
      } else {
        await tnVedApi.createBinding(payload);
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
    if (!window.confirm('Удалить привязку ТН ВЭД?')) return;
    try {
      await tnVedApi.removeBinding(id);
      await load();
    } catch (err) {
      alert(err?.response?.data?.message || err?.message || 'Ошибка удаления');
    }
  };

  if (loading && list.length === 0) {
    return <p className="loading">Загрузка…</p>;
  }
  if (error && list.length === 0) {
    return <p className="error">Ошибка: {error}</p>;
  }

  return (
    <div className="tnved-section">
      <p className="subtitle">
        Код ТН ВЭД выбирается из справочника. Привязка только бренд + категория:
        в карточках товаров с этой парой код подставится в характеристики и уйдёт на маркетплейсы.
      </p>

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
        </div>
        <Button variant="primary" onClick={openCreate}>➕ Добавить ТН ВЭД</Button>
      </div>

      <div className="certificates-table-wrap">
        {list.length === 0 ? (
          <div className="empty-state">
            <p>Привязок ТН ВЭД пока нет</p>
            <Button onClick={openCreate}>Добавить первую</Button>
          </div>
        ) : (
          <table className="certificates-table">
            <thead>
              <tr>
                <th>Код ТН ВЭД</th>
                <th>Бренд</th>
                <th>Категории</th>
                <th style={{ width: 160 }}></th>
              </tr>
            </thead>
            <tbody>
              {list.map((row) => (
                <tr key={row.id}>
                  <td className="cell-strong">{row.tn_ved_code}</td>
                  <td>{row.brand_name || brandNameById[String(row.brand_id)] || '—'}</td>
                  <td className="categories-cell">
                    {Array.isArray(row.user_categories) && row.user_categories.length > 0 ? (
                      <div className="selected-tags">
                        {row.user_categories.slice(0, 4).map((cat) => (
                          <span key={cat.id} className="tag">{cat.name}</span>
                        ))}
                        {row.user_categories.length > 4 && (
                          <span className="muted">+{row.user_categories.length - 4}</span>
                        )}
                      </div>
                    ) : (
                      '—'
                    )}
                  </td>
                  <td>
                    <Button variant="secondary" size="small" onClick={() => openEdit(row)}>Изменить</Button>
                    <Button
                      variant="secondary"
                      size="small"
                      className="btn-delete"
                      onClick={() => handleDelete(row.id)}
                    >
                      Удалить
                    </Button>
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
        title={editing ? 'Редактировать ТН ВЭД' : 'Добавить ТН ВЭД'}
        size="large"
      >
        <form onSubmit={handleSubmit} className="certificate-form">
          {formError && <div className="form-error">{formError}</div>}

          <TnVedCodePicker
            value={form.tn_ved_code}
            onChange={(code) => setForm((p) => ({ ...p, tn_ved_code: code }))}
          />

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
                  return <span key={String(id)} className="tag">{cat?.name || id}</span>;
                })}
              </div>
            )}
          </div>

          <div className="form-actions">
            <Button type="button" variant="secondary" onClick={closeModal} disabled={saving}>Отмена</Button>
            <Button type="submit" variant="primary" disabled={saving}>
              {saving ? 'Сохранение…' : 'Сохранить'}
            </Button>
          </div>
        </form>
      </Modal>
    </div>
  );
}
