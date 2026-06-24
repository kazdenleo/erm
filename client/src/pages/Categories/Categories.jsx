/**
 * Categories Page
 * Страница управления категориями
 */

import React, { useState, useEffect, useMemo } from 'react';
import { useUserCategories } from '../../hooks/useUserCategories';
import { categoryMappingsApi } from '../../services/categoryMappings.api';
import { userCategoriesApi } from '../../services/userCategories.api';
import { productAttributesApi } from '../../services/productAttributes.api';
import { productsApi } from '../../services/products.api';
import { Button } from '../../components/common/Button/Button';
import { Modal } from '../../components/common/Modal/Modal';
import { CategoryForm } from '../../components/forms/CategoryForm/CategoryForm';
import {
  enrichUserCategoriesWithMappings,
  getCategoryMarketplaceLinkBadges,
} from '../../utils/enrichUserCategories';
import api from '../../services/api';
import './Categories.css';

function CategoryMpBadges({ category }) {
  const badges = getCategoryMarketplaceLinkBadges(category);
  if (!badges.length) return null;
  return (
    <span className="category-mp-link-badges" aria-label="Сопоставлено с маркетплейсами">
      {badges.map((b) => (
        <span key={b.key} className={`mp-badge ${b.className}`} title={b.title}>
          {b.label}
        </span>
      ))}
    </span>
  );
}

export function Categories() {
  const { categories, mappings, loading, error, createCategory, updateCategory, deleteCategory, loadData } = useUserCategories();
  const [isModalOpen, setIsModalOpen] = useState(false);
  const [editingCategory, setEditingCategory] = useState(null);
  const [categoryForForm, setCategoryForForm] = useState(null);
  const [allAttributes, setAllAttributes] = useState([]);
  const [categoriesWithMappings, setCategoriesWithMappings] = useState([]);

  const wbNameMap = useMemo(() => new Map(), []);

  // Атрибуты — только при открытии формы (не блокируют список)
  useEffect(() => {
    if (!isModalOpen || allAttributes.length > 0) return undefined;
    let cancelled = false;
    productAttributesApi
      .getAll()
      .then((res) => {
        if (!cancelled) setAllAttributes(res?.data || []);
      })
      .catch((e) => {
        if (!cancelled) console.error('[Categories] Error loading attributes:', e);
      });
    return () => {
      cancelled = true;
    };
  }, [isModalOpen, allAttributes.length]);

  // Сопоставления из marketplace_mappings — сразу, без ожидания API
  useEffect(() => {
    if (!categories.length) {
      setCategoriesWithMappings([]);
      return;
    }
    setCategoriesWithMappings((prev) => {
      const counts = {};
      for (const c of prev) {
        if (c?.id != null && c.productsCount > 0) counts[String(c.id)] = c.productsCount;
      }
      return enrichUserCategoriesWithMappings(categories, mappings, {}, { wbNameMap }).map((c) => ({
        ...c,
        productsCount: counts[String(c.id)] ?? c.productsCount ?? 0,
      }));
    });
  }, [categories, mappings, wbNameMap]);

  // Счётчики товаров — отдельный лёгкий запрос
  useEffect(() => {
    let cancelled = false;
    if (!categories.length) return undefined;

    productsApi
      .getProductIdsGroupedByUserCategory()
      .then((groupedRes) => {
        if (cancelled) return;
        const productIdsByCategory =
          groupedRes?.data && typeof groupedRes.data === 'object' ? groupedRes.data : {};
        setCategoriesWithMappings(
          enrichUserCategoriesWithMappings(categories, mappings, productIdsByCategory, { wbNameMap })
        );
      })
      .catch((err) => {
        if (!cancelled) console.error('[Categories] Error loading product counts:', err);
      });

    return () => {
      cancelled = true;
    };
  }, [categories, mappings, wbNameMap]);

  const handleCreate = () => {
    setEditingCategory(null);
    setCategoryForForm(null);
    setIsModalOpen(true);
  };

  const handleEdit = async (category) => {
    setEditingCategory(category);
    setCategoryForForm(null);
    setIsModalOpen(true);
    try {
      const res = await userCategoriesApi.getById(category.id);
      const full = res?.data ?? res;
      if (full && full.id) {
        setCategoryForForm({
          ...full,
          mappings: category.mappings ?? full.mappings,
          productsCount: category.productsCount ?? full.productsCount,
        });
      }
    } catch (e) {
      console.error('[Categories] Error loading category for edit:', e);
    }
  };

  const categoryForFormMerged = useMemo(() => {
    const base = categoryForForm ?? editingCategory;
    if (!base) return null;
    return {
      ...base,
      mappings: editingCategory?.mappings ?? base.mappings,
    };
  }, [categoryForForm, editingCategory]);

  const handleSubmit = async (categoryData) => {
    try {
      // Извлекаем данные о маппингах из payload
      const { marketplaceMappings, ...categoryPayload } = categoryData;

      // При редактировании сразу отправляем сопоставления в теле обновления категории
      if (editingCategory && marketplaceMappings != null) {
        categoryPayload.marketplace_mappings = {
          wb: marketplaceMappings.wb ?? null,
          ozon: marketplaceMappings.ozon ?? null,
          ym: marketplaceMappings.ym ?? null,
          ...(marketplaceMappings.ozon_display ? { ozon_display: marketplaceMappings.ozon_display } : {}),
          ...(marketplaceMappings.ozon_description_category_id != null && marketplaceMappings.ozon_type_id != null
            ? { ozon_description_category_id: marketplaceMappings.ozon_description_category_id, ozon_type_id: marketplaceMappings.ozon_type_id }
            : {})
        };
      }
      
      // attribute_ids уходит в API вместе с categoryPayload
      let savedCategory;
      if (editingCategory) {
        savedCategory = await updateCategory(editingCategory.id, categoryPayload);
      } else {
        savedCategory = await createCategory(categoryPayload);
      }
      
      // ID категории: учитываем и обёртку { ok, data }, и сам объект категории
      const categoryId = (savedCategory && (savedCategory.data && savedCategory.data.id != null ? savedCategory.data.id : savedCategory.id)) ?? editingCategory?.id;
      
      // Сохраняем маппинги маркетплейсов (даже если выбрана только одна категория)
      if (categoryId && marketplaceMappings !== undefined && marketplaceMappings !== null) {
        console.log('[Categories] Saving mappings:', { categoryId, marketplaceMappings });
        try {
          // Получаем товары этой категории
          const productsResponse = await api.get('/products');
          const allProducts = productsResponse.data?.data || [];
          
          console.log('[Categories] All products count:', allProducts.length);
          console.log('[Categories] Looking for categoryId:', categoryId, 'category name:', editingCategory?.name || savedCategory?.name);
          console.log('[Categories] Sample products user_category_id:', allProducts.slice(0, 5).map(p => ({
            id: p.id,
            name: p.name,
            user_category_id: p.user_category_id,
            categoryId: p.categoryId,
            user_category_id_type: typeof p.user_category_id,
            categoryId_type: typeof p.categoryId
          })));
          
          // Ищем товары по новому ID (user_category_id) или старому ID (categoryId)
          const categoryProducts = allProducts.filter(p => {
            const productCategoryId = p.user_category_id || p.categoryId;
            return productCategoryId === categoryId || 
                   String(productCategoryId) === String(categoryId) ||
                   Number(productCategoryId) === Number(categoryId);
          });

          console.log('[Categories] Category products:', categoryProducts.length);
          console.log('[Categories] Found products:', categoryProducts.map(p => ({
            id: p.id,
            name: p.name,
            user_category_id: p.user_category_id,
            categoryId: p.categoryId
          })));

          // Если у категории нет товаров, сопоставления хранятся только в категории
          if (categoryProducts.length === 0) {
            const savedMappings = [];
            if (marketplaceMappings.wb) savedMappings.push('Wildberries');
            if (marketplaceMappings.ozon) savedMappings.push('Ozon');
            if (marketplaceMappings.ym) savedMappings.push('Яндекс.Маркет');

            // При создании новой категории сопоставления ещё не ушли — отправляем отдельным запросом
            if (!editingCategory && categoryId) {
              try {
                const categoryUpdatePayload = {
                  marketplace_mappings: {
                    wb: marketplaceMappings.wb || null,
                    ozon: marketplaceMappings.ozon || null,
                    ym: marketplaceMappings.ym || null,
                    ...(marketplaceMappings.ozon_display ? { ozon_display: marketplaceMappings.ozon_display } : {}),
                    ...(marketplaceMappings.ozon_description_category_id != null && marketplaceMappings.ozon_type_id != null
                      ? { ozon_description_category_id: marketplaceMappings.ozon_description_category_id, ozon_type_id: marketplaceMappings.ozon_type_id }
                      : {})
                  }
                };
                await api.put(`/user-categories/${categoryId}`, categoryUpdatePayload);
              } catch (err) {
                console.error('[Categories] Error saving marketplace_mappings to category:', err);
                alert(`Категория сохранена, но не удалось сохранить сопоставления:\n${err.response?.data?.error || err.message}`);
              }
            }
            if (savedMappings.length > 0) {
              alert(`Сопоставление категорий сохранено!\n\nСопоставления для: ${savedMappings.join(', ')}\n\nСопоставления будут применены к товарам, когда вы добавите их в эту категорию.`);
            }
            setIsModalOpen(false);
            setEditingCategory(null);
            await loadData();
            return;
          }

          // Создаем/обновляем маппинги для всех товаров категории
          for (const product of categoryProducts) {
            // WB
            if (marketplaceMappings.wb !== null && marketplaceMappings.wb !== undefined) {
              try {
                const existingMappings = await categoryMappingsApi.getByProduct(product.id);
                const existingWbMapping = (existingMappings.data?.data || existingMappings.data || []).find(
                  m => m.marketplace === 'wb'
                );

                if (existingWbMapping) {
                  // Убеждаемся, что category_id - это число
                  const categoryId = typeof marketplaceMappings.wb === 'string' 
                    ? parseInt(marketplaceMappings.wb, 10) 
                    : Number(marketplaceMappings.wb);
                  
                  if (isNaN(categoryId) || categoryId <= 0) {
                    console.error(`[Categories] Invalid category_id for product ${product.id}:`, marketplaceMappings.wb);
                    throw new Error(`Некорректный ID категории: ${marketplaceMappings.wb}`);
                  }
                  
                  console.log(`[Categories] Updating WB mapping for product ${product.id}:`, {
                    mappingId: existingWbMapping.id,
                    oldCategoryId: existingWbMapping.category_id,
                    newCategoryId: categoryId,
                    newCategoryIdType: typeof categoryId
                  });
                  await categoryMappingsApi.update(existingWbMapping.id, {
                    category_id: categoryId
                  });
                  console.log(`[Categories] WB mapping updated successfully for product ${product.id}`);
                } else {
                  // Убеждаемся, что category_id - это число
                  const categoryId = typeof marketplaceMappings.wb === 'string' 
                    ? parseInt(marketplaceMappings.wb, 10) 
                    : Number(marketplaceMappings.wb);
                  
                  if (isNaN(categoryId) || categoryId <= 0) {
                    console.error(`[Categories] Invalid category_id for product ${product.id}:`, marketplaceMappings.wb);
                    throw new Error(`Некорректный ID категории: ${marketplaceMappings.wb}`);
                  }
                  
                  console.log(`[Categories] Creating new WB mapping for product ${product.id}:`, {
                    product_id: product.id,
                    marketplace: 'wb',
                    category_id: categoryId,
                    categoryIdType: typeof categoryId
                  });
                  await categoryMappingsApi.create({
                    product_id: product.id,
                    marketplace: 'wb',
                    category_id: categoryId
                  });
                  console.log(`[Categories] WB mapping created successfully for product ${product.id}`);
                }
              } catch (err) {
                console.error(`[Categories] Error saving WB mapping for product ${product.id}:`, err);
                console.error('[Categories] Error details:', err.response?.data || err.message);
              }
            } else if (marketplaceMappings.wb === null) {
              // Если категория убрана (null), удаляем маппинг
              try {
                const existingMappings = await categoryMappingsApi.getByProduct(product.id);
                const existingWbMapping = (existingMappings.data?.data || existingMappings.data || []).find(
                  m => m.marketplace === 'wb'
                );
                if (existingWbMapping) {
                  await categoryMappingsApi.delete(existingWbMapping.id);
                  console.log(`[Categories] WB mapping deleted for product ${product.id}`);
                }
              } catch (err) {
                console.error(`[Categories] Error deleting WB mapping for product ${product.id}:`, err);
              }
            }

            // Ozon
            if (marketplaceMappings.ozon !== null && marketplaceMappings.ozon !== undefined) {
              try {
                const existingMappings = await categoryMappingsApi.getByProduct(product.id);
                const existingOzonMapping = (existingMappings.data?.data || existingMappings.data || []).find(
                  m => m.marketplace === 'ozon'
                );

                if (existingOzonMapping) {
                  // Для Ozon category_id должен быть строкой (VARCHAR в БД)
                  // Ozon использует description_category_id как строку
                  const categoryId = String(marketplaceMappings.ozon || '');
                  
                  if (!categoryId || categoryId === 'undefined' || categoryId === 'null' || categoryId === '0') {
                    console.error(`[Categories] Invalid Ozon category_id for product ${product.id}:`, marketplaceMappings.ozon);
                    throw new Error(`Некорректный ID категории Ozon: ${marketplaceMappings.ozon}`);
                  }
                  
                  console.log(`[Categories] Updating Ozon mapping for product ${product.id}:`, {
                    mappingId: existingOzonMapping.id,
                    oldCategoryId: existingOzonMapping.category_id,
                    newCategoryId: categoryId,
                    newCategoryIdType: typeof categoryId
                  });
                  
                  await categoryMappingsApi.update(existingOzonMapping.id, {
                    category_id: categoryId
                  });
                  console.log(`[Categories] Ozon mapping updated successfully for product ${product.id}`);
                } else {
                  // Для Ozon category_id должен быть строкой (VARCHAR в БД)
                  const categoryId = String(marketplaceMappings.ozon || '');
                  
                  if (!categoryId || categoryId === 'undefined' || categoryId === 'null' || categoryId === '0') {
                    console.error(`[Categories] Invalid Ozon category_id for product ${product.id}:`, marketplaceMappings.ozon);
                    throw new Error(`Некорректный ID категории Ozon: ${marketplaceMappings.ozon}`);
                  }
                  
                  console.log(`[Categories] Creating new Ozon mapping for product ${product.id}:`, {
                    product_id: product.id,
                    marketplace: 'ozon',
                    category_id: categoryId,
                    categoryIdType: typeof categoryId
                  });
                  
                  await categoryMappingsApi.create({
                    product_id: product.id,
                    marketplace: 'ozon',
                    category_id: categoryId
                  });
                  console.log(`[Categories] Ozon mapping created successfully for product ${product.id}`);
                }
              } catch (err) {
                console.error(`[Categories] Error saving Ozon mapping for product ${product.id}:`, err);
                console.error('[Categories] Error details:', err.response?.data || err.message);
              }
            } else if (marketplaceMappings.ozon === null) {
              // Если категория убрана (null), удаляем маппинг
              try {
                const existingMappings = await categoryMappingsApi.getByProduct(product.id);
                const existingOzonMapping = (existingMappings.data?.data || existingMappings.data || []).find(
                  m => m.marketplace === 'ozon'
                );
                if (existingOzonMapping) {
                  await categoryMappingsApi.delete(existingOzonMapping.id);
                  console.log(`[Categories] Ozon mapping deleted for product ${product.id}`);
                }
              } catch (err) {
                console.error(`[Categories] Error deleting Ozon mapping for product ${product.id}:`, err);
              }
            }

            // Yandex Market
            if (marketplaceMappings.ym) {
              try {
                const existingMappings = await categoryMappingsApi.getByProduct(product.id);
                const existingYmMapping = (existingMappings.data?.data || existingMappings.data || []).find(
                  m => m.marketplace === 'ym'
                );

                if (existingYmMapping) {
                  await categoryMappingsApi.update(existingYmMapping.id, {
                    category_id: marketplaceMappings.ym
                  });
                } else {
                  await categoryMappingsApi.create({
                    product_id: product.id,
                    marketplace: 'ym',
                    category_id: marketplaceMappings.ym
                  });
                }
              } catch (err) {
                console.error(`[Categories] Error saving YM mapping for product ${product.id}:`, err);
              }
            }
          }
          
          // Всегда сохраняем сопоставления и в саму категорию — чтобы форма и новые товары видели их
          try {
            await api.put(`/user-categories/${categoryId}`, {
              marketplace_mappings: {
                wb: marketplaceMappings.wb ?? null,
                ozon: marketplaceMappings.ozon ?? null,
                ym: marketplaceMappings.ym ?? null,
                ...(marketplaceMappings.ozon_display ? { ozon_display: marketplaceMappings.ozon_display } : {}),
                ...(marketplaceMappings.ozon_description_category_id != null && marketplaceMappings.ozon_type_id != null
                  ? { ozon_description_category_id: marketplaceMappings.ozon_description_category_id, ozon_type_id: marketplaceMappings.ozon_type_id }
                  : {})
              }
            });
          } catch (err) {
            console.warn('[Categories] Could not save marketplace_mappings to category:', err);
          }

          console.log('[Categories] All mappings saved successfully');
          const savedMappings = [];
          if (marketplaceMappings.wb) savedMappings.push('Wildberries');
          if (marketplaceMappings.ozon) savedMappings.push('Ozon');
          if (marketplaceMappings.ym) savedMappings.push('Яндекс.Маркет');
          
          if (savedMappings.length > 0) {
            alert(`Категория и сопоставления успешно сохранены!\n\nСопоставления сохранены для: ${savedMappings.join(', ')}\n\nПрименено к ${categoryProducts.length} товару(ам) в категории.`);
          }
        } catch (error) {
          console.error('[Categories] Error saving mappings:', error);
          const errorMessage = error.response?.data?.message || error.message || 'Неизвестная ошибка';
          alert(`Категория сохранена, но произошла ошибка при сохранении сопоставлений:\n\n${errorMessage}\n\nПроверьте консоль браузера (F12) для подробностей.`);
        }
      }
      
      setIsModalOpen(false);
      setEditingCategory(null);
      setCategoryForForm(null);
      await loadData(); // Перезагружаем данные после сохранения
      return savedCategory;
    } catch (error) {
      console.error('Error saving category:', error);
      alert('Ошибка сохранения категории: ' + error.message);
      throw error;
    }
  };

  const handleDelete = async (id) => {
    if (window.confirm('Вы уверены, что хотите удалить эту категорию? Все подкатегории также будут удалены.')) {
      try {
        await deleteCategory(id);
        await loadData(); // Перезагружаем данные после удаления
      } catch (error) {
        console.error('Error deleting category:', error);
        alert('Ошибка удаления категории: ' + error.message);
      }
    }
  };

  if (loading) {
    return <div className="loading">Загрузка категорий...</div>;
  }

  if (error) {
    return <div className="error">Ошибка: {error}</div>;
  }

  // Пока enrich не отработал — показываем хотя бы список из categories (счётчики и маппинги догрузятся)
  const listForTree =
    categoriesWithMappings.length > 0
      ? categoriesWithMappings
      : categories.map((c) => ({
          ...c,
          productsCount: 0,
          mappings: {},
        }));

  const parentCategories = listForTree.filter((cat) => !cat.parent_id);
  const subCategories = listForTree.filter((cat) => cat.parent_id);

  return (
    <div className="card">
      <div className="categories-page-header">
        <div className="categories-page-header__main">
          <h1 className="title">📦 Категории</h1>
          <p className="subtitle">Создание категорий и сопоставление с маркетплейсами — настройки и комиссии в карточке категории</p>
        </div>
        <div className="categories-page-header__actions">
          <Button variant="primary" onClick={handleCreate}>➕ Добавить категорию</Button>
        </div>
      </div>

      <div className="categories-list" style={{marginTop: '16px'}}>
        {categories.length === 0 ? (
          <div className="empty-state">
            <p>Категорий пока нет</p>
            <Button onClick={handleCreate}>Добавить первую категорию</Button>
          </div>
        ) : (
          <div>
            {parentCategories.map(category => {
              const children = subCategories.filter(sub => sub.parent_id === category.id);
              
              return (
                <div
                  key={category.id}
                  className="category-item category-item--clickable"
                  onClick={() => handleEdit(category)}
                  role="button"
                  tabIndex={0}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter' || e.key === ' ') {
                      e.preventDefault();
                      handleEdit(category);
                    }
                  }}
                >
                  <div style={{display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', flex: 1}}>
                    <div style={{flex: 1}}>
                      <div className="category-title-row">
                        <span style={{fontSize: '14px', fontWeight: 500}}>{category.name}</span>
                        <CategoryMpBadges category={category} />
                      </div>
                      {category.description && (
                        <div style={{fontSize: '12px', color: 'var(--muted)', marginBottom: '4px'}}>
                          {category.description}
                        </div>
                      )}
                      <div style={{fontSize: '12px', color: 'var(--muted)'}}>
                        Товаров: {category.productsCount || 0}
                      </div>
                      {children.length > 0 && (
                        <div style={{marginTop: '8px', paddingLeft: '20px'}}>
                          {children.map(child => (
                            <div
                              key={child.id}
                              style={{fontSize: '13px', color: 'var(--muted)', marginBottom: '6px', display: 'flex', alignItems: 'center', gap: '8px', flexWrap: 'wrap'}}
                              onClick={(e) => {
                                e.stopPropagation();
                                handleEdit(child);
                              }}
                              role="button"
                              tabIndex={0}
                              onKeyDown={(e) => {
                                if (e.key === 'Enter' || e.key === ' ') {
                                  e.preventDefault();
                                  e.stopPropagation();
                                  handleEdit(child);
                                }
                              }}
                            >
                              <span>↳ {child.name}</span>
                              <CategoryMpBadges category={child} />
                              {child.productsCount > 0 && (
                                <span style={{fontSize: '11px'}}>({child.productsCount} товаров)</span>
                              )}
                            </div>
                          ))}
                        </div>
                      )}
                    </div>
                    <div style={{display: 'flex', gap: '8px'}} onClick={(e) => e.stopPropagation()}>
                      <Button 
                        variant="secondary" 
                        size="small"
                        onClick={() => handleEdit(category)}
                        style={{padding: '6px 12px', fontSize: '12px'}}
                      >
                        ✏️
                      </Button>
                      <Button 
                        variant="secondary" 
                        size="small"
                        onClick={() => handleDelete(category.id)}
                        style={{padding: '6px 12px', fontSize: '12px', color: '#fca5a5', borderColor: '#fca5a5'}}
                      >
                        🗑️
                      </Button>
                    </div>
                  </div>
                </div>
              );
            })}
            {subCategories.filter(sub => !parentCategories.find(p => p.id === sub.parent_id)).map(category => (
              <div
                key={category.id}
                className="category-item category-item--clickable"
                style={{marginLeft: '20px'}}
                onClick={() => handleEdit(category)}
                role="button"
                tabIndex={0}
                onKeyDown={(e) => {
                  if (e.key === 'Enter' || e.key === ' ') {
                    e.preventDefault();
                    handleEdit(category);
                  }
                }}
              >
                <div style={{display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', flex: 1}}>
                  <div style={{flex: 1}}>
                    <div style={{fontSize: '13px', color: 'var(--muted)', marginBottom: '4px'}}>↳ Подкатегория</div>
                    <div className="category-title-row">
                      <span style={{fontSize: '14px', fontWeight: 500}}>{category.name}</span>
                      <CategoryMpBadges category={category} />
                    </div>
                    {category.description && (
                      <div style={{fontSize: '12px', color: 'var(--muted)', marginBottom: '4px'}}>
                        {category.description}
                      </div>
                    )}
                    <div style={{fontSize: '12px', color: 'var(--muted)'}}>
                      Товаров: {category.productsCount || 0}
                    </div>
                  </div>
                  <div style={{display: 'flex', gap: '8px'}} onClick={(e) => e.stopPropagation()}>
                    <Button 
                      variant="secondary" 
                      size="small"
                      onClick={() => handleEdit(category)}
                      style={{padding: '6px 12px', fontSize: '12px'}}
                    >
                      ✏️
                    </Button>
                    <Button 
                      variant="secondary" 
                      size="small"
                      onClick={() => handleDelete(category.id)}
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

      <Modal
        isOpen={isModalOpen}
        onClose={() => {
          setIsModalOpen(false);
          setEditingCategory(null);
          setCategoryForForm(null);
        }}
        title={editingCategory ? 'Редактировать категорию' : 'Добавить категорию'}
        size="large"
      >
        <CategoryForm
          category={categoryForFormMerged}
          categories={categoriesWithMappings.length > 0 ? categoriesWithMappings : categories}
          allAttributes={allAttributes}
          onSubmit={handleSubmit}
          onCancel={() => {
            setIsModalOpen(false);
            setEditingCategory(null);
            setCategoryForForm(null);
          }}
        />
      </Modal>
    </div>
  );
}

