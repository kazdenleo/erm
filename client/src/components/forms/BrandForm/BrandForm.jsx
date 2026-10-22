/**
 * BrandForm Component
 * Форма создания/редактирования бренда
 */

import React, { useEffect, useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { Button } from '../../common/Button/Button';
import { Modal } from '../../common/Modal/Modal';
import { certificatesApi } from '../../../services/certificates.api';
import { productsApi } from '../../../services/products.api';
import { brandsApi } from '../../../services/brands.api';
import { MpBrandSuggest } from '../../common/MpBrandSuggest/MpBrandSuggest.jsx';
import { COUNTRY_OPTIONS } from '../../../constants/countryOptions.js';

const MP_MARKETPLACES = [
  { key: 'ozon', label: 'Ozon' },
  { key: 'wb', label: 'Wildberries' },
  { key: 'ym', label: 'Яндекс Маркет' },
];

function emptyMpMappings() {
  return {
    ozon: { mp_brand_name: '', mp_brand_id: '' },
    wb: { mp_brand_name: '', mp_brand_id: '' },
    ym: { mp_brand_name: '', mp_brand_id: '' },
  };
}

function mappingsFromBrand(brand) {
  const base = emptyMpMappings();
  const list = brand?.marketplace_mappings ?? brand?.marketplaceMappings ?? [];
  for (const row of list) {
    const mp = String(row.marketplace || '').toLowerCase();
    if (!base[mp]) continue;
    base[mp] = {
      mp_brand_name: row.mp_brand_name ?? row.mpBrandName ?? '',
      mp_brand_id: row.mp_brand_id ?? row.mpBrandId ?? '',
    };
  }
  return base;
}

export function BrandForm({ brand, onSubmit, onCancel }) {
  const [formData, setFormData] = useState({
    name: '',
    website: '',
    certificateNumber: '',
    certificateValidFrom: '',
    certificateValidTo: '',
    ozonBrandPromotionPercent: '',
    ozonBrandPromotionEnabled: false,
    manufacturerCountry: '',
  });
  
  const [errors, setErrors] = useState({});
  const [mpMappings, setMpMappings] = useState(emptyMpMappings);
  const [mpSyncLoading, setMpSyncLoading] = useState(false);
  const [mpCandidates, setMpCandidates] = useState(null);
  const [certs, setCerts] = useState([]);
  const [certsLoading, setCertsLoading] = useState(false);
  const [certsError, setCertsError] = useState('');
  const [isCertModalOpen, setIsCertModalOpen] = useState(false);
  const [editingCert, setEditingCert] = useState(null);
  const [certForm, setCertForm] = useState({
    certificate_number: '',
    document_type: 'certificate',
    product_ids: [],
    products: [],
    valid_from: '',
    valid_to: ''
  });
  const [certPhotoFile, setCertPhotoFile] = useState(null);
  const [certSaving, setCertSaving] = useState(false);
  const [certProductOptions, setCertProductOptions] = useState([]);
  const [certProductsLoading, setCertProductsLoading] = useState(false);
  const [certProductSearch, setCertProductSearch] = useState('');

  useEffect(() => {
    if (brand) {
      setFormData({
        name: brand.name || '',
        website: brand.website || '',
        certificateNumber: brand.certificateNumber || brand.certificate_number || '',
        certificateValidFrom: brand.certificateValidFrom || brand.certificate_valid_from || '',
        certificateValidTo: brand.certificateValidTo || brand.certificate_valid_to || '',
        ozonBrandPromotionPercent:
          brand.ozonBrandPromotionPercent != null
            ? String(brand.ozonBrandPromotionPercent)
            : brand.ozon_brand_promotion_percent != null
              ? String(brand.ozon_brand_promotion_percent)
              : '',
        ozonBrandPromotionEnabled:
          brand.ozonBrandPromotionEnabled === true || brand.ozon_brand_promotion_enabled === true,
        manufacturerCountry: brand.manufacturerCountry ?? brand.manufacturer_country ?? '',
      });
      setMpMappings(mappingsFromBrand(brand));
    } else {
      setMpMappings(emptyMpMappings());
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
    if (!isCertModalOpen || !brand?.id) {
      setCertProductOptions([]);
      return;
    }
    let cancelled = false;
    const timer = setTimeout(async () => {
      setCertProductsLoading(true);
      try {
        const res = await productsApi.getAll({
          brandId: brand.id,
          search: certProductSearch || undefined,
          limit: 80,
        });
        if (cancelled) return;
        const raw = res?.data?.items ?? res?.data ?? res?.items ?? [];
        setCertProductOptions(Array.isArray(raw) ? raw : []);
      } catch (_) {
        if (!cancelled) setCertProductOptions([]);
      } finally {
        if (!cancelled) setCertProductsLoading(false);
      }
    }, 250);
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [isCertModalOpen, brand?.id, certProductSearch]);

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

    const promoRaw = String(formData.ozonBrandPromotionPercent ?? '').trim();
    if (promoRaw !== '') {
      const promoNum = Number(promoRaw.replace(',', '.'));
      if (!Number.isFinite(promoNum) || promoNum < 0 || promoNum > 100) {
        newErrors.ozonBrandPromotionPercent = 'Укажите процент от 0 до 100';
      }
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

    const promoRaw = String(formData.ozonBrandPromotionPercent ?? '').trim().replace(',', '.');
    const promoNum = promoRaw === '' ? null : Number(promoRaw);

    const payload = {
      name: formData.name.trim(),
      website: formData.website.trim() || null,
      certificateNumber: formData.certificateNumber.trim() || null,
      certificateValidFrom: formData.certificateValidFrom || null,
      certificateValidTo: formData.certificateValidTo || null,
      ozonBrandPromotionPercent: promoNum,
      ozonBrandPromotionEnabled: formData.ozonBrandPromotionEnabled === true,
      manufacturerCountry: String(formData.manufacturerCountry || '').trim() || null,
      marketplace_mappings: MP_MARKETPLACES.map(({ key }) => ({
        marketplace: key,
        mp_brand_name: String(mpMappings[key]?.mp_brand_name || '').trim() || null,
        mp_brand_id: String(mpMappings[key]?.mp_brand_id || '').trim() || null,
      })),
    };

    onSubmit(payload);
  };

  const handleMpMappingChange = (marketplace, field, value) => {
    setMpMappings((prev) => ({
      ...prev,
      [marketplace]: {
        ...prev[marketplace],
        [field]: value,
      },
    }));
  };

  const loadMpCandidates = async () => {
    if (!brand?.id) return;
    try {
      const res = await brandsApi.getMpBrandCandidates(brand.id);
      setMpCandidates(res?.data || null);
    } catch (e) {
      alert(e?.message || 'Не удалось загрузить кандидатов с маркетплейсов');
    }
  };

  const applyMpSync = async () => {
    if (!brand?.id) return;
    setMpSyncLoading(true);
    try {
      const res = await brandsApi.syncMpBrands(brand.id, { apply: true });
      const updated = res?.data?.brand;
      if (updated) setMpMappings(mappingsFromBrand(updated));
      setMpCandidates(res?.data?.suggestions || null);
    } catch (e) {
      alert(e?.message || 'Ошибка сопоставления брендов');
    } finally {
      setMpSyncLoading(false);
    }
  };

  const applyCandidate = (marketplace, candidate) => {
    if (!candidate?.name) return;
    setMpMappings((prev) => ({
      ...prev,
      [marketplace]: {
        mp_brand_name: candidate.name,
        mp_brand_id: candidate.mp_brand_id != null ? String(candidate.mp_brand_id) : prev[marketplace]?.mp_brand_id || '',
      },
    }));
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

  const selectedProductSet = useMemo(
    () => new Set((certForm.product_ids || []).map(String)),
    [certForm.product_ids]
  );

  const selectedCertProducts = useMemo(() => {
    const byId = new Map();
    for (const p of certForm.products || []) byId.set(String(p.id), p);
    for (const p of certProductOptions || []) {
      if (!byId.has(String(p.id))) byId.set(String(p.id), p);
    }
    return (certForm.product_ids || [])
      .map((id) => byId.get(String(id)) || { id })
      .filter(Boolean);
  }, [certForm.product_ids, certForm.products, certProductOptions]);

  const productLabel = (p) => {
    if (!p) return '';
    const sku = p.sku ? String(p.sku).trim() : '';
    const name = p.name ? String(p.name).trim() : '';
    if (sku && name) return `${sku} — ${name}`;
    return sku || name || `ID ${p.id}`;
  };

  const toggleProduct = (product) => {
    const sid = String(product.id);
    setCertForm((prev) => {
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
    setCertForm({
      certificate_number: '',
      document_type: 'certificate',
      product_ids: [],
      products: [],
      valid_from: '',
      valid_to: '',
    });
    setCertProductSearch('');
    setIsCertModalOpen(true);
  };

  const openCertEdit = (c) => {
    setEditingCert(c);
    setCertPhotoFile(null);
    setCertForm({
      certificate_number: c.certificate_number || '',
      document_type: c.document_type || 'certificate',
      product_ids: Array.isArray(c.product_ids) ? c.product_ids.map((x) => String(x)) : [],
      products: Array.isArray(c.products) ? c.products : [],
      valid_from: toDateOnly(c.valid_from),
      valid_to: toDateOnly(c.valid_to),
    });
    setCertProductSearch('');
    setIsCertModalOpen(true);
  };

  const closeCertModal = () => {
    setIsCertModalOpen(false);
    setEditingCert(null);
    setCertPhotoFile(null);
    setCertForm({
      certificate_number: '',
      document_type: 'certificate',
      product_ids: [],
      products: [],
      valid_from: '',
      valid_to: '',
    });
    setCertProductSearch('');
  };

  const saveCert = async (e) => {
    e.preventDefault();
    if (!brand?.id) return;
    const productIds = (certForm.product_ids || []).map((x) => Number(x)).filter((n) => Number.isFinite(n) && n > 0);
    if (productIds.length === 0) {
      alert('Выберите хотя бы один товар');
      return;
    }
    setCertSaving(true);
    try {
      const payload = {
        certificate_number: String(certForm.certificate_number || '').trim(),
        document_type: certForm.document_type || 'certificate',
        brand_id: brand.id,
        product_ids: productIds,
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

      <div className="col-md-6">
        <label className="form-label" htmlFor="brandManufacturerCountry">Страна производителя</label>
        <input
          id="brandManufacturerCountry"
          type="text"
          className="form-control form-control-sm"
          placeholder="Например: Китай"
          value={formData.manufacturerCountry}
          onChange={(e) => handleChange('manufacturerCountry', e.target.value)}
          list="brand-country-list"
        />
        <datalist id="brand-country-list">
          {COUNTRY_OPTIONS.map((c) => (
            <option key={c} value={c} />
          ))}
        </datalist>
        <div style={{ fontSize: '12px', color: 'var(--muted)', marginTop: '4px' }}>
          Подставляется в карточку товара при выборе этого бренда.
        </div>
      </div>

      <div className="col-12">
        <label className="settings-account-toggle" style={{ display: 'flex', gap: '10px', alignItems: 'flex-start', marginBottom: '8px' }}>
          <input
            type="checkbox"
            checked={formData.ozonBrandPromotionEnabled === true}
            onChange={(e) => handleChange('ozonBrandPromotionEnabled', e.target.checked)}
            style={{ marginTop: '4px' }}
          />
          <span>
            <strong>Учитывать «Продвижение бренда» на Ozon в расчёте цены</strong>
            <span style={{ display: 'block', fontSize: '12px', color: 'var(--muted)', fontWeight: 'normal', marginTop: '4px' }}>
              Если включено — процент ниже используется в калькуляторе минимальной цены Ozon, когда API не отдаёт комиссию.
            </span>
          </span>
        </label>
      </div>

      <div className="col-md-6">
        <label className="form-label" htmlFor="brandOzonPromotion">
          Продвижение бренда на Ozon (%)
        </label>
        <input
          id="brandOzonPromotion"
          type="number"
          min="0"
          max="100"
          step="0.01"
          className="form-control form-control-sm"
          placeholder="Например: 1"
          value={formData.ozonBrandPromotionPercent}
          onChange={(e) => handleChange('ozonBrandPromotionPercent', e.target.value)}
          disabled={!formData.ozonBrandPromotionEnabled}
        />
        <div style={{ fontSize: '12px', color: 'var(--muted)', marginTop: '4px' }}>
          Используется в расчёте минимальной цены Ozon, если API не отдаёт этот процент.
        </div>
        {errors.ozonBrandPromotionPercent && <div className="error">{errors.ozonBrandPromotionPercent}</div>}
      </div>

      <div className="col-12" style={{ marginTop: '8px' }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', gap: '10px', flexWrap: 'wrap', alignItems: 'center' }}>
          <div style={{ fontWeight: 600, fontSize: '13px' }}>Бренды на маркетплейсах</div>
          <div style={{ display: 'flex', gap: '8px', flexWrap: 'wrap' }}>
            <Button type="button" variant="secondary" onClick={loadMpCandidates} disabled={!brand?.id}>
              Показать кандидатов
            </Button>
            <Button type="button" variant="primary" onClick={applyMpSync} disabled={!brand?.id || mpSyncLoading}>
              {mpSyncLoading ? 'Загрузка…' : 'Загрузить и сопоставить'}
            </Button>
          </div>
        </div>
        <div style={{ fontSize: '12px', color: 'var(--muted)', marginTop: '6px' }}>
          Сопоставление подставляется в карточку товара при выборе бренда в ERP.
          Для WB и Ozon выбирайте имя из справочника МП (регистр важен). Справочники обновляются каждую ночь.
        </div>
        {!brand?.id && (
          <div style={{ fontSize: '12px', color: 'var(--muted)', marginTop: '6px' }}>
            Сначала сохраните бренд.
          </div>
        )}
        <div className="row g-3" style={{ marginTop: '10px' }}>
          {MP_MARKETPLACES.map(({ key, label }) => (
            <div className="col-md-4" key={key}>
              <div style={{ border: '1px solid var(--border)', borderRadius: '8px', padding: '10px' }}>
                <div style={{ fontWeight: 600, fontSize: '12px', marginBottom: '8px' }}>{label}</div>
                <label className="form-label" style={{ fontSize: '11px' }}>Название на МП</label>
                <MpBrandSuggest
                  marketplace={key}
                  className="form-control form-control-sm"
                  value={mpMappings[key]?.mp_brand_name || ''}
                  onChange={(next) => handleMpMappingChange(key, 'mp_brand_name', next)}
                  onSelect={(opt) => {
                    if (!opt?.name) return;
                    setMpMappings((prev) => ({
                      ...prev,
                      [key]: {
                        ...prev[key],
                        mp_brand_name: opt.name,
                        mp_brand_id: opt.id != null && String(opt.id).trim() !== ''
                          ? String(opt.id)
                          : prev[key]?.mp_brand_id || '',
                      },
                    }));
                  }}
                />
                {key === 'ozon' && (
                  <>
                    <label className="form-label" style={{ fontSize: '11px', marginTop: '8px' }}>ID в справочнике Ozon</label>
                    <input
                      className="form-control form-control-sm"
                      value={mpMappings[key]?.mp_brand_id || ''}
                      onChange={(e) => handleMpMappingChange(key, 'mp_brand_id', e.target.value)}
                      placeholder="dictionary_value_id"
                    />
                  </>
                )}
                {mpCandidates?.[key]?.length > 0 && (
                  <div style={{ marginTop: '8px' }}>
                    <div style={{ fontSize: '11px', color: 'var(--muted)', marginBottom: '4px' }}>Кандидаты:</div>
                    <div style={{ display: 'flex', flexDirection: 'column', gap: '4px' }}>
                      {mpCandidates[key].slice(0, 5).map((c) => (
                        <button
                          key={`${key}-${c.name}-${c.source}`}
                          type="button"
                          className="btn btn-sm btn-outline-secondary"
                          style={{ fontSize: '11px', textAlign: 'left' }}
                          onClick={() => applyCandidate(key, c)}
                        >
                          {c.name}
                          {c.count ? ` (${c.count})` : ''}
                          {c.source === 'ozon_api' || c.source === 'ozon_directory' ? ' · Ozon' : ''}
                          {c.source === 'wb_directory' ? ' · WB' : ''}
                          {c.source === 'ym_directory' ? ' · YM' : ''}
                        </button>
                      ))}
                    </div>
                  </div>
                )}
              </div>
            </div>
          ))}
        </div>
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
        <div style={{ fontSize: '12px', color: 'var(--muted)', marginTop: '6px' }}>
          Полный реестр — в <Link to="/settings/certificates">Настройки → Сертификаты</Link>.
          К каждому документу привязываются конкретные товары бренда.
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
                <th>Товары</th>
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
                    {Array.isArray(c.products) && c.products.length > 0 ? (
                      <div style={{ display: 'flex', gap: '4px', flexWrap: 'wrap' }}>
                        {c.products.slice(0, 3).map((p) => (
                          <span key={p.id} style={{ border: '1px solid var(--border)', borderRadius: '999px', padding: '2px 8px', fontSize: '11px' }}>
                            {p.sku || p.name || p.id}
                          </span>
                        ))}
                        {c.products.length > 3 && (
                          <span style={{ color: 'var(--muted)', fontSize: '11px' }}>+{c.products.length - 3}</span>
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
              <label className="form-label">Товары <span style={{ color: '#ef4444' }}>*</span></label>
              <div style={{ fontSize: '12px', color: 'var(--muted)', marginBottom: '6px' }}>
                Выберите конкретные товары этого бренда.
              </div>
              <input
                className="form-control form-control-sm"
                placeholder="Поиск по артикулу или названию..."
                value={certProductSearch}
                onChange={(e) => setCertProductSearch(e.target.value)}
                style={{ marginBottom: '8px' }}
              />
              <div style={{ border: '1px solid var(--border)', borderRadius: '8px', maxHeight: '180px', overflowY: 'auto', padding: '8px' }}>
                {certProductsLoading ? (
                  <div style={{ fontSize: '12px', color: 'var(--muted)' }}>Загрузка товаров…</div>
                ) : certProductOptions.length === 0 ? (
                  <div style={{ fontSize: '12px', color: 'var(--muted)' }}>Ничего не найдено</div>
                ) : (
                  certProductOptions.map((p) => (
                    <label key={p.id} style={{ display: 'flex', alignItems: 'center', gap: '8px', marginBottom: '6px', cursor: 'pointer' }}>
                      <input
                        type="checkbox"
                        checked={selectedProductSet.has(String(p.id))}
                        onChange={() => toggleProduct(p)}
                      />
                      <span style={{ fontSize: '13px' }}>{productLabel(p)}</span>
                    </label>
                  ))
                )}
              </div>
              {selectedCertProducts.length > 0 && (
                <div style={{ display: 'flex', flexWrap: 'wrap', gap: '6px', marginTop: '8px' }}>
                  {selectedCertProducts.map((p) => (
                    <button
                      key={String(p.id)}
                      type="button"
                      onClick={() => toggleProduct(p)}
                      title="Отвязать товар"
                      aria-label={`Отвязать ${productLabel(p)}`}
                      style={{
                        border: '1px solid var(--border)',
                        borderRadius: '999px',
                        padding: '2px 8px',
                        fontSize: '11px',
                        background: 'transparent',
                        cursor: 'pointer',
                        display: 'inline-flex',
                        alignItems: 'center',
                        gap: '4px',
                      }}
                    >
                      {productLabel(p)}
                      <span aria-hidden="true" style={{ color: 'var(--muted)', fontSize: '14px', lineHeight: 1 }}>×</span>
                    </button>
                  ))}
                </div>
              )}
            </div>
            <div className="col-md-6">
              <label className="form-label">Файл (фото / PDF)</label>
              <input
                className="form-control form-control-sm"
                type="file"
                accept="image/*,.pdf,application/pdf"
                onChange={(e) => setCertPhotoFile(e.target.files?.[0] || null)}
              />
              <div style={{ fontSize: '12px', color: 'var(--muted)', marginTop: '4px' }}>
                Изображение или PDF (до 20 МБ).
              </div>
              {(editingCert?.photo_url || editingCert?.photoUrl) && (
                <div style={{ marginTop: '8px' }}>
                  <a href={editingCert.photo_url || editingCert.photoUrl} target="_blank" rel="noreferrer" style={{ fontSize: '12px' }}>
                    Открыть текущий файл
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

