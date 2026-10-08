/**
 * Модалка создания/редактирования клиента
 */

import React, { useState } from 'react';
import { Modal } from '../../components/common/Modal/Modal';
import { CustomerForm } from '../../components/forms/CustomerForm/CustomerForm';
import { customersApi } from '../../services/customers.api';
import { getApiErrorMessage } from '../../utils/apiErrorMessage.js';

export function CustomerEditModal({ isOpen, customer, onClose, onSaved }) {
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState(null);

  const handleClose = () => {
    if (saving) return;
    setError(null);
    onClose();
  };

  const handleSubmit = async (data) => {
    setSaving(true);
    setError(null);
    try {
      const saved = customer?.id
        ? await customersApi.update(customer.id, data)
        : await customersApi.create(data);
      onSaved?.(saved);
    } catch (err) {
      setError(getApiErrorMessage(err, 'Не удалось сохранить клиента'));
    } finally {
      setSaving(false);
    }
  };

  return (
    <Modal
      isOpen={isOpen}
      onClose={handleClose}
      title={customer?.id ? 'Редактировать клиента' : 'Новый клиент'}
      size="large"
    >
      <CustomerForm
        customer={customer}
        onSubmit={handleSubmit}
        onCancel={handleClose}
        saving={saving}
        error={error}
      />
    </Modal>
  );
}
