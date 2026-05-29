/**
 * SupplierForm Component
 * Форма создания/редактирования поставщика
 */

import React, { useState, useEffect } from 'react';
import { Button } from '../../common/Button/Button';
import { supplierPrefixesFromApiConfig } from '../../../utils/supplierArticlePrefixes';

export function SupplierForm({ supplier, onSubmit, onCancel }) {
  const [formData, setFormData] = useState({
    name: '',
    active: true,
    prefixes: [],
    warehouses: []
  });

  const [prefixInput, setPrefixInput] = useState('');

  const [warehouseForm, setWarehouseForm] = useState({
    name: '',
    time: '18:00'
  });
  
  const [errors, setErrors] = useState({});

  useEffect(() => {
    if (supplier) {
      const warehouses = supplier.apiConfig?.warehouses || [];
      setFormData({
        name: supplier.name || '',
        active: supplier.isActive !== undefined ? supplier.isActive : (supplier.active !== undefined ? supplier.active : true),
        prefixes: supplierPrefixesFromApiConfig(supplier.apiConfig || supplier.api_config || {}),
        warehouses: warehouses.map(w => ({ name: w.name || '', time: w.time || '18:00' }))
      });
      setPrefixInput('');
    }
  }, [supplier]);

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
      newErrors.name = 'Введите название поставщика';
    }
    
    setErrors(newErrors);
    return Object.keys(newErrors).length === 0;
  };

  const handleAddWarehouse = () => {
    if (!warehouseForm.name.trim()) {
      alert('Введите название склада');
      return;
    }
    
    setFormData(prev => ({
      ...prev,
      warehouses: [...prev.warehouses, { name: warehouseForm.name.trim(), time: warehouseForm.time }]
    }));
    
    setWarehouseForm({ name: '', time: '18:00' });
  };

  const handleRemoveWarehouse = (index) => {
    setFormData(prev => ({
      ...prev,
      warehouses: prev.warehouses.filter((_, i) => i !== index)
    }));
  };

  const handleAddPrefix = () => {
    const p = prefixInput.trim();
    if (!p) return;
    const key = p.toLowerCase();
    if (formData.prefixes.some((x) => String(x).toLowerCase() === key)) {
      alert('Такой префикс уже добавлен');
      return;
    }
    setFormData((prev) => ({
      ...prev,
      prefixes: [...prev.prefixes, p].sort((a, b) => b.length - a.length),
    }));
    setPrefixInput('');
  };

  const handleRemovePrefix = (index) => {
    setFormData((prev) => ({
      ...prev,
      prefixes: prev.prefixes.filter((_, i) => i !== index),
    }));
  };

  const handleSubmit = (e) => {
    e.preventDefault();
    
    if (!validate()) {
      return;
    }

    const payload = {
      name: formData.name.trim(),
      isActive: formData.active, // Используем isActive для соответствия с API
      apiConfig: {
        prefixes: formData.prefixes.map((p) => String(p).trim()).filter(Boolean),
        warehouses: formData.warehouses.map(w => ({
          name: w.name.trim(),
          time: w.time
        }))
      }
    };
    
    console.log('[SupplierForm] Submitting payload:', payload);

    onSubmit(payload);
  };

  return (
    <form className="supplier-form" onSubmit={handleSubmit}>
      <div className="row g-3">
      <div className="col-md-8">
        <label className="form-label" htmlFor="supplierName">
          Название <span style={{color: '#ef4444'}}>*</span>
        </label>
        <input
          id="supplierName"
          type="text"
          className="form-control form-control-sm"
          placeholder="Например: Mikado, Moskvorechie"
          value={formData.name}
          onChange={(e) => handleChange('name', e.target.value)}
          required
        />
        {errors.name && <div className="error">{errors.name}</div>}
      </div>

      <div className="col-md-4 d-flex align-items-end">
        <div className="form-check">
          <input
            type="checkbox"
            id="supplierActive"
            checked={formData.active}
            onChange={(e) => handleChange('active', e.target.checked)}
            className="form-check-input"
          />
          <label className="form-check-label" htmlFor="supplierActive">Активный поставщик</label>
        </div>
      </div>

      <div className="col-12">
        <label className="form-label">Префиксы артикула</label>
        <p className="text-muted small mb-2">
          При импорте закупки из Excel снимаются указанные префиксы и следующий за ними дефис (например, xmil- + e400058 → e400058).
        </p>
        <div className="d-flex gap-2 flex-wrap mb-2">
          <input
            id="supplierArticlePrefix"
            type="text"
            className="form-control form-control-sm"
            placeholder="Например: MI-"
            value={prefixInput}
            onChange={(e) => setPrefixInput(e.target.value)}
            style={{ flex: 1 }}
            onKeyDown={(e) => {
              if (e.key === 'Enter') {
                e.preventDefault();
                handleAddPrefix();
              }
            }}
          />
          <Button type="button" variant="secondary" onClick={handleAddPrefix} size="small">
            Добавить
          </Button>
        </div>
        {formData.prefixes.length > 0 ? (
          <div className="card">
            <div className="card-body p-2" style={{ display: 'flex', flexDirection: 'column', gap: '8px' }}>
              {formData.prefixes.map((prefix, index) => (
                <div key={`${prefix}-${index}`} className="d-flex align-items-center gap-2 p-2 border rounded">
                  <code style={{ flex: 1, fontSize: '14px' }}>{prefix}</code>
                  <Button
                    type="button"
                    variant="secondary"
                    size="small"
                    onClick={() => handleRemovePrefix(index)}
                  >
                    Удалить
                  </Button>
                </div>
              ))}
            </div>
          </div>
        ) : (
          <div className="alert alert-secondary py-2">Префиксы не добавлены</div>
        )}
      </div>

      <div className="col-12">
        <label className="form-label">Склады поставщика</label>
        <p className="text-muted small mb-2">
          Укажите склады поставщика и время, до которого принимаются заказы для отправки в тот же день
        </p>
        
        <div className="d-flex gap-2 flex-wrap mb-2">
          <input
            type="text"
            className="form-control form-control-sm"
            placeholder="Название склада"
            value={warehouseForm.name}
            onChange={(e) => setWarehouseForm(prev => ({ ...prev, name: e.target.value }))}
            style={{flex: 1}}
            onKeyPress={(e) => {
              if (e.key === 'Enter') {
                e.preventDefault();
                handleAddWarehouse();
              }
            }}
          />
          <input
            type="time"
            className="form-control form-control-sm"
            value={warehouseForm.time}
            onChange={(e) => setWarehouseForm(prev => ({ ...prev, time: e.target.value }))}
            style={{width: '130px'}}
          />
          <Button
            type="button"
            variant="secondary"
            onClick={handleAddWarehouse}
            size="small"
          >
            Добавить
          </Button>
        </div>

        {formData.warehouses.length > 0 ? (
          <div className="card">
            <div className="card-body p-2" style={{ display: 'flex', flexDirection: 'column', gap: '8px' }}>
            {formData.warehouses.map((warehouse, index) => (
              <div key={index} className="d-flex align-items-center gap-2 p-2 border rounded">
                <span style={{flex: 1, fontSize: '14px'}}>
                  <strong>{warehouse.name}</strong> — до {warehouse.time}
                </span>
                <Button
                  type="button"
                  variant="secondary"
                  size="small"
                  onClick={() => handleRemoveWarehouse(index)}
                >
                  Удалить
                </Button>
              </div>
            ))}
            </div>
          </div>
        ) : (
          <div className="alert alert-secondary py-2">Склады не добавлены</div>
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
        <Button type="submit" variant="primary">Сохранить</Button>
      </div>
    </form>
  );
}

