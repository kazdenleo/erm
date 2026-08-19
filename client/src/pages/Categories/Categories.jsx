/**
 * Categories Page
 * Страница управления категориями
 */

import React, { useState, useEffect, useMemo } from 'react';
import { useUserCategories } from '../../hooks/useUserCategories';
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
import './Categories.css';

function normalizeMappingValue(v) {
  if (v == null || v === '') return '';
  return String(v);
}

/** Какие маркетплейсы изменили сопоставление (для селективного пуша). */
function getChangedMarketplaceKeys(prevMm, nextMm) {
  const prev = prevMm && typeof prevMm === 'object' ? prevMm : {};
  const next = nextMm && typeof nextMm === 'object' ? nextMm : {};
  const changed = [];
  if (normalizeMappingValue(prev.wb) !== normalizeMappingValue(next.wb)) changed.push('wb');
  const ozonChanged =
    normalizeMappingValue(prev.ozon) !== normalizeMappingValue(next.ozon) ||
    normalizeMappingValue(prev.ozon_description_category_id) !==
      normalizeMappingValue(next.ozon_description_category_id) ||
    normalizeMappingValue(prev.ozon_type_id) !== normalizeMappingValue(next.ozon_type_id);
  if (ozonChanged) changed.push('ozon');
  if (normalizeMappingValue(prev.ym) !== normalizeMappingValue(next.ym)) changed.push('ym');
  return changed;
}

const MP_PUSH_LABELS = { ozon: 'Ozon', wb: 'Wildberries', ym: 'Яндекс.Маркет' };

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

  // Атрибуты — при каждом открытии формы, чтобы список был актуальным
  useEffect(() => {
    if (!isModalOpen) return undefined;
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
  }, [isModalOpen]);

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
      const { marketplaceMappings, ...categoryPayload } = categoryData;

      const prevMappings =
        categoryForFormMerged?.marketplace_mappings ||
        editingCategory?.marketplace_mappings ||
        {};
      const changedMpKeys =
        marketplaceMappings != null
          ? getChangedMarketplaceKeys(prevMappings, marketplaceMappings)
          : [];

      const mappingsPayload =
        marketplaceMappings != null
          ? {
              wb: marketplaceMappings.wb ?? null,
              ozon: marketplaceMappings.ozon ?? null,
              ym: marketplaceMappings.ym ?? null,
              ...(marketplaceMappings.ozon_display
                ? { ozon_display: marketplaceMappings.ozon_display }
                : {}),
              ...(marketplaceMappings.ozon_description_category_id != null &&
              marketplaceMappings.ozon_type_id != null
                ? {
                    ozon_description_category_id:
                      marketplaceMappings.ozon_description_category_id,
                    ozon_type_id: marketplaceMappings.ozon_type_id,
                  }
                : {}),
            }
          : null;

      if (mappingsPayload) {
        categoryPayload.marketplace_mappings = mappingsPayload;
      }

      let savedCategory;
      if (editingCategory) {
        savedCategory = await updateCategory(editingCategory.id, categoryPayload);
      } else {
        savedCategory = await createCategory(categoryPayload);
        const newId =
          savedCategory?.data?.id ?? savedCategory?.id ?? null;
        // create мог не принять mappings — дозаписываем одним PUT (на сервере сразу bulk-sync)
        if (newId && mappingsPayload) {
          await updateCategory(newId, { marketplace_mappings: mappingsPayload });
        }
      }

      const categoryId =
        (savedCategory &&
          (savedCategory.data?.id != null ? savedCategory.data.id : savedCategory.id)) ??
        editingCategory?.id;

      let productIds = [];
      if (categoryId != null) {
        try {
          const groupedRes = await productsApi.getProductIdsGroupedByUserCategory();
          const grouped =
            groupedRes?.data && typeof groupedRes.data === 'object'
              ? groupedRes.data
              : groupedRes && typeof groupedRes === 'object'
                ? groupedRes
                : {};
          const raw = grouped[String(categoryId)] ?? grouped[categoryId] ?? [];
          productIds = Array.isArray(raw) ? raw.filter((id) => id != null) : [];
        } catch (e) {
          console.warn('[Categories] Could not load product ids for category:', e);
          const fallbackCount = Number(
            editingCategory?.productsCount ?? categoryForFormMerged?.productsCount ?? 0
          );
          if (fallbackCount > 0) {
            productIds = new Array(fallbackCount).fill(null);
          }
        }
      }

      const savedMappings = [];
      if (mappingsPayload?.wb) savedMappings.push('Wildberries');
      if (mappingsPayload?.ozon) savedMappings.push('Ozon');
      if (mappingsPayload?.ym) savedMappings.push('Яндекс.Маркет');

      if (savedMappings.length > 0) {
        alert(
          productIds.length > 0
            ? `Категория и сопоставления сохранены (${savedMappings.join(', ')}).\nТоваров в категории: ${productIds.length}.`
            : `Сопоставление сохранено (${savedMappings.join(', ')}).\nТоваров в категории пока нет — привязка применится к новым товарам.`
        );
      }

      // Обновление на МП — по подтверждению; пуш в фоне (не ждём ответы кабинетов)
      if (changedMpKeys.length > 0 && productIds.length > 0) {
        const mpNames = changedMpKeys.map((k) => MP_PUSH_LABELS[k] || k).join(', ');
        const countLabel = productIds[0] != null ? String(productIds.length) : String(productIds.length);
        const offer = window.confirm(
          `Сопоставление категорий изменено (${mpNames}).\n\n` +
            `Обновить карточки на маркетплейсах у ${countLabel} товар(ов)?\n\n` +
            `Как это работает:\n` +
            `• Ozon / Яндекс.Маркет — уйдёт новая категория (+ контент из ERP).\n` +
            `• Wildberries — API не меняет subjectId у созданной карточки, обновляется контент.\n` +
            `Отправка ставится в очередь на сервере; в ЛК МП изменения появятся не сразу.`
        );
        if (offer && categoryId != null && mappingsPayload) {
          try {
            await updateCategory(categoryId, {
              marketplace_mappings: mappingsPayload,
              push_product_cards: true,
              push_marketplaces: changedMpKeys,
            });
            alert(
              `Отправка на ${mpNames} поставлена в очередь для товаров категории. Проверьте кабинеты МП через несколько минут.`
            );
          } catch (pushErr) {
            console.error('[Categories] queue card push failed:', pushErr);
            alert(
              `Сохранено в ERP, но не удалось поставить отправку на МП:\n${
                pushErr?.response?.data?.message || pushErr?.message || pushErr
              }`
            );
          }
        }
      }

      setIsModalOpen(false);
      setEditingCategory(null);
      setCategoryForForm(null);
      await loadData();
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
        scrollable
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

