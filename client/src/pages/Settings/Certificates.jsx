/**
 * Certificates Page
 * Настройки → Сертификаты: реестр с привязкой бренд + конкретные товары.
 * Отдельный список товаров без сертификатов.
 */

import React, { useMemo, useState, useEffect, useCallback } from 'react';
import { certificatesApi } from '../../services/certificates.api';
import { productsApi } from '../../services/products.api';
import { useBrands } from '../../hooks/useBrands';
import { useCategories } from '../../hooks/useCategories';
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

/** В UI привязки показываем только артикул; название — в title. */
function productSku(p) {
  if (!p) return '';
  const sku = p.sku ? String(p.sku).trim() : '';
  return sku || `ID ${p.id}`;
}

function productTitle(p) {
  if (!p) return '';
  const sku = productSku(p);
  const name = p.name ? String(p.name).trim() : '';
  return name ? `${sku} — ${name}` : sku;
}

function emptyForm() {
  return {
    certificate_number: '',
    document_type: 'certificate',
    brand_id: '',
    product_ids: [],
    products: [],
    valid_from: '',
    valid_to: '',
  };
}

function CertificateForm({
  form,
  setForm,
  brands,
  productSearch,
  setProductSearch,
  productOptions,
  productsLoading,
  photoFile,
  setPhotoFile,
  editing,
  error,
  onSubmit,
  onCancel,
  saving,
}) {
  const selectedProductSet = useMemo(
    () => new Set((form.product_ids || []).map(String)),
    [form.product_ids]
  );

  const selectedProducts = useMemo(() => {
    const byId = new Map();
    for (const p of form.products || []) byId.set(String(p.id), p);
    for (const p of productOptions || []) {
      if (!byId.has(String(p.id))) byId.set(String(p.id), p);
    }
    return (form.product_ids || [])
      .map((id) => byId.get(String(id)) || { id })
      .filter(Boolean);
  }, [form.product_ids, form.products, productOptions]);

  const toggleProduct = (product) => {
    const sid = String(product.id);
    setForm((prev) => {
      const curr = new Set((prev.product_ids || []).map(String));
      const productsMap = new Map((prev.products || []).map((p) => [String(p.id), p]));
      if (curr.has(sid)) {
        curr.delete(sid);
        productsMap.delete(sid);
      } else {
        curr.add(sid);
        productsMap.set(sid, product);
      }
      return {
        ...prev,
        product_ids: Array.from(curr),
        products: Array.from(productsMap.values()),
      };
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
          onChange={(e) => setForm((p) => ({
            ...p,
            brand_id: e.target.value,
            product_ids: [],
            products: [],
          }))}
          required
        >
          <option value="">Выберите бренд</option>
          {(brands || []).map((b) => (
            <option key={b.id} value={b.id}>{b.name}</option>
          ))}
        </select>
      </div>

      <div className="form-group">
        <label>Товары</label>
        <p className="form-hint">Необязательно: можно сохранить документ без привязки и добавить товары позже.</p>
        {!form.brand_id ? (
          <div className="muted">Сначала выберите бренд</div>
        ) : (
          <>
            <input
              type="text"
              className="category-search"
              placeholder="Поиск по артикулу или названию…"
              value={productSearch}
              onChange={(e) => setProductSearch(e.target.value)}
            />
            <div className="category-checkboxes">
              {productsLoading ? (
                <div className="muted">Загрузка товаров…</div>
              ) : productOptions.length === 0 ? (
                <div className="muted">Ничего не найдено</div>
              ) : (
                productOptions.map((p) => (
                  <label key={p.id} className="checkbox-label" title={productTitle(p)}>
                    <input
                      type="checkbox"
                      checked={selectedProductSet.has(String(p.id))}
                      onChange={() => toggleProduct(p)}
                    />
                    <span>{productSku(p)}</span>
                  </label>
                ))
              )}
            </div>
          </>
        )}
        {selectedProducts.length > 0 && (
          <div className="selected-tags">
            {selectedProducts.map((p) => (
              <button
                key={String(p.id)}
                type="button"
                className="tag tag--removable"
                onClick={() => toggleProduct(p)}
                title={`Отвязать: ${productTitle(p)}`}
                aria-label={`Отвязать ${productSku(p)}`}
              >
                {productSku(p)}
                <span className="tag-remove" aria-hidden="true">×</span>
              </button>
            ))}
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
  const { categories: userCategories } = useCategories();
  const [activeTab, setActiveTab] = useState('registry');
  const [list, setList] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [modalOpen, setModalOpen] = useState(false);
  const [editing, setEditing] = useState(null);
  const [form, setForm] = useState(emptyForm());
  const [formError, setFormError] = useState('');
  const [productSearch, setProductSearch] = useState('');
  const [productOptions, setProductOptions] = useState([]);
  const [productsLoading, setProductsLoading] = useState(false);
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

  const [withoutCerts, setWithoutCerts] = useState([]);
  const [withoutTotal, setWithoutTotal] = useState(0);
  const [withoutLoading, setWithoutLoading] = useState(false);
  const [withoutError, setWithoutError] = useState('');
  const [withoutSearch, setWithoutSearch] = useState('');
  const [withoutSearchApplied, setWithoutSearchApplied] = useState('');
  const [withoutBrandId, setWithoutBrandId] = useState('');
  const [withoutCategoryId, setWithoutCategoryId] = useState('');
  const [withoutOffset, setWithoutOffset] = useState(0);
  const WITHOUT_LIMIT = 50;

  const withoutCategoryOptions = useMemo(() => {
    const rows = Array.isArray(userCategories) ? [...userCategories] : [];
    rows.sort((a, b) => String(a.name || '').localeCompare(String(b.name || ''), 'ru'));
    return rows;
  }, [userCategories]);
  const [bindProduct, setBindProduct] = useState(null);
  const [bindCertId, setBindCertId] = useState('');
  const [bindCertSearch, setBindCertSearch] = useState('');
  const [bindBusy, setBindBusy] = useState(false);
  const [bindError, setBindError] = useState('');

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
        text += ` У ${d.without_brand} не удалось определить бренд и товары — укажите их вручную.`;
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

  const loadWithoutCerts = useCallback(async () => {
    setWithoutLoading(true);
    setWithoutError('');
    try {
      const res = await certificatesApi.getProductsWithoutCertificate({
        brandId: withoutBrandId || undefined,
        userCategoryId: withoutCategoryId || undefined,
        search: withoutSearchApplied || undefined,
        limit: WITHOUT_LIMIT,
        offset: withoutOffset,
      });
      const data = res?.data || {};
      setWithoutCerts(Array.isArray(data.items) ? data.items : []);
      setWithoutTotal(Number(data.total) || 0);
    } catch (err) {
      setWithoutError(err?.message || 'Ошибка загрузки товаров');
      setWithoutCerts([]);
      setWithoutTotal(0);
    } finally {
      setWithoutLoading(false);
    }
  }, [withoutBrandId, withoutCategoryId, withoutSearchApplied, withoutOffset]);

  useEffect(() => {
    load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [filterBrandId]);

  useEffect(() => {
    syncStatuses();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    // Счётчик для вкладки — сразу при открытии страницы
    certificatesApi
      .getProductsWithoutCertificate({ limit: 1, offset: 0 })
      .then((res) => setWithoutTotal(Number(res?.data?.total) || 0))
      .catch(() => {});
  }, []);

  useEffect(() => {
    const t = setTimeout(() => {
      const next = String(withoutSearch || '').trim();
      setWithoutSearchApplied((prev) => {
        if (prev === next) return prev;
        setWithoutOffset(0);
        return next;
      });
    }, 300);
    return () => clearTimeout(t);
  }, [withoutSearch]);

  useEffect(() => {
    if (activeTab !== 'without') return;
    loadWithoutCerts();
  }, [activeTab, loadWithoutCerts]);

  useEffect(() => {
    if (!modalOpen || !form.brand_id) {
      setProductOptions([]);
      return;
    }
    let cancelled = false;
    const timer = setTimeout(async () => {
      setProductsLoading(true);
      try {
        const res = await productsApi.getAll({
          brandId: form.brand_id,
          search: productSearch || undefined,
          limit: 80,
        });
        if (cancelled) return;
        const raw = res?.data?.items ?? res?.data ?? res?.items ?? [];
        setProductOptions(Array.isArray(raw) ? raw : []);
      } catch (_) {
        if (!cancelled) setProductOptions([]);
      } finally {
        if (!cancelled) setProductsLoading(false);
      }
    }, 250);
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [modalOpen, form.brand_id, productSearch]);

  const filteredList = useMemo(() => {
    if (!filterDocType) return list;
    return list.filter((c) => String(c.document_type || 'certificate') === filterDocType);
  }, [list, filterDocType]);

  const openCreate = () => {
    setEditing(null);
    setForm(emptyForm());
    setFormError('');
    setProductSearch('');
    setPhotoFile(null);
    setModalOpen(true);
  };

  const openEdit = (c) => {
    setEditing(c);
    setForm({
      certificate_number: c.certificate_number || '',
      document_type: c.document_type || 'certificate',
      brand_id: c.brand_id != null ? String(c.brand_id) : '',
      product_ids: Array.isArray(c.product_ids) ? c.product_ids.map(String) : [],
      products: Array.isArray(c.products) ? c.products : [],
      valid_from: toDateOnly(c.valid_from),
      valid_to: toDateOnly(c.valid_to),
    });
    setFormError('');
    setProductSearch('');
    setPhotoFile(null);
    setModalOpen(true);
  };

  const openBindProduct = (product) => {
    setBindProduct(product);
    setBindCertId('');
    setBindCertSearch('');
    setBindError('');
  };

  const closeBindProduct = ({ force = false } = {}) => {
    if (bindBusy && !force) return;
    setBindProduct(null);
    setBindCertId('');
    setBindCertSearch('');
    setBindError('');
  };

  const bindProductCandidates = useMemo(() => {
    if (!bindProduct) return [];
    const brandId =
      bindProduct.brand_id != null && bindProduct.brand_id !== ''
        ? String(bindProduct.brand_id)
        : '';
    const q = String(bindCertSearch || '').trim().toLowerCase();
    let rows = Array.isArray(list) ? [...list] : [];
    // Только сертификаты того же бренда; без бренда у товара — весь реестр.
    if (brandId) {
      rows = rows.filter((c) => String(c.brand_id) === brandId);
    }
    rows.sort((a, b) =>
      String(a.certificate_number || '').localeCompare(String(b.certificate_number || ''), 'ru')
    );
    if (q) {
      rows = rows.filter((c) => {
        const num = String(c.certificate_number || '').toLowerCase();
        const brand = String(c.brand_name || brandNameById[String(c.brand_id)] || '').toLowerCase();
        const type = String(DOC_TYPE_LABELS[c.document_type] || '').toLowerCase();
        return num.includes(q) || brand.includes(q) || type.includes(q);
      });
    }
    return rows;
  }, [bindProduct, list, bindCertSearch, brandNameById]);

  const openCreateForProduct = (product) => {
    closeBindProduct();
    setEditing(null);
    setForm({
      ...emptyForm(),
      brand_id: product.brand_id != null ? String(product.brand_id) : '',
      product_ids: [String(product.id)],
      products: [{ id: product.id, sku: product.sku, name: product.name }],
    });
    setFormError('');
    setProductSearch('');
    setPhotoFile(null);
    setModalOpen(true);
  };

  const handleBindToExisting = async () => {
    if (!bindProduct?.id || !bindCertId) {
      setBindError('Выберите сертификат');
      return;
    }
    const cert = list.find((c) => String(c.id) === String(bindCertId));
    if (!cert) {
      setBindError('Сертификат не найден в списке — обновите страницу');
      return;
    }
    const productBrandId =
      bindProduct.brand_id != null && bindProduct.brand_id !== ''
        ? String(bindProduct.brand_id)
        : '';
    if (productBrandId && String(cert.brand_id) !== productBrandId) {
      setBindError('Можно привязать только сертификат того же бренда, что и у товара');
      return;
    }
    const existingIds = Array.isArray(cert.product_ids)
      ? cert.product_ids.map((x) => Number(x)).filter((n) => Number.isFinite(n) && n > 0)
      : [];
    const productId = Number(bindProduct.id);
    if (!Number.isFinite(productId) || productId <= 0) {
      setBindError('Некорректный товар');
      return;
    }
    const nextIds = existingIds.includes(productId) ? existingIds : [...existingIds, productId];
    setBindBusy(true);
    setBindError('');
    try {
      await certificatesApi.update(cert.id, { product_ids: nextIds });
      closeBindProduct({ force: true });
      await load({ silent: true });
      if (activeTab === 'without') await loadWithoutCerts();
    } catch (err) {
      setBindError(err?.response?.data?.message || err?.message || 'Не удалось привязать товар');
    } finally {
      setBindBusy(false);
    }
  };

  const closeModal = () => {
    setModalOpen(false);
    setEditing(null);
    setForm(emptyForm());
    setFormError('');
    setProductSearch('');
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
    const productIds = (form.product_ids || [])
      .map((x) => Number(x))
      .filter((n) => Number.isFinite(n) && n > 0);

    setSaving(true);
    setFormError('');
    try {
      const payload = {
        certificate_number: number,
        document_type: form.document_type || 'certificate',
        brand_id: Number(form.brand_id),
        product_ids: productIds,
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
      if (activeTab === 'without') await loadWithoutCerts();
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
      if (activeTab === 'without') await loadWithoutCerts();
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
      // Сверка обновляет ozon/ym_last_error на сервере — подтянем список, чтобы «есть ошибка» исчезла.
      await load({ silent: true });
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

  const pageLoading = loading || brandsLoading;

  if (pageLoading && list.length === 0 && activeTab === 'registry') {
    return <div className="certificates-page card"><p className="loading">Загрузка...</p></div>;
  }
  if (error && list.length === 0 && activeTab === 'registry') {
    return <div className="certificates-page card"><p className="error">Ошибка: {error}</p></div>;
  }

  return (
    <div className="certificates-page card">
      <h1 className="title">Сертификаты</h1>
      <p className="subtitle">
        Документы соответствия с привязкой к конкретным товарам.
        Кнопки Ozon / ЯМ создают документ в кабинете маркетплейса и привязывают выбранные товары.
      </p>

      <div className="certificates-tabs">
        <button
          type="button"
          className={`certificates-tab${activeTab === 'registry' ? ' is-active' : ''}`}
          onClick={() => setActiveTab('registry')}
        >
          Реестр
        </button>
        <button
          type="button"
          className={`certificates-tab${activeTab === 'without' ? ' is-active' : ''}`}
          onClick={() => setActiveTab('without')}
        >
          Без сертификатов
          {withoutTotal > 0 ? ` (${withoutTotal})` : ''}
        </button>
      </div>
      {importMessage ? (
        <p className={importMessage.isError ? 'error' : 'certificates-import-result'}>{importMessage.text}</p>
      ) : null}
      {statusSyncError ? <p className="error">{statusSyncError}</p> : null}

      {activeTab === 'registry' && (
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
                    <th>Товары</th>
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
                    const products = Array.isArray(c.products) ? c.products : [];
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
                          {products.length > 0 ? (
                            <div className="selected-tags">
                              {products.slice(0, 4).map((p) => (
                                <span key={p.id} className="tag" title={productTitle(p)}>
                                  {productSku(p)}
                                </span>
                              ))}
                              {products.length > 4 && (
                                <span className="muted">+{products.length - 4}</span>
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
        </>
      )}

      {activeTab === 'without' && (
        <>
          <div className="certificates-toolbar">
            <div className="filters">
              <select
                value={withoutBrandId}
                onChange={(e) => {
                  setWithoutBrandId(e.target.value);
                  setWithoutOffset(0);
                }}
                aria-label="Фильтр по бренду"
              >
                <option value="">Все бренды</option>
                {(brands || []).map((b) => (
                  <option key={b.id} value={b.id}>{b.name}</option>
                ))}
              </select>
              <select
                className="without-category-filter"
                value={withoutCategoryId}
                onChange={(e) => {
                  setWithoutCategoryId(e.target.value);
                  setWithoutOffset(0);
                }}
                aria-label="Фильтр по категории"
              >
                <option value="">Все категории</option>
                {withoutCategoryOptions.map((c) => (
                  <option key={c.id} value={c.id}>{c.name}</option>
                ))}
              </select>
              <input
                type="search"
                className="without-search"
                placeholder="Поиск по артикулу или названию…"
                value={withoutSearch}
                onChange={(e) => setWithoutSearch(e.target.value)}
                aria-label="Поиск по товару"
              />
            </div>
            <Button variant="secondary" onClick={loadWithoutCerts} disabled={withoutLoading}>
              {withoutLoading ? 'Загрузка…' : 'Обновить'}
            </Button>
          </div>

          {withoutError && <div className="form-error">{withoutError}</div>}

          <div className="certificates-table-wrap">
            {withoutLoading && withoutCerts.length === 0 ? (
              <p className="loading">Загрузка...</p>
            ) : withoutCerts.length === 0 ? (
              <div className="empty-state">
                <p>
                  {withoutBrandId || withoutCategoryId || withoutSearchApplied
                    ? 'По выбранным фильтрам товары без сертификата не найдены'
                    : 'Все товары имеют привязку к сертификату'}
                </p>
              </div>
            ) : (
              <table className="certificates-table">
                <thead>
                  <tr>
                    <th>Артикул</th>
                    <th>Название</th>
                    <th>Бренд</th>
                    <th>Категория</th>
                    <th style={{ width: 160 }}></th>
                  </tr>
                </thead>
                <tbody>
                  {withoutCerts.map((p) => (
                    <tr key={p.id}>
                      <td className="cell-strong">{p.sku || '—'}</td>
                      <td>{p.name || '—'}</td>
                      <td>{p.brand_name || brandNameById[String(p.brand_id)] || '—'}</td>
                      <td>{p.category_name || '—'}</td>
                      <td>
                        <Button
                          variant="primary"
                          size="small"
                          onClick={() => openBindProduct(p)}
                          title="Привязать к существующему сертификату или создать новый"
                        >
                          Привязать
                        </Button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </div>

          {withoutTotal > WITHOUT_LIMIT && (
            <div className="without-pager">
              <Button
                variant="secondary"
                size="small"
                disabled={withoutOffset <= 0 || withoutLoading}
                onClick={() => setWithoutOffset((o) => Math.max(0, o - WITHOUT_LIMIT))}
              >
                ← Назад
              </Button>
              <span className="muted">
                {withoutOffset + 1}–{Math.min(withoutOffset + WITHOUT_LIMIT, withoutTotal)} из {withoutTotal}
              </span>
              <Button
                variant="secondary"
                size="small"
                disabled={withoutOffset + WITHOUT_LIMIT >= withoutTotal || withoutLoading}
                onClick={() => setWithoutOffset((o) => o + WITHOUT_LIMIT)}
              >
                Вперёд →
              </Button>
            </div>
          )}
        </>
      )}

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
          productSearch={productSearch}
          setProductSearch={setProductSearch}
          productOptions={productOptions}
          productsLoading={productsLoading}
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
              <p className="form-hint">Подставлено автоматически (категории и бренд) — можно изменить.</p>
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
              <span>Привязать выбранные товары (у которых есть ID в каталоге Ozon)</span>
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
              <span>Привязать выбранные товары (у которых есть артикул YM / offerId)</span>
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
        isOpen={!!bindProduct}
        onClose={closeBindProduct}
        title="Привязать к сертификату"
        size="medium"
      >
        {bindProduct && (
          <div className="certificate-form">
            <p className="form-hint">
              Товар <strong>{productSku(bindProduct)}</strong>
              {bindProduct.name ? ` — ${bindProduct.name}` : ''}
              {bindProduct.brand_name || brandNameById[String(bindProduct.brand_id)]
                ? ` (${bindProduct.brand_name || brandNameById[String(bindProduct.brand_id)]})`
                : ''}
            </p>
            {bindError ? <div className="form-error">{bindError}</div> : null}
            <div className="form-group">
              <label>Существующий сертификат</label>
              <p className="form-hint">
                {bindProduct.brand_id
                  ? 'Показаны только сертификаты того же бренда, что и у товара.'
                  : 'У товара нет бренда — показаны все сертификаты.'}
              </p>
              <input
                type="text"
                className="category-search"
                placeholder={
                  bindProduct.brand_id ? 'Поиск по номеру…' : 'Поиск по номеру или бренду…'
                }
                value={bindCertSearch}
                onChange={(e) => setBindCertSearch(e.target.value)}
              />
              <div className="category-checkboxes bind-cert-list">
                {bindProductCandidates.length === 0 ? (
                  <div className="muted">
                    {list.length === 0
                      ? 'В реестре пока нет сертификатов — создайте новый'
                      : bindProduct.brand_id
                        ? 'Нет сертификатов этого бренда — создайте новый'
                        : 'Ничего не найдено'}
                  </div>
                ) : (
                  bindProductCandidates.map((c) => (
                    <label key={c.id} className="checkbox-label">
                      <input
                        type="radio"
                        name="bind-cert"
                        checked={String(bindCertId) === String(c.id)}
                        onChange={() => setBindCertId(String(c.id))}
                      />
                      <span>
                        <strong>{c.certificate_number}</strong>
                        {' · '}
                        {DOC_TYPE_LABELS[c.document_type] || DOC_TYPE_LABELS.certificate}
                        {' · '}
                        {c.brand_name || brandNameById[String(c.brand_id)] || 'без бренда'}
                        {Array.isArray(c.product_ids) && c.product_ids.length > 0
                          ? ` · товаров: ${c.product_ids.length}`
                          : ''}
                      </span>
                    </label>
                  ))
                )}
              </div>
            </div>
            <div className="form-actions">
              <Button type="button" variant="secondary" onClick={closeBindProduct} disabled={bindBusy}>
                Отмена
              </Button>
              <Button
                type="button"
                variant="secondary"
                onClick={() => openCreateForProduct(bindProduct)}
                disabled={bindBusy || !bindProduct.brand_id}
                title={!bindProduct.brand_id ? 'У товара нет бренда — выберите существующий сертификат' : undefined}
              >
                Создать новый
              </Button>
              <Button
                type="button"
                variant="primary"
                onClick={handleBindToExisting}
                disabled={bindBusy || !bindCertId}
              >
                {bindBusy ? 'Привязываем…' : 'Привязать'}
              </Button>
            </div>
          </div>
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
              Сверка для <strong>{bindingCert.certificate_number}</strong>: привязанные к сертификату товары ERP
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
