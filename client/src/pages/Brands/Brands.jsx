/**
 * Brands Page
 * Страница управления брендами
 */

import React, { useState } from 'react';
import { useBrands } from '../../hooks/useBrands';
import { Button } from '../../components/common/Button/Button';
import { Modal } from '../../components/common/Modal/Modal';
import { BrandForm } from '../../components/forms/BrandForm/BrandForm';
import './Brands.css';

export function Brands() {
  const { brands, loading, error, createBrand, updateBrand, deleteBrand } = useBrands();
  const [isModalOpen, setIsModalOpen] = useState(false);
  const [editingBrand, setEditingBrand] = useState(null);

  const handleCreate = () => {
    setEditingBrand(null);
    setIsModalOpen(true);
  };

  const handleEdit = (brand) => {
    setEditingBrand(brand);
    setIsModalOpen(true);
  };

  const handleSubmit = async (brandData) => {
    try {
      if (editingBrand) {
        await updateBrand(editingBrand.id, brandData);
      } else {
        await createBrand(brandData);
      }
      setIsModalOpen(false);
      setEditingBrand(null);
    } catch (error) {
      console.error('Error saving brand:', error);
      alert('Ошибка сохранения бренда: ' + error.message);
    }
  };

  const handleDelete = async (id) => {
    if (window.confirm('Вы уверены, что хотите удалить этот бренд?')) {
      try {
        await deleteBrand(id);
      } catch (error) {
        console.error('Error deleting brand:', error);
        alert('Ошибка удаления бренда: ' + error.message);
      }
    }
  };

  if (loading) {
    return <div className="loading">Загрузка брендов...</div>;
  }

  if (error) {
    return <div className="error">Ошибка: {error}</div>;
  }

  return (
    <div className="card">
      <h1 className="title">🏷️ Бренды</h1>
      <p className="subtitle">Создание и управление брендами товаров</p>

      <div className="brands-list" style={{marginTop: '16px'}}>
        {brands.length === 0 ? (
          <div className="empty-state">
            <p>Брендов пока нет</p>
            <Button onClick={handleCreate}>Добавить первый бренд</Button>
          </div>
        ) : (
          <div>
            {brands.map(brand => (
              <div key={brand.id} className="brand-item">
                <div style={{display: 'flex', justifyContent: 'space-between', alignItems: 'center', flex: 1}}>
                  <div style={{flex: 1}}>
                    <div style={{fontSize: '14px', fontWeight: 600, marginBottom: '4px'}}>
                      {brand.name}
                    </div>
                    {brand.website ? (
                      <a 
                        href={brand.website} 
                        target="_blank" 
                        rel="noopener noreferrer"
                        style={{fontSize: '12px', color: 'var(--primary)', textDecoration: 'none'}}
                      >
                        {brand.website}
                      </a>
                    ) : (
                      <span style={{fontSize: '12px', color: 'var(--muted)'}}>—</span>
                    )}
                  </div>
                  <div style={{display: 'flex', gap: '8px'}}>
                    <Button 
                      variant="secondary" 
                      size="small"
                      onClick={() => handleEdit(brand)}
                      style={{padding: '6px 12px', fontSize: '12px'}}
                    >
                      ✏️
                    </Button>
                    <Button 
                      variant="secondary" 
                      size="small"
                      onClick={() => handleDelete(brand.id)}
                      style={{padding: '6px 12px', fontSize: '12px', color: '#fca5a5', borderColor: '#fca5a5'}}
                    >
                      🗑️
                    </Button>
                  </div>
                </div>
              </div>
            ))}
          </div>
        )}
      </div>

      <div className="actions" style={{marginTop: '16px'}}>
        <Button variant="primary" onClick={handleCreate}>➕ Добавить бренд</Button>
      </div>

      <Modal
        isOpen={isModalOpen}
        onClose={() => {
          setIsModalOpen(false);
          setEditingBrand(null);
        }}
        title={editingBrand ? 'Редактировать бренд' : 'Добавить бренд'}
        size="xl"
      >
        <BrandForm
          brand={editingBrand}
          onSubmit={handleSubmit}
          onCancel={() => {
            setIsModalOpen(false);
            setEditingBrand(null);
          }}
        />
      </Modal>
    </div>
  );
}

