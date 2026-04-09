/**
 * Categories Page
 * Страница управления категориями
 */

import React, { useState, useEffect } from 'react';
import { useUserCategories } from '../../hooks/useUserCategories';
import { categoriesApi } from '../../services/categories.api';
import { categoryMappingsApi } from '../../services/categoryMappings.api';
import { userCategoriesApi } from '../../services/userCategories.api';
import { productAttributesApi } from '../../services/productAttributes.api';
import { productsApi } from '../../services/products.api';
import { Button } from '../../components/common/Button/Button';
import { Modal } from '../../components/common/Modal/Modal';
import { CategoryForm } from '../../components/forms/CategoryForm/CategoryForm';
import api from '../../services/api';
import './Categories.css';

export function Categories() {
  const { categories, mappings, loading, error, createCategory, updateCategory, deleteCategory, loadData } = useUserCategories();
  const [isModalOpen, setIsModalOpen] = useState(false);
  const [editingCategory, setEditingCategory] = useState(null);
  const [categoryForForm, setCategoryForForm] = useState(null);
  const [allAttributes, setAllAttributes] = useState([]);
  const [categoriesWithMappings, setCategoriesWithMappings] = useState([]);
  /** null — ещё не грузили; после загрузки — объект (CategoryForm берёт из пропсов и не дублирует запрос) */
  const [marketplaceCategories, setMarketplaceCategories] = useState(null);
  const [marketplaceCategoriesLoading, setMarketplaceCategoriesLoading] = useState(false);

  // Тяжёлые справочники (Ozon/YM/WB + атрибуты) — после первого кадра, чтобы список категорий появился сразу
  useEffect(() => {
    let cancelled = false;
    let scheduleId;
    let scheduledViaIdleCallback = false;
    const load = async () => {
      setMarketplaceCategoriesLoading(true);
      try {
        const [wbRes, ozonRes, ymRes, attrRes] = await Promise.all([
          categoriesApi.getAll('wb'),
          categoriesApi.getAll('ozon'),
          categoriesApi.getAll('ym'),
          productAttributesApi.getAll()
        ]);
        if (cancelled) return;
        setMarketplaceCategories({
          wb: wbRes?.data || [],
          ozon: ozonRes?.data || ozonRes || [],
          ym: ymRes?.data || []
        });
        setAllAttributes(attrRes?.data || []);
      } catch (e) {
        if (!cancelled) console.error('[Categories] Error loading marketplace categories or attributes:', e);
        if (!cancelled) {
          setMarketplaceCategories({ wb: [], ozon: [], ym: [] });
        }
      } finally {
        if (!cancelled) setMarketplaceCategoriesLoading(false);
      }
    };
    if (typeof window !== 'undefined' && typeof window.requestIdleCallback === 'function') {
      scheduledViaIdleCallback = true;
      scheduleId = window.requestIdleCallback(() => {
        void load();
      }, { timeout: 3000 });
    } else if (typeof window !== 'undefined') {
      scheduleId = window.setTimeout(() => {
        void load();
      }, 150);
    } else {
      void load();
    }
    return () => {
      cancelled = true;
      if (typeof window !== 'undefined' && scheduleId != null) {
        if (scheduledViaIdleCallback && typeof window.cancelIdleCallback === 'function') {
          window.cancelIdleCallback(scheduleId);
        } else {
          window.clearTimeout(scheduleId);
        }
      }
    };
  }, []);

  // Обогащаем категории данными о маппингах и количестве товаров
  useEffect(() => {
    let cancelled = false;
    const enrichCategories = async () => {
      if (!categories.length) {
        setCategoriesWithMappings([]);
        return;
      }

      try {
        // Лёгкий запрос id товаров по категории + маппинги из хука (без повторного GET /category-mappings)
        const groupedRes = await productsApi.getProductIdsGroupedByUserCategory();
        if (cancelled) return;

        const productIdsByCategory = groupedRes?.data && typeof groupedRes.data === 'object' ? groupedRes.data : {};
        const allMappings = Array.isArray(mappings) ? mappings : [];

        // Группируем маппинги по product_id для быстрого поиска
        const mappingsByProductId = {};
        for (const m of allMappings) {
          if (m.product_id === undefined || m.product_id === null) continue;
          const k = String(m.product_id);
          if (!mappingsByProductId[k]) mappingsByProductId[k] = [];
          mappingsByProductId[k].push(m);
        }

        // Справочники маркетплейсов (могут ещё грузиться в фоне — тогда имена подтянутся при следующем проходе)
        const mpCats = marketplaceCategories ?? { wb: [], ozon: [], ym: [] };
        const resolveCategoryName = (mp, catId) => {
          if (!catId) return null;
          const list = (mp === 'wb' || mp === 'wildberries') ? mpCats.wb : mp === 'ozon' ? mpCats.ozon : (mp === 'ym' || mp === 'yandex') ? mpCats.ym : [];
          const s = String(catId);
          const c = list.find(x => String(x.id || x.marketplace_category_id) === s || String(x.marketplace_category_id) === s);
          return c?.name || null;
        };

        const enriched = categories.map((category) => {
          const productIds = productIdsByCategory[String(category.id)] || [];
          const productsCount = productIds.length;
          let categoryMappings = productIds.flatMap((pid) => mappingsByProductId[String(pid)] || []);
          // Подставляем имена категорий (getAll возвращает "Unknown Category", resolve по marketplaceCategories)
          categoryMappings = categoryMappings.map(m => {
            const name = resolveCategoryName(m.marketplace, m.category_id);
            return { ...m, marketplace_category_name: name || m.marketplace_category_name || 'Unknown Category' };
          });

          // Группируем маппинги по маркетплейсам (из товаров)
            const mappingsByMarketplace = {};
            categoryMappings.forEach(mapping => {
              const marketplace = mapping.marketplace;
              if (!mappingsByMarketplace[marketplace]) {
                mappingsByMarketplace[marketplace] = [];
              }
              const exists = mappingsByMarketplace[marketplace].some(
                m => m.marketplace_category_id === mapping.marketplace_category_id || 
                     m.category_id === mapping.category_id
              );
              if (!exists) {
                mappingsByMarketplace[marketplace].push(mapping);
              }
            });
            
            // Если маппингов нет (ни у товаров, ни в категории), но в категории сохранены сопоставления — показываем их
            const hasMappingsFromProducts = Object.keys(mappingsByMarketplace).length > 0;
            
            // Также проверяем marketplace_mappings категории, даже если есть маппинги из товаров
            // Это нужно для случаев, когда у товаров нет маппингов, но они есть в категории
            if (category.marketplace_mappings) {
              let mm;
              try {
                mm = typeof category.marketplace_mappings === 'string'
                  ? JSON.parse(category.marketplace_mappings)
                  : category.marketplace_mappings;
              } catch (_) {
                mm = null;
              }
              
              if (mm && typeof mm === 'object') {
                // Загружаем реальные названия категорий маркетплейсов по их ID
                if (mm.wb && !mappingsByMarketplace.wb) {
                  const wbCategory = mpCats.wb.find(cat => 
                    String(cat.id) === String(mm.wb) || 
                    String(cat.marketplace_category_id) === String(mm.wb)
                  );
                  mappingsByMarketplace.wb = [{
                    marketplace_category_name: wbCategory?.name || 'Категория не найдена',
                    category_id: mm.wb,
                    marketplace_category_id: mm.wb
                  }];
                }
                if (mm.ozon) {
                  const ozonCategoryIdStr = String(mm.ozon);

                  const ozonCategory = mpCats.ozon.find(cat => {
                    const catIdStr = String(cat.id || '');
                    const catMarketplaceIdStr = String(cat.marketplace_category_id || '');
                    
                    if (catIdStr === ozonCategoryIdStr || catMarketplaceIdStr === ozonCategoryIdStr) {
                      return true;
                    }

                    const catIdClean = catIdStr.replace(/^ozon_/, '');
                    const catMarketplaceIdClean = catMarketplaceIdStr.replace(/^ozon_/, '');
                    const mappingIdClean = ozonCategoryIdStr.replace(/^ozon_/, '');

                    if (catIdClean === mappingIdClean || catMarketplaceIdClean === mappingIdClean) {
                      return true;
                    }
                    if (catIdStr === `ozon_${mappingIdClean}` || catMarketplaceIdStr === `ozon_${mappingIdClean}`) {
                      return true;
                    }
                    if (`ozon_${catIdClean}` === ozonCategoryIdStr || `ozon_${catMarketplaceIdClean}` === ozonCategoryIdStr) {
                      return true;
                    }

                    return false;
                  });

                  const ozonDisplayName = mm.ozon_display || ozonCategory?.path || ozonCategory?.name || 'Категория не найдена';
                  if (!mappingsByMarketplace.ozon || mappingsByMarketplace.ozon.length === 0) {
                    mappingsByMarketplace.ozon = [{
                      marketplace_category_name: ozonDisplayName,
                      category_id: mm.ozon,
                      marketplace_category_id: mm.ozon
                    }];
                  } else {
                    const existingMapping = mappingsByMarketplace.ozon[0];
                    existingMapping.marketplace_category_name = ozonDisplayName;
                  }
                }
                if (mm.ym) {
                  const ymCategory = mpCats.ym.find(cat => 
                    String(cat.id) === String(mm.ym) || 
                    String(cat.marketplace_category_id) === String(mm.ym)
                  );
                  mappingsByMarketplace.ym = [{
                    marketplace_category_name: ymCategory?.name || 'Категория не найдена',
                    category_id: mm.ym,
                    marketplace_category_id: mm.ym
                  }];
                }
              }
            }

          return {
            ...category,
            productsCount,
            mappings: mappingsByMarketplace
          };
        });

        if (!cancelled) setCategoriesWithMappings(enriched);
      } catch (err) {
        if (!cancelled) console.error('[Categories] Error enriching categories:', err);
        if (!cancelled) setCategoriesWithMappings([]);
      }
    };

    if (categories.length > 0) {
      enrichCategories();
    } else {
      setCategoriesWithMappings([]);
    }
    return () => { cancelled = true; };
  }, [categories, mappings, marketplaceCategories]);

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
      if (full && full.id) setCategoryForForm(full);
    } catch (e) {
      console.error('[Categories] Error loading category for edit:', e);
    }
  };

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
      <h1 className="title">📦 Категории</h1>
      <p className="subtitle">Создание и сопоставление категорий товаров с маркетплейсами</p>

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
              const marketplaceNames = {
                'wb': 'Wildberries',
                'ozon': 'Ozon',
                'ym': 'Yandex Market'
              };
              
              return (
                <div key={category.id} className="category-item">
                  <div style={{display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', flex: 1}}>
                    <div style={{flex: 1}}>
                      <div style={{fontSize: '14px', fontWeight: 500, marginBottom: '4px'}}>
                        {category.name}
                      </div>
                      {category.description && (
                        <div style={{fontSize: '12px', color: 'var(--muted)', marginBottom: '4px'}}>
                          {category.description}
                        </div>
                      )}
                      <div style={{fontSize: '12px', color: 'var(--muted)', marginBottom: '8px'}}>
                        Товаров: {category.productsCount || 0}
                      </div>
                      
                      {/* Показываем сопоставления с маркетплейсами */}
                      {category.mappings && Object.keys(category.mappings).length > 0 && (
                        <div style={{marginTop: '8px', padding: '8px', background: 'rgba(59, 130, 246, 0.1)', borderRadius: '4px'}}>
                          <div style={{fontSize: '12px', fontWeight: 500, marginBottom: '4px', color: 'var(--text)'}}>
                            Сопоставлено с маркетплейсами:
                          </div>
                          {Object.entries(category.mappings).map(([marketplace, mappingsList]) => {
                            // Берем первый маппинг для этого маркетплейса
                            const mapping = mappingsList[0];
                            return (
                              <div key={marketplace} style={{fontSize: '11px', color: 'var(--muted)', marginBottom: '2px'}}>
                                <span style={{fontWeight: 500}}>{marketplaceNames[marketplace] || marketplace}:</span>{' '}
                                {mapping.marketplace_category_name || 'Категория не найдена'}
                              </div>
                            );
                          })}
                        </div>
                      )}
                      {children.length > 0 && (
                        <div style={{marginTop: '8px', paddingLeft: '20px'}}>
                          {children.map(child => (
                            <div key={child.id} style={{fontSize: '13px', color: 'var(--muted)', marginBottom: '4px'}}>
                              ↳ {child.name}
                              {child.productsCount > 0 && (
                                <span style={{fontSize: '11px', marginLeft: '8px'}}>({child.productsCount} товаров)</span>
                              )}
                            </div>
                          ))}
                        </div>
                      )}
                    </div>
                    <div style={{display: 'flex', gap: '8px'}}>
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
              <div key={category.id} className="category-item" style={{marginLeft: '20px'}}>
                <div style={{display: 'flex', justifyContent: 'space-between', alignItems: 'center', flex: 1}}>
                  <div style={{flex: 1}}>
                    <div style={{fontSize: '13px', color: 'var(--muted)', marginBottom: '4px'}}>↳ Подкатегория</div>
                    <div style={{fontSize: '14px', fontWeight: 500, marginBottom: '4px'}}>
                      {category.name}
                    </div>
                    {category.description && (
                      <div style={{fontSize: '12px', color: 'var(--muted)'}}>
                        {category.description}
                      </div>
                    )}
                  </div>
                  <div style={{display: 'flex', gap: '8px'}}>
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

      <div className="actions" style={{marginTop: '16px'}}>
        <Button variant="primary" onClick={handleCreate}>➕ Добавить категорию</Button>
        <Button variant="secondary">Импорт категорий</Button>
        {categories.length > 0 && (
          <Button 
            variant="secondary" 
            onClick={() => {
              if (window.confirm('Вы уверены, что хотите удалить все категории?')) {
                categories.forEach(cat => deleteCategory(cat.id));
              }
            }}
            style={{color: '#fca5a5', borderColor: '#fca5a5'}}
          >
            Очистить все
          </Button>
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
        size="medium"
      >
        <CategoryForm
          category={categoryForForm ?? editingCategory}
          categories={categoriesWithMappings.length > 0 ? categoriesWithMappings : categories}
          allAttributes={allAttributes}
          marketplaceCategories={marketplaceCategories}
          marketplaceCategoriesLoading={marketplaceCategoriesLoading}
          onRefreshOzonCategories={(ozonList) =>
            setMarketplaceCategories((prev) => ({
              ...(prev || { wb: [], ozon: [], ym: [] }),
              ozon: ozonList || [],
            }))
          }
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

