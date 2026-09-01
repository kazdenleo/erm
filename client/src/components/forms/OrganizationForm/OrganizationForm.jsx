/**
 * OrganizationForm Component
 * Форма создания/редактирования организации
 */

import React, { useState, useEffect } from 'react';
import { Button } from '../../common/Button/Button';
import { TAX_SYSTEM_OPTIONS } from '../../../utils/organizationTaxRates.js';

export function OrganizationForm({ organization, onSubmit, onCancel, isAdmin = false, profiles = [] }) {
  const [formData, setFormData] = useState({
    name: '',
    inn: '',
    address: '',
    tax_system: '',
    vat: '',
    article_prefix: '',
    profile_id: '',
    daily_pull_marketplace_cards: false,
  });
  const [errors, setErrors] = useState({});

  const taxSystemOptions = TAX_SYSTEM_OPTIONS;

  const vatOptions = [
    { value: '', label: 'Не указано' },
    { value: 'NO_VAT', label: 'Без НДС' },
    { value: 'VAT_22', label: 'НДС 22%' },
    { value: 'VAT_10', label: 'НДС 10%' },
    { value: 'VAT_7', label: 'НДС 7%' },
    { value: 'VAT_5', label: 'НДС 5%' }
  ];

  useEffect(() => {
    if (organization) {
      setFormData(prev => ({
        ...prev,
        name: organization.name || '',
        inn: organization.inn || '',
        address: organization.address || '',
        tax_system: organization.tax_system || '',
        vat: organization.vat || '',
        article_prefix: organization.article_prefix || '',
        profile_id: organization.profile_id != null ? String(organization.profile_id) : '',
        daily_pull_marketplace_cards: organization.daily_pull_marketplace_cards === true,
      }));
    }
  }, [organization]);

  const handleChange = (field, value) => {
    setFormData(prev => ({ ...prev, [field]: value }));
    if (errors[field]) {
      setErrors(prev => {
        const next = { ...prev };
        delete next[field];
        return next;
      });
    }
  };

  const validate = () => {
    const newErrors = {};
    if (!formData.name || !formData.name.trim()) {
      newErrors.name = 'Введите название организации';
    }
    setErrors(newErrors);
    return Object.keys(newErrors).length === 0;
  };

  const handleSubmit = (e) => {
    e.preventDefault();
    if (!validate()) return;
    const payload = {
      name: formData.name.trim(),
      inn: formData.inn.trim() || null,
      address: formData.address.trim() || null,
      tax_system: formData.tax_system && formData.tax_system.trim() !== '' ? formData.tax_system : null,
      vat: formData.vat && formData.vat.trim() !== '' ? formData.vat : null,
      article_prefix: formData.article_prefix.trim() || null,
      daily_pull_marketplace_cards: formData.daily_pull_marketplace_cards === true,
    };
    if (isAdmin && profiles.length > 0) {
      payload.profile_id = formData.profile_id ? Number(formData.profile_id) : null;
    }
    onSubmit(payload);
  };

  return (
    <form className="organization-form" onSubmit={handleSubmit}>
      <div className="row g-3">
        <div className="col-md-8">
        <label className="form-label" htmlFor="orgName">
          Название <span style={{ color: '#ef4444' }}>*</span>
        </label>
        <input
          id="orgName"
          type="text"
          className="form-control form-control-sm"
          placeholder="ООО «Компания»"
          value={formData.name}
          onChange={(e) => handleChange('name', e.target.value)}
          required
        />
        {errors.name && <div className="error">{errors.name}</div>}
        </div>
        <div className="col-md-4">
        <label className="form-label" htmlFor="orgInn">ИНН</label>
        <input
          id="orgInn"
          type="text"
          className="form-control form-control-sm"
          placeholder="7707123456"
          value={formData.inn}
          onChange={(e) => handleChange('inn', e.target.value)}
        />
        </div>
        <div className="col-md-6">
        <label className="form-label" htmlFor="orgArticlePrefix">Префикс артикулов</label>
        <input
          id="orgArticlePrefix"
          type="text"
          className="form-control form-control-sm"
          placeholder="Напр. ABC- или ORG1-"
          value={formData.article_prefix}
          onChange={(e) => handleChange('article_prefix', e.target.value)}
          maxLength={50}
        />
        <div style={{ fontSize: '12px', color: 'var(--muted)', marginTop: '4px' }}>
          Будет подставляться к артикулам товаров этой организации
        </div>
        </div>
      {isAdmin && profiles.length > 0 && (
        <div className="col-md-6">
          <label className="form-label" htmlFor="orgProfile">Профиль (кабинет)</label>
          <select
            id="orgProfile"
            className="form-select form-select-sm"
            value={formData.profile_id}
            onChange={(e) => handleChange('profile_id', e.target.value)}
          >
            <option value="">— Без профиля —</option>
            {profiles.map(p => (
              <option key={p.id} value={p.id}>{p.name}</option>
            ))}
          </select>
        </div>
      )}
        <div className="col-12">
        <label className="form-label" htmlFor="orgAddress">Адрес</label>
        <textarea
          id="orgAddress"
          className="form-control form-control-sm"
          rows="2"
          placeholder="Юридический адрес"
          value={formData.address}
          onChange={(e) => handleChange('address', e.target.value)}
        />
        </div>
        <div className="col-md-6">
        <label className="form-label" htmlFor="orgTaxSystem">Система налогообложения</label>
        <select
          id="orgTaxSystem"
          className="form-select form-select-sm"
          value={formData.tax_system}
          onChange={(e) => handleChange('tax_system', e.target.value)}
        >
          {taxSystemOptions.map(opt => (
            <option key={opt.value || 'empty'} value={opt.value}>{opt.label}</option>
          ))}
        </select>
        </div>
        <div className="col-md-6">
        <label className="form-label" htmlFor="orgVat">НДС</label>
        <select
          id="orgVat"
          className="form-select form-select-sm"
          value={formData.vat}
          onChange={(e) => handleChange('vat', e.target.value)}
        >
          {vatOptions.map(opt => (
            <option key={opt.value || 'empty'} value={opt.value}>{opt.label}</option>
          ))}
        </select>
        </div>
        <div className="col-12">
          <div className="form-check form-switch mb-0">
            <input
              className="form-check-input"
              type="checkbox"
              role="switch"
              id="orgDailyPullMpCards"
              checked={formData.daily_pull_marketplace_cards === true}
              onChange={(e) => handleChange('daily_pull_marketplace_cards', e.target.checked)}
            />
            <label className="form-check-label" htmlFor="orgDailyPullMpCards">
              Импортировать карточки с маркетплейсов раз в сутки
            </label>
          </div>
          <p className="text-muted small mt-1 mb-0">
            Раз в сутки подтягиваем название, описание, бренд, артикул, габариты и атрибуты с Ozon, Wildberries и Яндекс.Маркет.
            Если данные изменились — появится уведомление по товару; расхождения с «Основным» показываются в карточке.
            Финансовые отчёты FBO/FBS, остатки на складах МП и выкуп подтягиваются ночью автоматически для всех организаций.
          </p>
        </div>
      </div>
      <div className="d-flex justify-content-end gap-2 mt-4">
        <Button type="button" variant="secondary" onClick={onCancel}>Отмена</Button>
        <Button type="submit" variant="primary">{organization ? 'Сохранить' : 'Добавить организацию'}</Button>
      </div>
    </form>
  );
}
