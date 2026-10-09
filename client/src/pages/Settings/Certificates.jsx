/**
 * Certificates Page
 * Настройки → Сертификаты: реестр сертификатов/деклараций с привязкой бренд + категория.
 * Отправка в раздел «Сертификаты» кабинета Ozon (Certification API).
 */

import React, { useMemo, useState, useEffect } from 'react';
import { certificatesApi } from '../../services/certificates.api';
import { useBrands } from '../../hooks/useBrands';
import { useUserCategories } from '../../hooks/useUserCategories';
import { Button } from '../../components/common/Button/Button';
import { Modal } from '../../components/common/Modal/Modal';
import { CertificateBindingReport } from './CertificateBindingReport';
import './Certificates.css';

const DOC_TYPE_LABELS = {
  certificate: 'Сертификат соответствия',
  declaration: 'Декларация',
  registration: 'Свидетельство гос. регистрации',
};

const OZON_STATUS_LABELS = {
  approved: 'Одобрен на Ozon',
  declined: 'Отклонён на Ozon',
  rejected: 'Отклонён на Ozon',
  verification: 'На проверке',
  awaiting_verification: 'Ожидает проверки',
  pending: 'Ожидает проверки',
  awaiting_moderation: 'Ожидает проверки',
  on_moderation: 'На проверке',
};

const YM_STATUS_LABELS = {
  ACTIVE: 'Действует на YM',
  VALIDATING: 'Проверяется на YM',
  WAITING_FIXES: 'Ждёт исправлений',
  NOT_FOUND: 'Не найден в реестре',
  EXPIRED: 'Истёк на YM',
  REVOKED: 'Отозван на YM',
};

const OZON_FINAL_STATUSES = ['approved', 'declined', 'rejected'];
const YM_PENDING_STATUSES = ['VALIDATING', 'WAITING_FIXES'];

function StatusRefreshButton({ busy, onClick }) {
  return (
    <button
      type="button"
      className={`status-refresh-btn${busy ? ' is-busy' : ''}`}
      onClick={onClick}
      disabled={busy}
      title="Обновить статус проверки (автоматически — раз в час)"
      aria-label="Обновить статус проверки"
    >
      ↻
    </button>
  );
}

const YM_DOC_TYPE_DEFAULTS = [
  { code: 'CONFORMITY_CERTIFICATE', label: 'Сертификат соответствия' },
  { code: 'CONFORMITY_DECLARATION', label: 'Декларация о соответствии' },
  { code: 'STATE_REGISTRATION_CERTIFICATE', label: 'Свидетельство гос. регистрации' },
];

/** «Категория[, категория] Бренд» — название документа в кабинете маркетплейса (Ozon: до 100 символов). */
function defaultMarketplaceCertificateName(c, brandNameById = {}) {
  const categories = (Array.isArray(c?.user_categories) ? c.user_categories : [])
    .map((cat) => String(cat?.name || '').trim())
    .filter(Boolean)
    .join(', ');
  const brand = String(c?.brand_name || brandNameById[String(c?.brand_id)] || '').trim();
  return [categories, brand].filter(Boolean).join(' ').slice(0, 100);
}

function defaultYmDocType(documentType) {
  if (documentType === 'declaration') return 'CONFORMITY_DECLARATION';
  if (documentType === 'registration') return 'STATE_REGISTRATION_CERTIFICATE';
  return 'CONFORMITY_CERTIFICATE';
}

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
  const [ozonModalCert, setOzonModalCert] = useState(null);
  const [ozonAccordanceTypes, setOzonAccordanceTypes] = useState([]);
  const [ozonForm, setOzonForm] = useState({
    name: '',
    accordanceTypeCode: 'technical_regulations_cu',
    bindProducts: true,
    forceCreate: false,
  });
  const [ozonBusy, setOzonBusy] = useState(false);
  const [ozonError, setOzonError] = useState('');
  const [ozonResult, setOzonResult] = useState(null);
  const [ymModalCert, setYmModalCert] = useState(null);
  const [ymDocumentTypes, setYmDocumentTypes] = useState([]);
  const [ymForm, setYmForm] = useState({
    documentType: 'CONFORMITY_CERTIFICATE',
    bindProducts: true,
    forceCreate: false,
  });
  const [ymBusy, setYmBusy] = useState(false);
  const [ymError, setYmError] = useState('');
  const [ymResult, setYmResult] = useState(null);
  const [bindingCert, setBindingCert] = useState(null);
  const [bindingData, setBindingData] = useState(null);
  const [bindingBusy, setBindingBusy] = useState(false);
  const [bindingError, setBindingError] = useState('');
  const [rebindBusy, setRebindBusy] = useState(false);
  const [statusSyncingId, setStatusSyncingId] = useState(null);
  const [importBusy, setImportBusy] = useState(false);
  const [importMessage, setImportMessage] = useState(null);
  const [deleteModalCert, setDeleteModalCert] = useState(null);
  const [deleteForm, setDeleteForm] = useState({ deleteOzon: true, deleteYm: true });
  const [deleteBusy, setDeleteBusy] = useState(false);
  const [deleteError, setDeleteError] = useState('');
  const [statusSyncError, setStatusSyncError] = useState('');

  const brandNameById = useMemo(() => {
    const map = {};
    for (const b of brands || []) map[String(b.id)] = b.name;
    return map;
  }, [brands]);

  const load = async ({ silent = false } = {}) => {
    if (!silent) setLoading(true);
    setError(null);
    try {
      const opts = {};
      if (filterBrandId) opts.brandId = filterBrandId;
      const res = await certificatesApi.getAll(opts);
      const rows = res?.data || [];
      setList(rows);
      return rows;
    } catch (err) {
      setError(err?.message || 'Ошибка загрузки');
      if (!silent) setList([]);
      return null;
    } finally {
      if (!silent) setLoading(false);
    }
  };

  const syncErrorsText = (data) =>
    [data?.ozon?.error && `Ozon: ${data.ozon.error}`, data?.ym?.error && `Яндекс: ${data.ym.error}`]
      .filter(Boolean)
      .join('; ');

  const syncStatuses = async () => {
    setStatusSyncError('');
    try {
      const res = await certificatesApi.syncStatuses();
      const data = res?.data || {};
      const errors = syncErrorsText(data);
      if (errors) setStatusSyncError(errors);
      if (data.ozon?.updated || data.ym?.updated) await load({ silent: true });
    } catch (err) {
      setStatusSyncError(err?.response?.data?.message || err?.message || 'Не удалось обновить статусы');
    }
  };

  const runImport = async () => {
    setImportBusy(true);
    setImportMessage(null);
    try {
      const res = await certificatesApi.importFromMarketplaces();
      const d = res?.data || {};
      const parts = [
        `Добавлено: ${d.created || 0}`,
        `связано с существующими: ${d.linked || 0}`,
        `без изменений: ${d.unchanged || 0}`,
      ];
      let text = `Импорт завершён. ${parts.join(', ')}.`;
      if (d.without_brand) {
        text += ` У ${d.without_brand} не удалось определить бренд и категории — укажите их вручную.`;
      }
      const errs = [
        d.errors?.ozon && `Ozon: ${d.errors.ozon}`,
        d.errors?.ym && `Яндекс: ${d.errors.ym}`,
        ...(d.errors?.items || []),
      ].filter(Boolean);
      if (errs.length) text += ` Ошибки: ${errs.join('; ')}`;
      setImportMessage({ text, isError: false });
      await load({ silent: true });
    } catch (err) {
      setImportMessage({
        text: err?.response?.data?.message || err?.message || 'Не удалось импортировать сертификаты',
        isError: true,
      });
    } finally {
      setImportBusy(false);
    }
  };

  const syncOneStatus = async (id) => {
    setStatusSyncingId(id);
    setStatusSyncError('');
    try {
      const res = await certificatesApi.syncStatus(id);
      const errors = syncErrorsText(res?.data);
      if (errors) setStatusSyncError(errors);
      await load({ silent: true });
    } catch (err) {
      setStatusSyncError(err?.response?.data?.message || err?.message || 'Не удалось обновить статус');
    } finally {
      setStatusSyncingId(null);
    }
  };

  useEffect(() => {
    load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [filterBrandId]);

  useEffect(() => {
    syncStatuses();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

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

  const handleDelete = async (c) => {
    if (c.ozon_certificate_id || c.ym_document_id) {
      setDeleteError('');
      setDeleteForm({ deleteOzon: Boolean(c.ozon_certificate_id), deleteYm: Boolean(c.ym_document_id) });
      setDeleteModalCert(c);
      return;
    }
    if (!window.confirm('Удалить этот документ?')) return;
    try {
      await certificatesApi.remove(c.id);
      await load();
    } catch (err) {
      alert(err?.response?.data?.message || err?.message || 'Ошибка удаления');
    }
  };

  const closeDeleteModal = () => {
    if (deleteBusy) return;
    setDeleteModalCert(null);
  };

  const confirmDelete = async () => {
    if (!deleteModalCert) return;
    setDeleteBusy(true);
    setDeleteError('');
    try {
      await certificatesApi.remove(deleteModalCert.id, {
        deleteOzon: deleteForm.deleteOzon && Boolean(deleteModalCert.ozon_certificate_id),
        deleteYm: deleteForm.deleteYm && Boolean(deleteModalCert.ym_document_id),
      });
      setDeleteModalCert(null);
      await load({ silent: true });
    } catch (err) {
      setDeleteError(err?.response?.data?.message || err?.message || 'Ошибка удаления');
      const fresh = await load({ silent: true });
      const current = fresh?.find((x) => x.id === deleteModalCert.id);
      if (current) setDeleteModalCert(current);
    } finally {
      setDeleteBusy(false);
    }
  };

  const openOzonPush = async (c) => {
    setOzonModalCert(c);
    setOzonError('');
    setOzonResult(null);
    setOzonForm({
      name: c.ozon_name || defaultMarketplaceCertificateName(c, brandNameById),
      accordanceTypeCode: c.ozon_accordance_type_code || 'technical_regulations_cu',
      bindProducts: true,
      rebindFromOther: false,
      forceCreate: false,
    });
    if (ozonAccordanceTypes.length === 0) {
      try {
        const res = await certificatesApi.ozonAccordanceTypes();
        setOzonAccordanceTypes(res?.data || []);
      } catch (_) {
        setOzonAccordanceTypes([
          { code: 'technical_regulations_cu', label: 'Технический регламент ТС' },
          { code: 'technical_regulations_rf', label: 'Технический регламент РФ' },
          { code: 'gost', label: 'ГОСТ' },
        ]);
      }
    }
  };

  const closeOzonPush = () => {
    if (ozonBusy) return;
    setOzonModalCert(null);
    setOzonError('');
    setOzonResult(null);
  };

  const handleOzonPush = async (e) => {
    e?.preventDefault?.();
    if (!ozonModalCert?.id) return;
    setOzonBusy(true);
    setOzonError('');
    setOzonResult(null);
    try {
      const res = await certificatesApi.pushToOzon(ozonModalCert.id, {
        name: ozonForm.name?.trim() || undefined,
        accordanceTypeCode: ozonForm.accordanceTypeCode || undefined,
        bindProducts: !!ozonForm.bindProducts,
        rebindFromOther: !!ozonForm.bindProducts && !!ozonForm.rebindFromOther,
        forceCreate: !!ozonForm.forceCreate,
      });
      setOzonResult(res?.data || res);
      await load();
    } catch (err) {
      setOzonError(err?.response?.data?.message || err?.message || 'Ошибка отправки на Ozon');
    } finally {
      setOzonBusy(false);
    }
  };

  const loadBindingReport = async (c) => {
    setBindingBusy(true);
    setBindingError('');
    try {
      const res = await certificatesApi.bindingReport(c.id);
      setBindingData(res?.data || null);
    } catch (err) {
      setBindingError(err?.response?.data?.message || err?.message || 'Не удалось проверить привязку');
    } finally {
      setBindingBusy(false);
    }
  };

  const openBindingReport = (c) => {
    setBindingCert(c);
    setBindingData(null);
    loadBindingReport(c);
  };

  const closeBindingReport = () => {
    if (rebindBusy) return;
    setBindingCert(null);
    setBindingData(null);
    setBindingError('');
  };

  const handleRebindOzon = async () => {
    if (!bindingCert?.id) return;
    setRebindBusy(true);
    setBindingError('');
    try {
      const res = await certificatesApi.pushToOzon(bindingCert.id, {
        bindProducts: true,
        rebindFromOther: true,
      });
      const report = res?.data?.binding_report || null;
      setBindingData((prev) => ({ ...(prev || {}), ozon: { report } }));
      await load({ silent: true });
    } catch (err) {
      setBindingError(err?.response?.data?.message || err?.message || 'Не удалось перепривязать товары');
    } finally {
      setRebindBusy(false);
    }
  };

  const openYmPush = async (c) => {
    setYmModalCert(c);
    setYmError('');
    setYmResult(null);
    setYmForm({
      documentType: c.ym_document_type || defaultYmDocType(c.document_type),
      bindProducts: true,
      forceCreate: false,
    });
    if (ymDocumentTypes.length === 0) {
      try {
        const res = await certificatesApi.ymDocumentTypes();
        setYmDocumentTypes(res?.data || []);
      } catch (_) {
        setYmDocumentTypes(YM_DOC_TYPE_DEFAULTS);
      }
    }
  };

  const closeYmPush = () => {
    if (ymBusy) return;
    setYmModalCert(null);
    setYmError('');
    setYmResult(null);
  };

  const handleYmPush = async (e) => {
    e?.preventDefault?.();
    if (!ymModalCert?.id) return;
    setYmBusy(true);
    setYmError('');
    setYmResult(null);
    try {
      const res = await certificatesApi.pushToYm(ymModalCert.id, {
        documentType: ymForm.documentType || undefined,
        bindProducts: !!ymForm.bindProducts,
        forceCreate: !!ymForm.forceCreate,
      });
      setYmResult(res?.data || res);
      await load();
    } catch (err) {
      setYmError(err?.response?.data?.message || err?.message || 'Ошибка отправки на Яндекс.Маркет');
    } finally {
      setYmBusy(false);
    }
  };

  const pageLoading = loading || brandsLoading || categoriesLoading;

  if (pageLoading && list.length === 0) {
    return <div className="certificates-page card"><p className="loading">Загрузка...</p></div>;
  }
  if (error && list.length === 0) {
    return <div className="certificates-page card"><p className="error">Ошибка: {error}</p></div>;
  }

  return (
    <div className="certificates-page card">
      <h1 className="title">Сертификаты</h1>
      <p className="subtitle">
        Документы соответствия с привязкой бренд + категория.
        Кнопки Ozon / ЯМ создают документ в кабинете маркетплейса и привязывают товары с этой парой бренд/категория.
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
        <div className="certificates-toolbar-actions">
          <Button
            variant="secondary"
            onClick={runImport}
            disabled={importBusy}
            title="Загрузить сертификаты, которые уже есть в кабинетах Ozon и Яндекс.Маркета. Одинаковые номера не дублируются."
          >
            {importBusy ? 'Импортирую…' : 'Импорт с маркетплейсов'}
          </Button>
          <Button variant="primary" onClick={openCreate}>➕ Добавить</Button>
        </div>
      </div>
      {importMessage ? (
        <p className={importMessage.isError ? 'error' : 'certificates-import-result'}>{importMessage.text}</p>
      ) : null}
      {statusSyncError ? <p className="error">{statusSyncError}</p> : null}

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
                <th>Срок</th>
                <th>Ozon</th>
                <th>Яндекс</th>
                <th style={{ width: 190 }}></th>
              </tr>
            </thead>
            <tbody>
              {filteredList.map((c) => {
                const days = daysUntil(c.valid_to);
                const expired = days != null && days < 0;
                const expSoon = days != null && days >= 0 && days <= 30;
                const ozonStatus = String(c.ozon_status_code || '').toLowerCase();
                const ymStatus = String(c.ym_status_code || '').toUpperCase();
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
                      {c.ozon_certificate_id ? (
                        <div className="ozon-sync-cell">
                          <div className="status-line">
                            <span
                              className={
                                ozonStatus === 'approved'
                                  ? 'status-ozon-ok'
                                  : ozonStatus === 'rejected' || ozonStatus === 'declined'
                                    ? 'status-expired'
                                    : 'status-ozon-pending'
                              }
                            >
                              {OZON_STATUS_LABELS[ozonStatus] || `ID ${c.ozon_certificate_id}`}
                            </span>
                            {!OZON_FINAL_STATUSES.includes(ozonStatus) ? (
                              <StatusRefreshButton
                                busy={statusSyncingId === c.id}
                                onClick={() => syncOneStatus(c.id)}
                              />
                            ) : null}
                          </div>
                          {c.ozon_last_error ? (
                            <button
                              type="button"
                              className="muted ozon-error-hint ozon-error-hint--link"
                              title={c.ozon_last_error}
                              onClick={() => openBindingReport(c)}
                            >
                              есть ошибка
                            </button>
                          ) : null}
                        </div>
                      ) : (
                        <span className="muted">не отправлен</span>
                      )}
                    </td>
                    <td>
                      {c.ym_document_id || c.ym_status_code ? (
                        <div className="ozon-sync-cell">
                          <div className="status-line">
                            <span
                              className={
                                ymStatus === 'ACTIVE'
                                  ? 'status-ozon-ok'
                                  : ymStatus === 'NOT_FOUND' || ymStatus === 'EXPIRED' || ymStatus === 'REVOKED'
                                    ? 'status-expired'
                                    : 'status-ozon-pending'
                              }
                            >
                              {YM_STATUS_LABELS[ymStatus]
                                || (c.ym_document_id ? `ID ${c.ym_document_id}` : ymStatus)}
                            </span>
                            {c.ym_document_id && YM_PENDING_STATUSES.includes(ymStatus || 'VALIDATING') ? (
                              <StatusRefreshButton
                                busy={statusSyncingId === c.id}
                                onClick={() => syncOneStatus(c.id)}
                              />
                            ) : null}
                          </div>
                          {c.ym_last_error ? (
                            <button
                              type="button"
                              className="muted ozon-error-hint ozon-error-hint--link"
                              title={c.ym_last_error}
                              onClick={() => openBindingReport(c)}
                            >
                              есть ошибка
                            </button>
                          ) : null}
                        </div>
                      ) : (
                        <span className="muted">не отправлен</span>
                      )}
                    </td>
                    <td className="certificates-actions-cell">
                      <div className="certificates-actions">
                        <Button
                          variant="secondary"
                          size="small"
                          onClick={() => openOzonPush(c)}
                          title="Отправить на Ozon"
                          className="btn-icon btn-ozon-push"
                          aria-label="Отправить на Ozon"
                        >
                          Ozon
                        </Button>
                        <Button
                          variant="secondary"
                          size="small"
                          onClick={() => openYmPush(c)}
                          title="Отправить на Яндекс.Маркет"
                          className="btn-icon btn-ym-push"
                          aria-label="Отправить на Яндекс.Маркет"
                        >
                          ЯМ
                        </Button>
                        {c.ozon_certificate_id || c.ym_document_id ? (
                          <Button
                            variant="secondary"
                            size="small"
                            onClick={() => openBindingReport(c)}
                            title="Проверить, какие товары привязаны на маркетплейсах"
                            className="btn-icon btn-icon-only"
                            aria-label="Привязка товаров"
                          >
                            🔗
                          </Button>
                        ) : null}
                        <Button
                          variant="secondary"
                          size="small"
                          onClick={() => openEdit(c)}
                          title="Изменить"
                          className="btn-icon btn-icon-only"
                          aria-label="Изменить"
                        >
                          ✏️
                        </Button>
                        <Button
                          variant="secondary"
                          size="small"
                          className="btn-icon btn-icon-only btn-delete"
                          onClick={() => handleDelete(c)}
                          title="Удалить"
                          aria-label="Удалить"
                        >
                          🗑️
                        </Button>
                      </div>
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

      <Modal
        isOpen={!!ozonModalCert}
        onClose={closeOzonPush}
        title="Отправить сертификат на Ozon"
        size="medium"
      >
        {ozonModalCert && (
          <form className="certificate-form" onSubmit={handleOzonPush}>
            <p className="form-hint">
              Документ <strong>{ozonModalCert.certificate_number}</strong> будет создан в разделе
              «Сертификаты» кабинета Ozon (организация из шапки сайта). Нужны файл jpg/png/pdf и дата начала.
            </p>
            {ozonError && <div className="form-error">{ozonError}</div>}
            {ozonResult && (
              <div className="ozon-push-result">
                {ozonResult.created ? 'Создан на Ozon. ' : 'Использован уже созданный сертификат. '}
                ID: {ozonResult.ozon_certificate_id}.
                {' '}Найдено товаров: {ozonResult.products_found ?? 0}, привязано: {ozonResult.products_bound ?? 0}.
                {ozonResult.products_rebound ? ` Перепривязано с других сертификатов: ${ozonResult.products_rebound}.` : ''}
                {Array.isArray(ozonResult.bind_errors) && ozonResult.bind_errors.length > 0
                  ? ` Ошибки: ${ozonResult.bind_errors.join('; ')}.`
                  : ''}
              </div>
            )}
            {ozonResult?.binding_report ? (
              <CertificateBindingReport marketplace="ozon" report={ozonResult.binding_report} />
            ) : null}
            <div className="form-group">
              <label>Название на Ozon</label>
              <input
                type="text"
                maxLength={100}
                value={ozonForm.name}
                onChange={(e) => setOzonForm((p) => ({ ...p, name: e.target.value }))}
                placeholder="Например: Фильтр воздушный Nordfil"
              />
              <p className="form-hint">Подставлено из категорий и бренда — можно изменить.</p>
            </div>
            <div className="form-group">
              <label>Тип соответствия</label>
              <select
                value={ozonForm.accordanceTypeCode}
                onChange={(e) => setOzonForm((p) => ({ ...p, accordanceTypeCode: e.target.value }))}
              >
                {(ozonAccordanceTypes.length
                  ? ozonAccordanceTypes
                  : [{ code: 'technical_regulations_cu', label: 'Технический регламент ТС' }]
                ).map((t) => (
                  <option key={t.code} value={t.code}>{t.label}</option>
                ))}
              </select>
            </div>
            <label className="checkbox-label">
              <input
                type="checkbox"
                checked={ozonForm.bindProducts}
                onChange={(e) => setOzonForm((p) => ({ ...p, bindProducts: e.target.checked }))}
              />
              <span>Привязать товары с этим брендом и категориями (у которых есть ID в каталоге Ozon)</span>
            </label>
            {ozonForm.bindProducts ? (
              <label className="checkbox-label">
                <input
                  type="checkbox"
                  checked={!!ozonForm.rebindFromOther}
                  onChange={(e) => setOzonForm((p) => ({ ...p, rebindFromOther: e.target.checked }))}
                />
                <span>
                  Перепривязать товары, которые на Ozon привязаны к другим сертификатам (Ozon держит товар только
                  в одном сертификате: товар будет отвязан от старого)
                </span>
              </label>
            ) : null}
            {ozonModalCert.ozon_certificate_id ? (
              <label className="checkbox-label">
                <input
                  type="checkbox"
                  checked={ozonForm.forceCreate}
                  onChange={(e) => setOzonForm((p) => ({ ...p, forceCreate: e.target.checked }))}
                />
                <span>
                  Создать заново (сейчас на Ozon ID {ozonModalCert.ozon_certificate_id})
                </span>
              </label>
            ) : null}
            <div className="form-actions">
              <Button type="button" variant="secondary" onClick={closeOzonPush} disabled={ozonBusy}>
                {ozonResult ? 'Закрыть' : 'Отмена'}
              </Button>
              <Button type="submit" variant="primary" disabled={ozonBusy}>
                {ozonBusy ? 'Отправка…' : ozonModalCert.ozon_certificate_id && !ozonForm.forceCreate
                  ? 'Привязать товары'
                  : 'Отправить на Ozon'}
              </Button>
            </div>
          </form>
        )}
      </Modal>

      <Modal
        isOpen={!!ymModalCert}
        onClose={closeYmPush}
        title="Отправить сертификат на Яндекс.Маркет"
        size="medium"
      >
        {ymModalCert && (
          <form className="certificate-form" onSubmit={handleYmPush}>
            <p className="form-hint">
              Документ <strong>{ymModalCert.certificate_number}</strong> будет создан в
              «Товары → Документы» кабинета Яндекс.Маркета (организация из шапки). API принимает номер, тип и сроки;
              скан при необходимости загружается в кабинете Маркета.
            </p>
            {ymError && <div className="form-error">{ymError}</div>}
            {ymResult && (
              <div className="ozon-push-result">
                {ymResult.created ? 'Создан на Яндекс.Маркете. ' : 'Использован уже созданный документ. '}
                {ymResult.ym_document_id != null ? `ID: ${ymResult.ym_document_id}. ` : ''}
                Статус: {ymResult.status_code || '—'}.
                {Array.isArray(ymResult.bind_errors) && ymResult.bind_errors.length > 0
                  ? ` Ошибки: ${ymResult.bind_errors.join('; ')}.`
                  : ''}
              </div>
            )}
            {ymResult?.binding_report ? (
              <CertificateBindingReport marketplace="ym" report={ymResult.binding_report} />
            ) : null}
            <div className="form-group">
              <label>Тип документа на Яндекс.Маркете</label>
              <select
                value={ymForm.documentType}
                onChange={(e) => setYmForm((p) => ({ ...p, documentType: e.target.value }))}
              >
                {(ymDocumentTypes.length ? ymDocumentTypes : YM_DOC_TYPE_DEFAULTS).map((t) => (
                  <option key={t.code} value={t.code}>{t.label}</option>
                ))}
              </select>
            </div>
            <label className="checkbox-label">
              <input
                type="checkbox"
                checked={ymForm.bindProducts}
                onChange={(e) => setYmForm((p) => ({ ...p, bindProducts: e.target.checked }))}
              />
              <span>Привязать товары с этим брендом и категориями (у которых есть артикул YM / offerId)</span>
            </label>
            {ymModalCert.ym_document_id ? (
              <label className="checkbox-label">
                <input
                  type="checkbox"
                  checked={ymForm.forceCreate}
                  onChange={(e) => setYmForm((p) => ({ ...p, forceCreate: e.target.checked }))}
                />
                <span>
                  Создать заново (сейчас на YM ID {ymModalCert.ym_document_id})
                </span>
              </label>
            ) : null}
            <div className="form-actions">
              <Button type="button" variant="secondary" onClick={closeYmPush} disabled={ymBusy}>
                {ymResult ? 'Закрыть' : 'Отмена'}
              </Button>
              <Button type="submit" variant="primary" disabled={ymBusy}>
                {ymBusy ? 'Отправка…' : ymModalCert.ym_document_id && !ymForm.forceCreate
                  ? 'Привязать товары'
                  : 'Отправить на Яндекс'}
              </Button>
            </div>
          </form>
        )}
      </Modal>

      <Modal
        isOpen={!!bindingCert}
        onClose={closeBindingReport}
        title="Привязка товаров на маркетплейсах"
        size="medium"
      >
        {bindingCert && (
          <div className="certificate-form">
            <p className="form-hint">
              Сверка для <strong>{bindingCert.certificate_number}</strong>: товары ERP с этим брендом и категориями
              против того, что реально привязано в кабинетах.
            </p>
            {bindingError ? <div className="form-error">{bindingError}</div> : null}
            {bindingBusy ? (
              <p className="muted">Проверяем привязку на Ozon и Яндекс.Маркете…</p>
            ) : bindingData ? (
              <>
                <CertificateBindingReport
                  marketplace="ozon"
                  report={bindingData.ozon?.report}
                  error={bindingData.ozon?.error}
                />
                <CertificateBindingReport
                  marketplace="ym"
                  report={bindingData.ym?.report}
                  error={bindingData.ym?.error}
                />
              </>
            ) : null}
            <div className="form-actions">
              <Button
                type="button"
                variant="secondary"
                onClick={() => loadBindingReport(bindingCert)}
                disabled={bindingBusy || rebindBusy}
              >
                Проверить снова
              </Button>
              {bindingData?.ozon?.report?.held_by_other_count > 0 ? (
                <Button type="button" variant="primary" onClick={handleRebindOzon} disabled={bindingBusy || rebindBusy}>
                  {rebindBusy
                    ? 'Перепривязываем…'
                    : `Перепривязать на Ozon (${bindingData.ozon.report.held_by_other_count})`}
                </Button>
              ) : null}
              <Button type="button" variant="secondary" onClick={closeBindingReport} disabled={rebindBusy}>
                Закрыть
              </Button>
            </div>
          </div>
        )}
      </Modal>

      <Modal
        isOpen={!!deleteModalCert}
        onClose={closeDeleteModal}
        title="Удалить сертификат"
        size="medium"
      >
        {deleteModalCert && (
          <div className="certificate-form">
            <p className="form-hint">
              Документ <strong>{deleteModalCert.certificate_number}</strong> отправлен на маркетплейсы.
              Удалить его и там? Без удаления он останется в кабинете маркетплейса и привязанных товарах.
            </p>
            {deleteError && <div className="form-error">{deleteError}</div>}
            {deleteModalCert.ozon_certificate_id ? (
              <label className="checkbox-label">
                <input
                  type="checkbox"
                  checked={deleteForm.deleteOzon}
                  onChange={(e) => setDeleteForm((p) => ({ ...p, deleteOzon: e.target.checked }))}
                  disabled={deleteBusy}
                />
                <span>Удалить также на Ozon (ID {deleteModalCert.ozon_certificate_id})</span>
              </label>
            ) : null}
            {deleteModalCert.ym_document_id ? (
              <label className="checkbox-label">
                <input
                  type="checkbox"
                  checked={deleteForm.deleteYm}
                  onChange={(e) => setDeleteForm((p) => ({ ...p, deleteYm: e.target.checked }))}
                  disabled={deleteBusy}
                />
                <span>Удалить также на Яндекс.Маркете (ID {deleteModalCert.ym_document_id})</span>
              </label>
            ) : null}
            <div className="form-actions">
              <Button type="button" variant="secondary" onClick={closeDeleteModal} disabled={deleteBusy}>
                Отмена
              </Button>
              <Button type="button" variant="danger" onClick={confirmDelete} disabled={deleteBusy}>
                {deleteBusy ? 'Удаление…' : 'Удалить'}
              </Button>
            </div>
          </div>
        )}
      </Modal>
    </div>
  );
}
