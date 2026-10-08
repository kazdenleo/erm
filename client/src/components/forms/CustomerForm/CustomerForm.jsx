/**
 * CustomerForm Component
 * Форма создания/редактирования клиента
 */

import React, { useEffect, useState } from 'react';
import { Button } from '../../common/Button/Button';

const EMPTY_FORM = {
  name: '',
  phone: '',
  email: '',
  address: '',
  birthday: '',
  source: '',
  notes: '',
};

export function CustomerForm({ customer, onSubmit, onCancel, saving = false, error = null }) {
  const [formData, setFormData] = useState(EMPTY_FORM);
  const [localError, setLocalError] = useState(null);

  useEffect(() => {
    setFormData(
      customer
        ? {
            name: customer.name || '',
            phone: customer.phone || '',
            email: customer.email || '',
            address: customer.address || '',
            birthday: customer.birthday || '',
            source: customer.source || '',
            notes: customer.notes || '',
          }
        : EMPTY_FORM
    );
    setLocalError(null);
  }, [customer]);

  const handleChange = (field, value) => {
    setFormData((prev) => ({ ...prev, [field]: value }));
    if (localError) setLocalError(null);
  };

  const handleSubmit = (e) => {
    e.preventDefault();
    if (!formData.name.trim()) {
      setLocalError('Укажите имя клиента');
      return;
    }
    onSubmit({
      name: formData.name.trim(),
      phone: formData.phone.trim(),
      email: formData.email.trim(),
      address: formData.address.trim(),
      birthday: formData.birthday || null,
      source: formData.source.trim(),
      notes: formData.notes,
    });
  };

  const shownError = localError || error;

  return (
    <form className="customer-form" onSubmit={handleSubmit}>
      <div className="row g-3">
        <div className="col-md-6">
          <label className="form-label" htmlFor="customerName">
            ФИО / название <span style={{ color: '#ef4444' }}>*</span>
          </label>
          <input
            id="customerName"
            type="text"
            className="form-control form-control-sm"
            placeholder="Иванов Иван Иванович"
            value={formData.name}
            onChange={(e) => handleChange('name', e.target.value)}
            autoFocus
            required
          />
        </div>
        <div className="col-md-6">
          <label className="form-label" htmlFor="customerPhone">Телефон</label>
          <input
            id="customerPhone"
            type="tel"
            className="form-control form-control-sm"
            placeholder="+7 …"
            value={formData.phone}
            onChange={(e) => handleChange('phone', e.target.value)}
          />
        </div>
        <div className="col-md-6">
          <label className="form-label" htmlFor="customerEmail">Email</label>
          <input
            id="customerEmail"
            type="email"
            className="form-control form-control-sm"
            placeholder="name@example.ru"
            value={formData.email}
            onChange={(e) => handleChange('email', e.target.value)}
          />
        </div>
        <div className="col-md-3">
          <label className="form-label" htmlFor="customerBirthday">Дата рождения</label>
          <input
            id="customerBirthday"
            type="date"
            className="form-control form-control-sm"
            value={formData.birthday}
            onChange={(e) => handleChange('birthday', e.target.value)}
          />
        </div>
        <div className="col-md-3">
          <label className="form-label" htmlFor="customerSource">Источник</label>
          <input
            id="customerSource"
            type="text"
            className="form-control form-control-sm"
            placeholder="Авито, сайт, звонок…"
            value={formData.source}
            onChange={(e) => handleChange('source', e.target.value)}
          />
        </div>
        <div className="col-12">
          <label className="form-label" htmlFor="customerAddress">Адрес доставки</label>
          <input
            id="customerAddress"
            type="text"
            className="form-control form-control-sm"
            placeholder="Город, улица, дом, квартира"
            value={formData.address}
            onChange={(e) => handleChange('address', e.target.value)}
          />
        </div>
        <div className="col-12">
          <label className="form-label" htmlFor="customerNotes">Заметки</label>
          <textarea
            id="customerNotes"
            className="form-control form-control-sm"
            rows={3}
            placeholder="Предпочтения, договорённости, реквизиты…"
            value={formData.notes}
            onChange={(e) => handleChange('notes', e.target.value)}
          />
        </div>
      </div>

      {shownError ? (
        <div className="error" style={{ marginTop: '12px' }}>{shownError}</div>
      ) : null}

      <div className="d-flex justify-content-end gap-2 mt-4">
        <Button type="button" variant="secondary" onClick={onCancel} disabled={saving}>Отмена</Button>
        <Button type="submit" variant="primary" disabled={saving}>
          {saving ? 'Сохранение...' : 'Сохранить'}
        </Button>
      </div>
    </form>
  );
}
