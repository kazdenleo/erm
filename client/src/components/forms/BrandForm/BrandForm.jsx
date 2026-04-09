/**
 * BrandForm Component
 * Форма создания/редактирования бренда
 */

import React, { useEffect, useMemo, useState } from 'react';
import { Button } from '../../common/Button/Button';
import { Modal } from '../../common/Modal/Modal';
import { certificatesApi } from '../../../services/certificates.api';
import { userCategoriesApi } from '../../../services/userCategories.api';

export function BrandForm({ brand, onSubmit, onCancel }) {
  const [formData, setFormData] = useState({
    name: '',
    website: '',
    certificateNumber: '',
    certificateValidFrom: '',
    certificateValidTo: ''
  });
  
  const [errors, setErrors] = useState({});
  const [certs, setCerts] = useState([]);
  const [certsLoading, setCertsLoading] = useState(false);
  const [certsError, setCertsError] = useState('');
  const [isCertModalOpen, setIsCertModalOpen] = useState(false);
  const [editingCert, setEditingCert] = useState(null);
  const [certForm, setCertForm] = useState({
    certificate_number: '',
    document_type: 'certificate',
    user_category_ids: [],
    valid_from: '',
    valid_to: ''
  });
  const [certPhotoFile, setCertPhotoFile] = useState(null);
  const [certSaving, setCertSaving] = useState(false);
  const [allCategories, setAllCategories] = useState([]);
  const [certCategorySearch, setCertCategorySearch] = useState('');

  useEffect(() => {
    if (brand) {
      setFormData({
        name: brand.name || '',
        website: brand.website || '',
        certificateNumber: brand.certificateNumber || brand.certificate_number || '',
        certificateValidFrom: brand.certificateValidFrom || brand.certificate_valid_from || '',
        certificateValidTo: brand.certificateValidTo || brand.certificate_valid_to || ''
      });
    }
  }, [brand]);

  const loadCertificates = async () => {
    if (!brand?.id) {
      setCerts([]);
      return;
    }
    try {
      setCertsLoading(true);
      setCertsError('');
      const res = await certificatesApi.getAll({ brandId: brand.id });
      setCerts(res?.data || []);
    } catch (e) {
      setCertsError(e?.message || 'Ошибка загрузки сертификатов бренда');
      setCerts([]);
    } finally {
      setCertsLoading(false);
    }
  };

  useEffect(() => {
    loadCertificates();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [brand?.id]);

  useEffect(() => {
    let cancelled = false;
    const loadCategories = async () => {
      try {
        const res = await userCategoriesApi.getAll();
        if (cancelled) return;
        const data = res?.data?.data || res?.data || [];
        setAllCategories(Array.isArray(data) ? data : []);
      } catch (_) {
        if (!cancelled) setAllCategories([]);
      }
    };
    loadCategories();
    return () => { cancelled = true; };
  }, []);

  const handleChange = (field, value) => {
    setFormData(prev => ({ ...prev, [field]: value }));
    if (errors[field]) {
      setErrors(prev => {
        const newErrors = { ...prev };
        delete newErrors[field];
        return newErrors;
      });
    }
  };

  const validate = () => {
    const newErrors = {};
    
    if (!formData.name || !formData.name.trim()) {
      newErrors.name = 'Введите название бренда';
    }
    
    if (formData.website && formData.website.trim() && !isValidUrl(formData.website.trim())) {
      newErrors.website = 'Введите корректный URL';
    }
    
    setErrors(newErrors);
    return Object.keys(newErrors).length === 0;
  };

  const isValidUrl = (string) => {
    try {
      new URL(string);
      return true;
    } catch (_) {
      return false;
    }
  };

  const handleSubmit = () => {
    if (!validate()) {
      return;
    }

    const payload = {
      name: formData.name.trim(),
      website: formData.website.trim() || null,
      certificateNumber: formData.certificateNumber.trim() || null,
      certificateValidFrom: formData.certificateValidFrom || null,
      certificateValidTo: formData.certificateValidTo || null
    };

    onSubmit(payload);
  };

  const toDateOnly = (v) => {
    if (!v) return '';
    const s = String(v);
    return s.includes('T') ? s.slice(0, 10) : s.slice(0, 10);
  };

  const daysUntil = (dateStr) => {
    if (!dateStr) return null;
    const d = new Date(`${dateStr}T00:00:00`);
    if (Number.isNaN(d.getTime())) return null;
    const now = new Date();
    const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
    return Math.floor((d.getTime() - today.getTime()) / (24 * 60 * 60 * 1000));
  };

  const certRows = useMemo(() => {
    const list = Array.isArray(certs) ? certs : [];
    return list.map((c) => {
      const to = toDateOnly(c.valid_to);
      const left = daysUntil(to);
      return {
        c,
        validTo: to,
        daysLeft: left,
        expired: left != null ? left < 0 : false,
        expSoon: left != null ? left >= 0 && left <= 10 : false
      };
    });
  }, [certs]);

  const filteredCategoryOptions = useMemo(() => {
    const q = String(certCategorySearch || '').trim().toLowerCase();
    if (!q) return allCategories;
    return allCategories.filter((cat) => String(cat?.name || '').toLowerCase().includes(q));
  }, [allCategories, certCategorySearch]);

  const selectedCategorySet = useMemo(() => new Set((certForm.user_category_ids || []).map(String)), [certForm.user_category_ids]);

  const toggleCategory = (id) => {
    const sid = String(id);
    setCertForm((prev) => {
      const curr = new Set((prev.user_category_ids || []).map(String));
      if (curr.has(sid)) curr.delete(sid);
      else curr.add(sid);
      return { ...prev, user_category_ids: Array.from(curr) };
    });
  };

  const getDocTypeLabel = (v) => (
    v === 'declaration'
      ? 'Декларация'
      : v === 'registration'
        ? 'Свидетельство гос. регистрации'
        : 'Сертификат соответствия'
  );

  const openCertCreate = () => {
    setEditingCert(null);
    setCertPhotoFile(null);
    setCertForm({ certificate_number: '', document_type: 'certificate', user_category_ids: [], valid_from: '', valid_to: '' });
    setIsCertModalOpen(true);
  };

  const openCertEdit = (c) => {
    setEditingCert(c);
    setCertPhotoFile(null);
    setCertForm({
      certificate_number: c.certificate_number || '',
      document_type: c.document_type || 'certificate',
      user_category_ids: Array.isArray(c.user_category_ids) ? c.user_category_ids.map((x) => String(x)) : [],
      valid_from: toDateOnly(c.valid_from),
      valid_to: toDateOnly(c.valid_to),
    });
    setIsCertModalOpen(true);
  };

  const closeCertModal = () => {
    setIsCertModalOpen(false);
    setEditingCert(null);
    setCertPhotoFile(null);
    setCertForm({ certificate_number: '', document_type: 'certificate', user_category_ids: [], valid_from: '', valid_to: '' });
    setCertCategorySearch('');
  };

  const saveCert = async (e) => {
    e.preventDefault();
    if (!brand?.id) return;
    setCertSaving(true);
    try {
      const payload = {
        certificate_number: String(certForm.certificate_number || '').trim(),
        document_type: certForm.document_type || 'certificate',
        brand_id: brand.id,
        user_category_ids: (certForm.user_category_ids || []).map((x) => Number(x)).filter((n) => Number.isFinite(n) && n > 0),
        valid_from: certForm.valid_from || null,
        valid_to: certForm.valid_to || null,
      };
      let saved;
      if (editingCert?.id) {
        saved = (await certificatesApi.update(editingCert.id, payload))?.data;
      } else {
        saved = (await certificatesApi.create(payload))?.data;
      }
      if (saved?.id && certPhotoFile) {
        await certificatesApi.uploadPhoto(saved.id, certPhotoFile);
      }
      await loadCertificates();
      closeCertModal();
    } catch (err) {
      alert(err?.message || 'Ошибка сохранения сертификата');
    } finally {
      setCertSaving(false);
    }
  };

  const deleteCert = async (id) => {
    if (!window.confirm('Удалить сертификат бренда?')) return;
    try {
      await certificatesApi.remove(id);
      await loadCertificates();
    } catch (e) {
      alert(e?.message || 'Ошибка удаления сертификата');
    }
  };

  return (
    <div className="brand-form">
      <div className="row g-3">
      <div className="col-md-8">
        <label className="form-label" htmlFor="brandName">
          Название бренда <span style={{color: '#ef4444'}}>*</span>
        </label>
        <input
          id="brandName"
          type="text"
          className="form-control form-control-sm"
          placeholder="Например: Apple, Samsung, Nike"
          value={formData.name}
          onChange={(e) => handleChange('name', e.target.value)}
          required
        />
        {errors.name && <div className="error">{errors.name}</div>}
      </div>

      <div className="col-md-6">
        <label className="form-label" htmlFor="brandWebsite">Веб-сайт</label>
        <input
          id="brandWebsite"
          type="url"
          className="form-control form-control-sm"
          placeholder="https://example.com"
          value={formData.website}
          onChange={(e) => handleChange('website', e.target.value)}
        />
        {errors.website && <div className="error">{errors.website}</div>}
      </div>

      <div className="col-12" style={{ marginTop: '6px' }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', gap: '10px', flexWrap: 'wrap', alignItems: 'center' }}>
          <div style={{ fontWeight: 600, fontSize: '13px' }}>Сертификаты бренда</div>
          <div style={{ display: 'flex', gap: '8px' }}>
            <Button type="button" variant="secondary" onClick={loadCertificates} disabled={certsLoading || !brand?.id}>
              {certsLoading ? 'Загрузка…' : 'Обновить'}
            </Button>
            <Button type="button" variant="primary" onClick={openCertCreate} disabled={!brand?.id}>
              Добавить сертификат
            </Button>
          </div>
        </div>

        {!brand?.id && (
          <div style={{ fontSize: '12px', color: 'var(--muted)', marginTop: '6px' }}>
            Сначала сохраните бренд — затем можно будет добавлять сертификаты.
          </div>
        )}

        {certsError && (
          <div className="error" style={{ marginTop: '8px' }}>{certsError}</div>
        )}

        {brand?.id && !certsLoading && certRows.length === 0 ? (
          <div style={{ fontSize: '12px', color: 'var(--muted)', marginTop: '8px' }}>Сертификатов нет.</div>
        ) : null}

        {brand?.id && certRows.length > 0 && (
          <div style={{ marginTop: '10px', border: '1px solid var(--border)', borderRadius: '10px', overflow: 'hidden' }}>
          <table className="table" style={{ width: '100%', margin: 0 }}>
            <thead>
              <tr>
                <th>Номер</th>
                <th>Тип документа</th>
                <th>Категории</th>
                <th>Начало</th>
                <th>Окончание</th>
                <th>Статус</th>
                <th style={{ width: 180 }}>Действия</th>
              </tr>
            </thead>
            <tbody>
              {certRows.map(({ c, expired, expSoon, daysLeft }) => (
                <tr
                  key={c.id}
                  style={{
                    background: expired
                      ? 'rgba(239, 68, 68, 0.06)'
                      : expSoon
                        ? 'rgba(245, 158, 11, 0.08)'
                        : undefined
                  }}
                >
                  <td style={{ fontWeight: 600 }}>{c.certificate_number}</td>
                  <td style={{ whiteSpace: 'nowrap' }}>
                    <span style={{ padding: '3px 8px', borderRadius: '999px', background: 'rgba(59,130,246,.08)', fontSize: '12px' }}>
                      {getDocTypeLabel(c.document_type)}
                    </span>
                  </td>
                  <td style={{ fontSize: '12px', maxWidth: '260px' }}>
                    {Array.isArray(c.user_categories) && c.user_categories.length > 0 ? (
                      <div style={{ display: 'flex', gap: '4px', flexWrap: 'wrap' }}>
                        {c.user_categories.slice(0, 3).map((cat) => (
                          <span key={cat.id} style={{ border: '1px solid var(--border)', borderRadius: '999px', padding: '2px 8px', fontSize: '11px' }}>
                            {cat.name}
                          </span>
                        ))}
                        {c.user_categories.length > 3 && (
                          <span style={{ color: 'var(--muted)', fontSize: '11px' }}>+{c.user_categories.length - 3}</span>
                        )}
                      </div>
                    ) : (
                      '—'
                    )}
                  </td>
                  <td style={{ whiteSpace: 'nowrap' }}>{toDateOnly(c.valid_from) || '—'}</td>
                  <td style={{ whiteSpace: 'nowrap' }}>{toDateOnly(c.valid_to) || '—'}</td>
                  <td style={{ fontSize: '12px' }}>
                    {expired ? (
                      <span style={{ color: '#ef4444', fontWeight: 600 }}>Истёк</span>
                    ) : expSoon ? (
                      <span style={{ color: '#b45309', fontWeight: 600 }}>Истекает через {daysLeft} дн.</span>
                    ) : (
                      <span style={{ color: 'var(--muted)' }}>Ок</span>
                    )}
                  </td>
                  <td>
                    <div style={{ display: 'flex', gap: '8px', flexWrap: 'wrap' }}>
                      <Button type="button" variant="secondary" onClick={() => openCertEdit(c)} style={{ minWidth: '40px' }}>✏️</Button>
                      <Button type="button" variant="secondary" onClick={() => deleteCert(c.id)} style={{ color: '#fca5a5', borderColor: '#fca5a5', minWidth: '40px' }}>🗑️</Button>
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          </div>
        )}
      </div>

      {Object.keys(errors).length > 0 && (
        <div className="error" style={{marginTop: '12px'}}>
          {Object.values(errors)[0]}
        </div>
      )}
      </div>

      <div className="d-flex justify-content-end gap-2 mt-4">
        <Button type="button" variant="secondary" onClick={onCancel}>Отмена</Button>
        <Button type="button" variant="primary" onClick={handleSubmit}>{brand ? 'Сохранить' : 'Добавить бренд'}</Button>
      </div>

      <Modal
        isOpen={isCertModalOpen}
        onClose={closeCertModal}
        title={editingCert ? 'Редактировать сертификат' : 'Добавить сертификат'}
        size="large"
      >
        <form onSubmit={saveCert}>
          <div className="row g-3">
            <div className="col-md-6">
              <label className="form-label">Номер <span style={{ color: '#ef4444' }}>*</span></label>
              <input
                className="form-control form-control-sm"
                value={certForm.certificate_number}
                onChange={(e) => setCertForm((p) => ({ ...p, certificate_number: e.target.value }))}
                required
              />
            </div>
            <div className="col-md-6">
              <label className="form-label">Тип документа</label>
              <select
                className="form-control form-control-sm"
                value={certForm.document_type}
                onChange={(e) => setCertForm((p) => ({ ...p, document_type: e.target.value }))}
              >
                <option value="certificate">Сертификат соответствия</option>
                <option value="declaration">Декларация</option>
                <option value="registration">Свидетельство гос. регистрации</option>
              </select>
            </div>
            <div className="col-12">
              <label className="form-label">Категории товаров</label>
              <input
                className="form-control form-control-sm"
                placeholder="Поиск категории..."
                value={certCategorySearch}
                onChange={(e) => setCertCategorySearch(e.target.value)}
                style={{ marginBottom: '8px' }}
              />
              <div style={{ border: '1px solid var(--border)', borderRadius: '8px', maxHeight: '180px', overflowY: 'auto', padding: '8px' }}>
                {filteredCategoryOptions.length === 0 ? (
                  <div style={{ fontSize: '12px', color: 'var(--muted)' }}>Ничего не найдено</div>
                ) : (
                  filteredCategoryOptions.map((cat) => (
                    <label key={cat.id} style={{ display: 'flex', alignItems: 'center', gap: '8px', marginBottom: '6px', cursor: 'pointer' }}>
                      <input
                        type="checkbox"
                        checked={selectedCategorySet.has(String(cat.id))}
                        onChange={() => toggleCategory(cat.id)}
                      />
                      <span style={{ fontSize: '13px' }}>{cat.name}</span>
                    </label>
                  ))
                )}
              </div>
              {(certForm.user_category_ids || []).length > 0 && (
                <div style={{ display: 'flex', flexWrap: 'wrap', gap: '6px', marginTop: '8px' }}>
                  {(certForm.user_category_ids || []).map((id) => {
                    const cat = allCategories.find((c) => String(c.id) === String(id));
                    return (
                      <span key={String(id)} style={{ border: '1px solid var(--border)', borderRadius: '999px', padding: '2px 8px', fontSize: '11px' }}>
                        {cat?.name || id}
                      </span>
                    );
                  })}
                </div>
              )}
            </div>
            <div className="col-md-6">
              <label className="form-label">Фото</label>
              <input
                className="form-control form-control-sm"
                type="file"
                accept="image/*"
                onChange={(e) => setCertPhotoFile(e.target.files?.[0] || null)}
              />
              {(editingCert?.photo_url || editingCert?.photoUrl) && (
                <div style={{ marginTop: '8px' }}>
                  <a href={editingCert.photo_url || editingCert.photoUrl} target="_blank" rel="noreferrer" style={{ fontSize: '12px' }}>
                    Открыть текущее фото
                  </a>
                </div>
              )}
            </div>
            <div className="col-md-6">
              <label className="form-label">Дата начала</label>
              <input
                type="date"
                className="form-control form-control-sm"
                value={certForm.valid_from}
                onChange={(e) => setCertForm((p) => ({ ...p, valid_from: e.target.value }))}
              />
            </div>
            <div className="col-md-6">
              <label className="form-label">Дата окончания</label>
              <input
                type="date"
                className="form-control form-control-sm"
                value={certForm.valid_to}
                onChange={(e) => setCertForm((p) => ({ ...p, valid_to: e.target.value }))}
              />
            </div>
          </div>

          <div className="d-flex justify-content-end gap-2 mt-4">
            <Button type="button" variant="secondary" onClick={closeCertModal} disabled={certSaving}>Отмена</Button>
            <Button type="submit" variant="primary" disabled={certSaving}>
              {certSaving ? 'Сохранение…' : 'Сохранить'}
            </Button>
          </div>
        </form>
      </Modal>
    </div>
  );
}

