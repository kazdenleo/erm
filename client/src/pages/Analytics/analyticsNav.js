/**
 * Каталог разделов аналитики: группы → отчёты.
 * Маршруты отчётов не меняем — только оболочка навигации.
 */

export const ANALYTICS_GROUPS = [
  {
    id: 'sales',
    label: 'Продажи',
    description: 'Выручка и структура продаж по схемам, категориям и динамике',
    reports: [
      {
        to: '/analytics/sales',
        label: 'Продажи FBS',
        description: 'Продажи и экономика по товарам FBS',
        sectionKey: 'analytics_sales',
      },
      {
        to: '/analytics/fbo-sales',
        label: 'Продажи FBO',
        description: 'Продажи со склада маркетплейса',
        sectionKey: 'analytics_sales',
        requiresFbo: true,
      },
      {
        to: '/analytics/categories',
        label: 'По категориям',
        description: 'Сводка продаж в разрезе категорий',
        sectionKey: 'analytics_sales',
      },
      {
        to: '/analytics/abc',
        label: 'ABC',
        description: 'ABC-анализ товаров по вкладу в выручку',
        sectionKey: 'analytics_sales',
      },
      {
        to: '/analytics/dynamics',
        label: 'Динамика',
        description: 'Изменение продаж во времени',
        sectionKey: 'analytics_sales',
      },
      {
        to: '/analytics/rnp',
        label: 'РНП',
        description: 'Рабочая таблица номенклатурных показателей',
        sectionKey: 'analytics_sales',
      },
    ],
  },
  {
    id: 'assortment',
    label: 'Ассортимент',
    description: 'Остатки, оборачиваемость и упущенные продажи',
    reports: [
      {
        to: '/analytics/turnover',
        label: 'Оборачиваемость',
        description: 'Скорость продаж относительно остатка',
        sectionKey: 'analytics_assortment',
      },
      {
        to: '/analytics/dead-stock',
        label: 'Неликвиды',
        description: 'Товары без продаж и замороженные деньги',
        sectionKey: 'analytics_assortment',
      },
      {
        to: '/analytics/lost-revenue',
        label: 'Упущенная выручка',
        description: 'Потери из‑за отсутствия товара',
        sectionKey: 'analytics_assortment',
      },
    ],
  },
  {
    id: 'losses',
    label: 'Потери',
    description: 'Возвраты, штрафы и удержания маркетплейсов',
    reports: [
      {
        to: '/analytics/returns',
        label: 'Возвраты',
        description: 'Доля и стоимость возвратов по товарам',
        sectionKey: 'analytics_losses',
      },
      {
        to: '/analytics/penalties',
        label: 'Штрафы',
        description: 'Штрафы и спорные удержания',
        sectionKey: 'analytics_losses',
      },
    ],
  },
  {
    id: 'finance',
    label: 'Финансы',
    description: 'Прибыль, юнит-экономика и сверка с отчётами МП',
    reports: [
      {
        to: '/analytics/unit-economics',
        label: 'Юнит-экономика',
        description: 'Маржа и экономика по артикулам',
        sectionKey: 'analytics_unit_economics',
      },
      {
        to: '/analytics/pnl',
        label: 'ОПиУ',
        description: 'Прибыли и убытки компании',
        sectionKey: 'analytics_finance',
      },
      {
        to: '/analytics/reconciliation',
        label: 'Сверка',
        description: 'Сверка начислений маркетплейсов',
        sectionKey: 'analytics_finance',
      },
    ],
  },
  {
    id: 'operations',
    label: 'Операции',
    description: 'Показатели сотрудников склада и сборки',
    reports: [
      {
        to: '/analytics/employees',
        label: 'Сотрудники',
        description: 'Скорость, ошибки, объём работы и зарплата',
        sectionKey: 'analytics_employees',
      },
    ],
  },
];

/**
 * @param {{
 *   features?: object|null,
 *   isAccountAdmin?: boolean,
 *   isAdmin?: boolean,
 *   fboEnabled?: boolean,
 *   isNavFeatureEnabled?: (features: object|null|undefined, key: string) => boolean,
 * }} opts
 */
export function filterAnalyticsGroups({
  features = null,
  isAccountAdmin = false,
  isAdmin = false,
  fboEnabled = true,
  isNavFeatureEnabled: navFeatureFn,
} = {}) {
  const canAdmin = Boolean(isAccountAdmin || isAdmin);
  const featureOk = (key) => {
    if (!key) return true;
    if (canAdmin) return true;
    if (typeof navFeatureFn === 'function') return navFeatureFn(features, key);
    return true;
  };

  return ANALYTICS_GROUPS.map((group) => ({
    ...group,
    reports: (group.reports || []).filter((report) => {
      if (report.requiresFbo && !fboEnabled) return false;
      return featureOk(report.sectionKey);
    }),
  })).filter((group) => group.reports.length > 0);
}

/** Группа, которой принадлежит pathname, или null (хаб / неизвестный путь). */
export function findAnalyticsGroupByPath(pathname, groups = ANALYTICS_GROUPS) {
  const path = String(pathname || '').split('?')[0];
  if (!path || path === '/analytics') return null;
  for (const group of groups) {
    if ((group.reports || []).some((r) => r.to === path || path.startsWith(`${r.to}/`))) {
      return group;
    }
  }
  return null;
}

/** Пункты сайдбара: одна строка на группу → первый доступный отчёт. */
export function analyticsGroupsToSidebarChildren(groups) {
  return (groups || []).map((group) => {
    const paths = (group.reports || []).map((r) => r.to);
    const first = paths[0] || '/analytics';
    // Для фильтрации пункта: доступен, если доступен хотя бы один отчёт группы
    const sectionKeys = [...new Set((group.reports || []).map((r) => r.sectionKey).filter(Boolean))];
    return {
      path: first,
      label: group.label,
      iconClass: 'pe-7s-angle-right',
      sectionKey: sectionKeys[0] || 'analytics_sales',
      sectionKeys,
      matchPaths: paths,
    };
  });
}
