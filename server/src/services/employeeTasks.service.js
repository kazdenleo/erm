/**
 * Employee Tasks Service
 */

import employeeTasksRepository from '../repositories/employee_tasks.repository.pg.js';
import usersRepository from '../repositories/users.repository.pg.js';
import productsService from './products.service.js';

function normalizeAccountRole(v) {
  const s = v == null ? '' : String(v).trim().toLowerCase();
  return s || null;
}

export function isWarehouseManagerUser(user) {
  return normalizeAccountRole(user?.accountRole ?? user?.account_role) === 'warehouse_manager';
}

export function isAccountAdminUser(user) {
  if (!user) return false;
  if (user.role === 'admin') return true;
  if (user.isProfileAdmin === true || user.is_profile_admin === true) return true;
  return normalizeAccountRole(user.accountRole ?? user.account_role) === 'admin';
}

export function canManageTasks(user) {
  return isAccountAdminUser(user) || isWarehouseManagerUser(user);
}

export function isTaskCreator(task, user) {
  return task?.created_by_id != null && user?.id != null
    && Number(task.created_by_id) === Number(user.id);
}

export function canEditTask(task, user) {
  return canManageTasks(user) || isTaskCreator(task, user);
}

export async function resolveDefaultAssigneeId(profileId) {
  const manager = await employeeTasksRepository.findFirstWarehouseManager(profileId);
  if (manager?.id) return manager.id;
  const admin = await employeeTasksRepository.findFirstAccountAdmin(profileId);
  return admin?.id ?? null;
}

/**
 * Создать текстовую задачу.
 * По умолчанию — на руководителя склада, если его нет — на администратора аккаунта.
 */
export async function createTextTask({
  profileId,
  title,
  description,
  assigneeId,
  createdById,
  skuList,
  taskType,
}) {
  const trimmedTitle = String(title || '').trim();
  if (!trimmedTitle) {
    const err = new Error('Укажите название задачи');
    err.statusCode = 400;
    throw err;
  }
  let assignee = assigneeId != null && assigneeId !== '' ? Number(assigneeId) : null;
  if (!assignee || Number.isNaN(assignee)) {
    assignee = await resolveDefaultAssigneeId(profileId);
  } else {
    const u = await usersRepository.findById(assignee);
    if (!u || Number(u.profile_id) !== Number(profileId)) {
      const err = new Error('Исполнитель не найден в этом аккаунте');
      err.statusCode = 400;
      throw err;
    }
  }
  const normalizedSkuList = normalizeSkuList(skuList);
  const requestedType = String(taskType || '').trim().toLowerCase();
  let resolvedType = 'text';
  if (requestedType === 'product_create' || normalizedSkuList.length > 0) {
    resolvedType = 'product_create';
  } else if (requestedType === 'text') {
    resolvedType = 'text';
  }
  if (resolvedType === 'product_create' && normalizedSkuList.length === 0) {
    const err = new Error('Для задачи на создание товаров укажите список артикулов');
    err.statusCode = 400;
    throw err;
  }
  return employeeTasksRepository.create({
    profileId,
    title: trimmedTitle,
    description: description != null ? String(description).trim() || null : null,
    taskType: resolvedType,
    assigneeId: assignee,
    createdById: createdById ?? null,
    meta: resolvedType === 'product_create' ? { sku_list: normalizedSkuList } : {},
  });
}

function parseTaskMeta(raw) {
  if (raw == null) return {};
  if (typeof raw === 'object' && !Array.isArray(raw)) return { ...raw };
  if (typeof raw === 'string') {
    try {
      const parsed = JSON.parse(raw);
      return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {};
    } catch {
      return {};
    }
  }
  return {};
}

export function normalizeSkuList(input) {
  const src = Array.isArray(input)
    ? input
    : String(input || '').split(/[\n,;]+/);
  const out = [];
  const seen = new Set();
  for (const item of src) {
    const sku = String(item || '').trim();
    if (!sku) continue;
    const key = sku.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(sku);
  }
  return out;
}

export async function completeTask(task, userId) {
  return employeeTasksRepository.update(task.id, {
    status: 'done',
    completedAt: new Date().toISOString(),
    completedById: userId ?? null,
  });
}

export async function getProductCreateTaskStatus(task, profileId) {
  if (!task || task.task_type !== 'product_create') {
    return {
      items: [],
      total: 0,
      createdCount: 0,
      missingCount: 0,
      marketplaceCount: 0,
      marketplacePendingCount: 0,
    };
  }
  const meta = parseTaskMeta(task.meta);
  const skuList = normalizeSkuList(meta.sku_list);
  if (skuList.length === 0) {
    return {
      items: [],
      total: 0,
      createdCount: 0,
      missingCount: 0,
      marketplaceCount: 0,
      marketplacePendingCount: 0,
    };
  }

  const products = await productsService.getBySkus(skuList, { profileId });
  const productBySku = new Map();
  for (const product of products) {
    const key = String(product.sku || '').trim().toLowerCase();
    if (key && !productBySku.has(key)) productBySku.set(key, product);
  }

  const productIds = products.map((p) => p.id).filter((id) => id != null);
  const linkFlagsById = await productsService.getMarketplaceLinkFlagsByProductIds(productIds);

  const items = skuList.map((sku) => {
    const product = productBySku.get(String(sku).trim().toLowerCase());
    const exists = !!product;
    const flags = exists ? linkFlagsById.get(String(product.id)) : null;
    const marketplaces = Array.isArray(flags?.marketplaces) ? flags.marketplaces : [];
    return {
      sku,
      exists,
      product_id: product?.id ?? null,
      product_name: product?.name ?? null,
      on_marketplace: marketplaces.length > 0,
      marketplaces,
    };
  });

  const createdCount = items.filter((x) => x.exists).length;
  const marketplaceCount = items.filter((x) => x.on_marketplace).length;
  return {
    items,
    total: items.length,
    createdCount,
    missingCount: items.length - createdCount,
    marketplaceCount,
    marketplacePendingCount: createdCount - marketplaceCount,
  };
}

export async function updateTask(task, {
  profileId,
  title,
  description,
  assigneeId,
  skuList,
  taskType,
}) {
  if (!task || task.status !== 'open') {
    const err = new Error('Задача уже закрыта');
    err.statusCode = 400;
    throw err;
  }
  const trimmedTitle = String(title || '').trim();
  if (!trimmedTitle) {
    const err = new Error('Укажите название задачи');
    err.statusCode = 400;
    throw err;
  }

  const updates = {
    title: trimmedTitle,
    description: description != null ? String(description).trim() || null : null,
  };

  if (assigneeId != null && assigneeId !== '') {
    const nextId = Number(assigneeId);
    if (!nextId || Number.isNaN(nextId)) {
      const err = new Error('Укажите исполнителя');
      err.statusCode = 400;
      throw err;
    }
    const u = await usersRepository.findById(nextId);
    if (!u || Number(u.profile_id) !== Number(profileId)) {
      const err = new Error('Исполнитель не найден в этом аккаунте');
      err.statusCode = 400;
      throw err;
    }
    updates.assigneeId = nextId;
  }

  const normalizedSkuList = normalizeSkuList(skuList);
  const meta = parseTaskMeta(task.meta);
  const requestedType = String(taskType || '').trim().toLowerCase();
  const wantProductCreate =
    requestedType === 'product_create' ||
    (requestedType !== 'text' && (task.task_type === 'product_create' || normalizedSkuList.length > 0));

  if (wantProductCreate) {
    if (normalizedSkuList.length === 0) {
      const err = new Error('Для задачи на создание товаров укажите список артикулов');
      err.statusCode = 400;
      throw err;
    }
    updates.taskType = 'product_create';
    updates.meta = { ...meta, sku_list: normalizedSkuList };
  } else {
    updates.taskType = 'text';
    const nextMeta = { ...meta };
    delete nextMeta.sku_list;
    updates.meta = nextMeta;
  }

  return employeeTasksRepository.update(task.id, updates);
}

export async function reassignTask(task, assigneeId, profileId) {
  const nextId = Number(assigneeId);
  if (!nextId || Number.isNaN(nextId)) {
    const err = new Error('Укажите исполнителя');
    err.statusCode = 400;
    throw err;
  }
  const u = await usersRepository.findById(nextId);
  if (!u || Number(u.profile_id) !== Number(profileId)) {
    const err = new Error('Исполнитель не найден в этом аккаунте');
    err.statusCode = 400;
    throw err;
  }
  return employeeTasksRepository.update(task.id, { assigneeId: nextId });
}

export default {
  createTextTask,
  updateTask,
  completeTask,
  getProductCreateTaskStatus,
  normalizeSkuList,
  reassignTask,
  canManageTasks,
  canEditTask,
  isTaskCreator,
  isWarehouseManagerUser,
  isAccountAdminUser,
  resolveDefaultAssigneeId,
};
