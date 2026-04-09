/**
 * Organizations Page
 * Управление организациями (в настройках)
 */

import React, { useState, useEffect } from 'react';
import { useOrganizations } from '../../hooks/useOrganizations';
import { useAuth } from '../../context/AuthContext.jsx';
import { profilesApi } from '../../services/profiles.api.js';
import { Button } from '../../components/common/Button/Button';
import { Modal } from '../../components/common/Modal/Modal';
import { OrganizationForm } from '../../components/forms/OrganizationForm/OrganizationForm';
import './Organizations.css';

export function Organizations() {
  const { organizations, loading, error, createOrganization, updateOrganization, deleteOrganization } = useOrganizations();
  const { isAdmin } = useAuth();
  const [profiles, setProfiles] = useState([]);
  const [isModalOpen, setIsModalOpen] = useState(false);
  const [editingOrg, setEditingOrg] = useState(null);

  useEffect(() => {
    if (isAdmin) {
      profilesApi.getAll().then((res) => setProfiles(res?.data ?? [])).catch(() => {});
    }
  }, [isAdmin]);

  const handleCreate = () => {
    setEditingOrg(null);
    setIsModalOpen(true);
  };

  const handleEdit = (org) => {
    setEditingOrg(org);
    setIsModalOpen(true);
  };

  const handleSubmit = async (data) => {
    try {
      if (editingOrg) {
        await updateOrganization(editingOrg.id, data);
      } else {
        await createOrganization(data);
      }
      setIsModalOpen(false);
      setEditingOrg(null);
    } catch (err) {
      console.error('Error saving organization:', err);
      alert('Ошибка сохранения организации: ' + (err.message || err));
    }
  };

  const taxSystemLabel = (code) => {
    const map = { OSN: 'ОСН (общая)', USN_INCOME: 'УСН (доходы)', USN_INCOME_OUTCOME: 'УСН (доходы минус расходы)', PSN: 'ПСН', ESHN: 'ЕСХН', OTHER: 'Иное' };
    return code ? (map[code] || code) : null;
  };
  const vatLabel = (code) => {
    const map = { NO_VAT: 'Без НДС', VAT_22: 'НДС 22%', VAT_10: 'НДС 10%', VAT_7: 'НДС 7%', VAT_5: 'НДС 5%' };
    return code ? (map[code] || code) : null;
  };

  const handleDelete = async (id) => {
    if (!window.confirm('Удалить эту организацию? Товары, склады и приёмки останутся без привязки.')) return;
    try {
      await deleteOrganization(id);
    } catch (err) {
      console.error('Error deleting organization:', err);
      alert('Ошибка удаления организации: ' + (err.message || err));
    }
  };

  if (loading) {
    return <div className="loading">Загрузка организаций...</div>;
  }
  if (error) {
    return <div className="error">Ошибка: {error}</div>;
  }

  return (
    <div className="card">
      <h1 className="title">Организации</h1>
      <p className="subtitle">Организации, к которым привязаны товары, склады и приёмки</p>

      <div className="organizations-list" style={{ marginTop: '16px' }}>
        {organizations.length === 0 ? (
          <div className="empty-state">
            <p>Организаций пока нет</p>
            <Button onClick={handleCreate}>Добавить организацию</Button>
          </div>
        ) : (
          <div>
            {organizations.map(org => (
              <div key={org.id} className="organization-item">
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', flex: 1 }}>
                  <div style={{ flex: 1 }}>
                    <div style={{ fontSize: '14px', fontWeight: 600, marginBottom: '4px' }}>{org.name}</div>
                    {org.inn && <div style={{ fontSize: '13px', color: 'var(--muted)' }}>ИНН: {org.inn}</div>}
                    {(org.tax_system || org.vat) && (
                      <div style={{ fontSize: '12px', color: 'var(--muted)', marginTop: '4px' }}>
                        {[taxSystemLabel(org.tax_system), vatLabel(org.vat)].filter(Boolean).join(' · ')}
                      </div>
                    )}
                    {org.article_prefix && (
                      <div style={{ fontSize: '12px', color: 'var(--muted)', marginTop: '4px' }}>Префикс артикулов: <strong>{org.article_prefix}</strong></div>
                    )}
                    {org.address && <div style={{ fontSize: '12px', color: 'var(--muted)', marginTop: '4px' }}>{org.address}</div>}
                  </div>
                  <div style={{ display: 'flex', gap: '8px' }}>
                    <Button variant="secondary" size="small" onClick={() => handleEdit(org)} style={{ padding: '6px 12px', fontSize: '12px' }}>Изменить</Button>
                    <Button variant="secondary" size="small" onClick={() => handleDelete(org.id)} style={{ padding: '6px 12px', fontSize: '12px', color: '#fca5a5', borderColor: '#fca5a5' }}>Удалить</Button>
                  </div>
                </div>
              </div>
            ))}
          </div>
        )}
      </div>

      <div className="actions" style={{ marginTop: '16px' }}>
        <Button variant="primary" onClick={handleCreate}>Добавить организацию</Button>
      </div>

      <Modal
        isOpen={isModalOpen}
        onClose={() => { setIsModalOpen(false); setEditingOrg(null); }}
        title={editingOrg ? 'Редактировать организацию' : 'Добавить организацию'}
        size="medium"
      >
        <OrganizationForm
          organization={editingOrg}
          onSubmit={handleSubmit}
          onCancel={() => { setIsModalOpen(false); setEditingOrg(null); }}
          isAdmin={isAdmin}
          profiles={profiles}
        />
      </Modal>
    </div>
  );
}
