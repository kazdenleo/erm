/**
 * SupplierForm Component
 * Форма создания/редактирования поставщика
 */

import React, { useState, useEffect } from 'react';
import { Button } from '../../common/Button/Button';
import { supplierPrefixesFromApiConfig } from '../../../utils/supplierArticlePrefixes';
import {
  autoOrderSettingsFromApiConfig,
  autoOrderSettingsToApiConfig,
} from '../../../utils/supplierAutoOrderSettings';
import {
  mapSupplierWarehouseFromApi,
  normalizeSupplierWarehouseArrivalDay,
  normalizeWarehouseTime,
  SUPPLIER_ARRIVAL_OPTIONS,
  SUPPLIER_ARRIVAL_TODAY,
  warehouseRowToPayload,
} from '../../../utils/supplierWarehouseArrival';

export function SupplierForm({ supplier, onSubmit, onCancel }) {
  const [formData, setFormData] = useState({
    name: '',
    active: true,
    prefixes: [],
    warehouses: [],
    minOrderAmount: '',
    isPriority: false,
    autoOrdersEnabled: false,
  });

  const [prefixInput, setPrefixInput] = useState('');

  const [warehouseForm, setWarehouseForm] = useState({
    name: '',
    timeAfter: '09:00',
    time: '18:00',
    arrivalDay: SUPPLIER_ARRIVAL_TODAY,
  });
  
  const [errors, setErrors] = useState({});

  useEffect(() => {
    if (supplier) {
      const apiCfg = supplier.apiConfig || supplier.api_config || {};
      const warehouses = apiCfg.warehouses || [];
      const auto = autoOrderSettingsFromApiConfig(apiCfg);
      setFormData({
        name: supplier.name || '',
        active: supplier.isActive !== undefined ? supplier.isActive : (supplier.active !== undefined ? supplier.active : true),
        prefixes: supplierPrefixesFromApiConfig(apiCfg),
        warehouses: warehouses.map(mapSupplierWarehouseFromApi),
        minOrderAmount: auto.minOrderAmount != null ? String(auto.minOrderAmount) : '',
        isPriority: auto.isPriority,
        autoOrdersEnabled: auto.autoOrdersEnabled,
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
    const minRaw = String(formData.minOrderAmount ?? '').trim();
    if (minRaw !== '') {
      const n = Number(minRaw.replace(',', '.'));
      if (!Number.isFinite(n) || n < 0) {
        newErrors.minOrderAmount = 'Укажите неотрицательную сумму';
      }
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
      warehouses: [
        ...prev.warehouses,
        {
          name: warehouseForm.name.trim(),
          timeAfter: warehouseForm.timeAfter,
          time: warehouseForm.time,
          arrivalDay: normalizeSupplierWarehouseArrivalDay(warehouseForm.arrivalDay),
        },
      ],
    }));

    setWarehouseForm({
      name: '',
      timeAfter: '09:00',
      time: '18:00',
      arrivalDay: SUPPLIER_ARRIVAL_TODAY,
    });
  };

  const handleRemoveWarehouse = (index) => {
    setFormData(prev => ({
      ...prev,
      warehouses: prev.warehouses.filter((_, i) => i !== index)
    }));
  };

  const handleWarehouseChange = (index, field, value) => {
    setFormData((prev) => ({
      ...prev,
      warehouses: prev.warehouses.map((w, i) =>
        i === index
          ? {
              ...w,
              [field]:
                field === 'arrivalDay'
                  ? normalizeSupplierWarehouseArrivalDay(value)
                  : field === 'time' || field === 'timeAfter'
                    ? normalizeWarehouseTime(value, field === 'time' ? '18:00' : '')
                    : value,
            }
          : w
      ),
    }));
  };

  const buildWarehousesPayload = () => {
    const rows = formData.warehouses.map(warehouseRowToPayload);
    const pendingName = warehouseForm.name.trim();
    if (pendingName) {
      const duplicate = rows.some(
        (r) => r.name.toLowerCase() === pendingName.toLowerCase()
      );
      if (!duplicate) {
        rows.push(warehouseRowToPayload(warehouseForm));
      }
    }
    return rows;
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

    const minRaw = String(formData.minOrderAmount ?? '').trim();
    const minParsed = minRaw === '' ? null : Number(minRaw.replace(',', '.'));

    const payload = {
      name: formData.name.trim(),
      isActive: formData.active,
      apiConfig: autoOrderSettingsToApiConfig(
        {
          prefixes: formData.prefixes.map((p) => String(p).trim()).filter(Boolean),
          warehouses: buildWarehousesPayload(),
        },
        {
          minOrderAmount: minParsed,
          isPriority: formData.isPriority,
          autoOrdersEnabled: formData.autoOrdersEnabled,
        }
      ),
    };

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
        <h6 className="mb-2 mt-1">Закупка</h6>
        <div className="form-check mb-3">
          <input
            type="checkbox"
            id="supplierPriority"
            checked={formData.isPriority}
            onChange={(e) => handleChange('isPriority', e.target.checked)}
            className="form-check-input"
          />
          <label className="form-check-label" htmlFor="supplierPriority">
            Приоритетный поставщик
          </label>
        </div>
        <p className="text-muted small mb-0">
          При выборе поставщика для заказа и автозакупки приоритетный идёт раньше остальных (при прочих равных — по цене и остатку).
          Не зависит от автоматической отправки заказов в API.
        </p>
      </div>

      <div className="col-12">
        <h6 className="mb-2 mt-1">Автоматические заказы</h6>
        <p className="text-muted small mb-2">
          По расписанию (каждые ~2 мин): дефицит по заказам → открытая закупка в ERP → отправка в API
          поставщика (Микадо / Москворечье), если API настроен. Без API создаётся только закупка в ERP.
        </p>
        <div className="form-check mb-3">
          <input
            type="checkbox"
            id="supplierAutoOrders"
            checked={formData.autoOrdersEnabled}
            onChange={(e) => handleChange('autoOrdersEnabled', e.target.checked)}
            className="form-check-input"
          />
          <label className="form-check-label" htmlFor="supplierAutoOrders">
            Включить автоматическую отправку заказов
          </label>
        </div>
        <div className="row g-3">
          <div className="col-md-6">
            <label className="form-label" htmlFor="supplierMinOrderAmount">
              Минимальная сумма для заказа, ₽
            </label>
            <input
              id="supplierMinOrderAmount"
              type="number"
              min="0"
              step="0.01"
              className="form-control form-control-sm"
              placeholder="Не задано"
              value={formData.minOrderAmount}
              onChange={(e) => handleChange('minOrderAmount', e.target.value)}
              disabled={!formData.autoOrdersEnabled}
            />
            {errors.minOrderAmount && <div className="error">{errors.minOrderAmount}</div>}
            <div className="form-text">
              Новая закупка и отправка поставщику — когда сумма накопленных позиций достигнет порога
              (или сразу, если порог не задан). Дозаполнение уже открытой закупки не ждёт порог.
            </div>
          </div>
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
          Окно приёма заказа: <strong>после</strong> и <strong>до</strong> (время); справа — когда приедёт товар при заказе в этом окне.
        </p>

        <div className="d-flex gap-2 flex-wrap mb-2 align-items-center">
          <input
            type="text"
            className="form-control form-control-sm"
            placeholder="Название склада"
            value={warehouseForm.name}
            onChange={(e) => setWarehouseForm(prev => ({ ...prev, name: e.target.value }))}
            style={{ flex: 1, minWidth: '140px' }}
            onKeyPress={(e) => {
              if (e.key === 'Enter') {
                e.preventDefault();
                handleAddWarehouse();
              }
            }}
          />
          <div className="d-flex align-items-center gap-1">
            <span className="text-muted small text-nowrap">после</span>
            <input
              type="time"
              className="form-control form-control-sm"
              value={warehouseForm.timeAfter || '09:00'}
              onChange={(e) => setWarehouseForm((prev) => ({ ...prev, timeAfter: e.target.value }))}
              style={{ width: '130px' }}
              title="Заказ принимается с этого времени"
            />
          </div>
          <div className="d-flex align-items-center gap-1">
            <span className="text-muted small text-nowrap">до</span>
            <input
              type="time"
              className="form-control form-control-sm"
              value={warehouseForm.time}
              onChange={(e) => setWarehouseForm((prev) => ({ ...prev, time: e.target.value }))}
              style={{ width: '130px' }}
              title="Заказ принимается до этого времени"
            />
          </div>
          <div className="d-flex align-items-center gap-1">
            <span className="text-muted small text-nowrap">приедет</span>
            <select
              className="form-select form-select-sm"
              value={warehouseForm.arrivalDay}
              onChange={(e) =>
                setWarehouseForm((prev) => ({ ...prev, arrivalDay: e.target.value }))
              }
              style={{ width: '120px' }}
              title="Когда приедёт товар"
            >
              {SUPPLIER_ARRIVAL_OPTIONS.map((opt) => (
                <option key={opt.value} value={opt.value}>
                  {opt.label}
                </option>
              ))}
            </select>
          </div>
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
              <div
                key={`${warehouse.name}-${index}`}
                className="d-flex flex-wrap align-items-center gap-2 p-2 border rounded"
              >
                <strong style={{ minWidth: '100px', fontSize: '14px' }}>{warehouse.name}</strong>
                <div className="d-flex align-items-center gap-1">
                  <span className="text-muted small text-nowrap">после</span>
                  <input
                    type="time"
                    className="form-control form-control-sm"
                    value={warehouse.timeAfter || '09:00'}
                    onChange={(e) => handleWarehouseChange(index, 'timeAfter', e.target.value)}
                    style={{ width: '130px' }}
                  />
                </div>
                <div className="d-flex align-items-center gap-1">
                  <span className="text-muted small text-nowrap">до</span>
                  <input
                    type="time"
                    className="form-control form-control-sm"
                    value={warehouse.time}
                    onChange={(e) => handleWarehouseChange(index, 'time', e.target.value)}
                    style={{ width: '130px' }}
                  />
                </div>
                <div className="d-flex align-items-center gap-1">
                  <span className="text-muted small text-nowrap">приедет</span>
                  <select
                    className="form-select form-select-sm"
                    value={normalizeSupplierWarehouseArrivalDay(warehouse.arrivalDay)}
                    onChange={(e) => handleWarehouseChange(index, 'arrivalDay', e.target.value)}
                    style={{ width: '120px' }}
                  >
                    {SUPPLIER_ARRIVAL_OPTIONS.map((opt) => (
                      <option key={opt.value} value={opt.value}>
                        {opt.label}
                      </option>
                    ))}
                  </select>
                </div>
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

