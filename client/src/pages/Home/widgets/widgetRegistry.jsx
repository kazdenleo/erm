/**
 * Каталог виджетов главной и раскладка по умолчанию.
 */

import React from 'react';
import { MarketplaceInventorySummary } from '../../../components/MarketplaceInventorySummary/MarketplaceInventorySummary.jsx';
import { HomeSalesDynamics } from '../HomeSalesDynamics.jsx';
import { OrdersWidget, ProductsWidget, QuestionsWidget, ReturnsWidget, StockWidget } from './OpsWidgets';
import { BalancesWidget } from './BalancesWidget';
import {
  DeadStockWidget,
  EmployeesWidget,
  LostRevenueWidget,
  PenaltiesWidget,
  PnlWidget,
  ReturnsAnalyticsWidget,
} from './AnalyticsWidgets';
import { NoteWidget, QuickLinksSettings, QuickLinksWidget } from './ExtraWidgets';
import { SupplierSettlementsSettings, SupplierSettlementsWidget } from './SupplierSettlementsWidget';
import { DAY_PERIODS, MONTH_PERIODS } from './widgetUtils';

function SalesDynamicsWidget({ profileId }) {
  return <HomeSalesDynamics profileId={profileId} />;
}

function MarketplaceInventoryWidget() {
  return <MarketplaceInventorySummary visible />;
}

export const WIDGET_SIZES = [
  { value: 'xs', label: 'Четверть', colClass: 'col-12 col-sm-6 col-xl-3' },
  { value: 'sm', label: 'Узкий (1/3)', colClass: 'col-12 col-md-6 col-xl-4' },
  { value: 'md', label: 'Половина', colClass: 'col-12 col-lg-6' },
  { value: 'lg', label: 'Во всю ширину', colClass: 'col-12' },
];

export const WIDGET_GROUPS = [
  { value: 'ops', label: 'Оперативное' },
  { value: 'analytics', label: 'Аналитика' },
  { value: 'other', label: 'Прочее' },
];

export const WIDGETS = {
  orders: {
    title: 'Заказы в работе',
    description: 'Новые и на сборке',
    group: 'ops',
    defaultSize: 'xs',
    sectionKey: 'orders',
    Component: OrdersWidget,
  },
  questions: {
    title: 'Вопросы покупателей',
    description: 'Без ответа продавца',
    group: 'ops',
    defaultSize: 'xs',
    sectionKey: 'questions',
    Component: QuestionsWidget,
  },
  returns: {
    title: 'Возвраты к выдаче',
    description: 'По маркетплейсам',
    group: 'ops',
    defaultSize: 'xs',
    Component: ReturnsWidget,
  },
  products: {
    title: 'Товары',
    description: 'Количество товаров в системе',
    group: 'ops',
    defaultSize: 'xs',
    sectionKey: 'products',
    Component: ProductsWidget,
  },
  stock: {
    title: 'Остатки по складам',
    description: 'Количество и себестоимость, разбивка по категориям',
    group: 'ops',
    defaultSize: 'md',
    adminOnly: true,
    Component: StockWidget,
  },
  sales_dynamics: {
    title: 'Динамика продаж',
    description: 'График продаж по маркетплейсам',
    group: 'analytics',
    defaultSize: 'lg',
    Component: SalesDynamicsWidget,
  },
  mp_inventory: {
    title: 'Остатки на маркетплейсах',
    description: 'Сводка остатков FBO/FBS по площадкам',
    group: 'ops',
    defaultSize: 'lg',
    adminOnly: true,
    Component: MarketplaceInventoryWidget,
  },
  balances: {
    title: 'Баланс на маркетплейсах',
    description: 'Ozon, Wildberries, Яндекс Маркет',
    group: 'ops',
    defaultSize: 'lg',
    adminOnly: true,
    Component: BalancesWidget,
  },
  supplier_settlements: {
    title: 'Взаиморасчёты с поставщиками',
    description: 'Наш долг и переплаты по поставщикам',
    group: 'ops',
    defaultSize: 'md',
    sectionKey: 'suppliers',
    Component: SupplierSettlementsWidget,
    SettingsComponent: SupplierSettlementsSettings,
  },
  pnl: {
    title: 'Прибыль (ОПиУ)',
    description: 'Выручка, удержания, себестоимость, чистая прибыль и маржа',
    group: 'analytics',
    defaultSize: 'md',
    adminOnly: true,
    periods: MONTH_PERIODS,
    defaultPeriod: 'month',
    multiple: true,
    Component: PnlWidget,
  },
  lost_revenue: {
    title: 'Упущенная выручка',
    description: 'Потери из-за отсутствия товара и топ товаров по потерям',
    group: 'analytics',
    defaultSize: 'md',
    sectionKey: 'analytics_sales',
    periods: DAY_PERIODS,
    defaultPeriod: '30d',
    multiple: true,
    Component: LostRevenueWidget,
  },
  returns_analytics: {
    title: 'Возвраты и отмены',
    description: 'Процент возвратов, отмен и обратная логистика',
    group: 'analytics',
    defaultSize: 'md',
    sectionKey: 'analytics_sales',
    periods: DAY_PERIODS,
    defaultPeriod: '30d',
    multiple: true,
    Component: ReturnsAnalyticsWidget,
  },
  dead_stock: {
    title: 'Неликвиды',
    description: 'Замороженные в остатках деньги и хранение FBO',
    group: 'analytics',
    defaultSize: 'md',
    sectionKey: 'analytics_sales',
    Component: DeadStockWidget,
  },
  penalties: {
    title: 'Штрафы и удержания',
    description: 'Штрафы, компенсации, недоплаты маркетплейсов',
    group: 'analytics',
    defaultSize: 'md',
    sectionKey: 'analytics_sales',
    periods: DAY_PERIODS,
    defaultPeriod: '30d',
    multiple: true,
    Component: PenaltiesWidget,
  },
  employees: {
    title: 'Сотрудники',
    description: 'Сборка, упаковка, приёмка и время в работе по сотрудникам',
    group: 'analytics',
    defaultSize: 'lg',
    adminOnly: true,
    periods: DAY_PERIODS,
    defaultPeriod: 'today',
    multiple: true,
    Component: EmployeesWidget,
  },
  quick_links: {
    title: 'Быстрый доступ',
    description: 'Ссылки на часто используемые разделы',
    group: 'other',
    defaultSize: 'md',
    Component: QuickLinksWidget,
    SettingsComponent: QuickLinksSettings,
  },
  note: {
    title: 'Заметка',
    description: 'Личный текст: планы, напоминания',
    group: 'other',
    defaultSize: 'sm',
    multiple: true,
    Component: NoteWidget,
  },
};

const DEFAULT_TYPES = [
  'orders',
  'questions',
  'returns',
  'products',
  'stock',
  'sales_dynamics',
  'mp_inventory',
  'balances',
];

export function newWidgetUid(type) {
  return `${type}-${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
}

export function createWidgetItem(type) {
  const def = WIDGETS[type];
  return {
    uid: newWidgetUid(type),
    type,
    size: def?.defaultSize || 'md',
    settings: def?.defaultPeriod ? { period: def.defaultPeriod } : {},
  };
}

export function defaultLayout() {
  return DEFAULT_TYPES.map((type) => ({ ...createWidgetItem(type), uid: type }));
}

export function sizeColClass(size) {
  return (WIDGET_SIZES.find((s) => s.value === size) || WIDGET_SIZES[2]).colClass;
}
