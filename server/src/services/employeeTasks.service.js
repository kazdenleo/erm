/**
 * Employee Tasks Service
 */

import employeeTasksRepository from '../repositories/employee_tasks.repository.pg.js';
import usersRepository from '../repositories/users.repository.pg.js';
import productsService from './products.service.js';

const MP_TITLE = {
  ozon: 'Ozon',
  wb: 'Wildberries',
  ym: 'Яндекс.Маркет',
};

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
  return employeeTasksRepository.create({
    profileId,
    title: trimmedTitle,
    description: description != null ? String(description).trim() || null : null,
    taskType: normalizedSkuList.length > 0 ? 'product_create' : 'text',
    assigneeId: assignee,
    createdById: createdById ?? null,
    meta: normalizedSkuList.length > 0 ? { sku_list: normalizedSkuList } : {},
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

function buildDimensionsTaskContent(items) {
  const list = Array.isArray(items) ? items : [];
  const count = list.length;
  const title =
    count <= 0
      ? 'Проверить габариты товаров'
      : `Проверить габариты (${count} ${count === 1 ? 'товар' : count < 5 ? 'товара' : 'товаров'})`;

  const lines = list.map((it) => {
    const sku = String(it.sku || `#${it.product_id}`).trim();
    const mps = Array.isArray(it.marketplaces)
      ? it.marketplaces
      : it.marketplace
        ? [it.marketplace]
        : [];
    const mpPart = mps.length
      ? ` [${mps.map((m) => MP_TITLE[m] || String(m).toUpperCase()).join(', ')}]`
      : '';
    const name = String(it.name || '').trim();
    const namePart = name ? ` — ${name.slice(0, 80)}` : '';
    return `• ${sku}${namePart}${mpPart}`;
  });

  const description =
    'После автоматического обновления карточек с маркетплейсов изменились габариты/вес. ' +
    'Проверьте и при необходимости обновите габариты в карточках товаров:\n\n' +
    (lines.length ? lines.join('\n') : '—');

  return { title, description, count };
}

/**
 * Автозадача: одна открытая «проверить габариты» на аккаунт.
 * Новые артикулы дописываются в существующую задачу; новая не создаётся, пока текущая не выполнена.
 */
export async function createDimensionsCheckTaskIfNeeded({
  profileId,
  product,
  marketplace,
  changedLabels = [],
}) {
  if (profileId == null || profileId === '') return null;
  if (!product?.id) return null;
  const labels = Array.isArray(changedLabels) ? changedLabels : [];
  const dimHit =
    labels.includes('габариты/вес') ||
    labels.some((l) =>
      ['длина упаковки', 'ширина упаковки', 'высота упаковки', 'вес упаковки'].includes(l)
    );
  if (!dimHit) return null;

  const mp = String(marketplace || '').trim().toLowerCase() || null;
  const sku = String(product.sku || '').trim() || `#${product.id}`;
  const name = String(product.name || '').trim();
  const productId = Number(product.id);
  const nowIso = new Date().toISOString();

  const entry = {
    product_id: productId,
    sku,
    name: name ? name.slice(0, 200) : null,
    marketplaces: mp ? [mp] : [],
    fields: labels,
    updated_at: nowIso,
  };

  const existing = await employeeTasksRepository.findOpenByType({
    profileId,
    taskType: 'dimensions_check',
  });

  if (existing) {
    const meta = parseTaskMeta(existing.meta);
    const items = Array.isArray(meta.items) ? [...meta.items] : [];
    const idx = items.findIndex((it) => Number(it?.product_id) === productId);
    if (idx >= 0) {
      const prev = items[idx] || {};
      const prevMps = Array.isArray(prev.marketplaces)
        ? prev.marketplaces
        : prev.marketplace
          ? [prev.marketplace]
          : [];
      const nextMps = [...new Set([...prevMps.map((x) => String(x).toLowerCase()), ...(mp ? [mp] : [])])];
      items[idx] = {
        ...prev,
        ...entry,
        marketplaces: nextMps,
        fields: [...new Set([...(Array.isArray(prev.fields) ? prev.fields : []), ...labels])],
      };
    } else {
      items.push(entry);
    }
    items.sort((a, b) => String(a.sku || '').localeCompare(String(b.sku || ''), 'ru'));
    const content = buildDimensionsTaskContent(items);
    return employeeTasksRepository.update(existing.id, {
      title: content.title,
      description: content.description,
      meta: {
        ...meta,
        items,
        count: content.count,
      },
    });
  }

  const items = [entry];
  const content = buildDimensionsTaskContent(items);
  const assigneeId = await resolveDefaultAssigneeId(profileId);

  return employeeTasksRepository.create({
    profileId,
    title: content.title,
    description: content.description,
    taskType: 'dimensions_check',
    assigneeId,
    createdById: null,
    productId: null,
    marketplace: null,
    meta: {
      items,
      count: content.count,
    },
  });
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
    return { items: [], total: 0, createdCount: 0, missingCount: 0 };
  }
  const meta = parseTaskMeta(task.meta);
  const skuList = normalizeSkuList(meta.sku_list);
  const items = await Promise.all(
    skuList.map(async (sku) => {
      const product = await productsService.getBySku(sku, { profileId });
      return {
        sku,
        exists: !!product,
        product_id: product?.id ?? null,
        product_name: product?.name ?? null,
      };
    })
  );
  return {
    items,
    total: items.length,
    createdCount: items.filter((x) => x.exists).length,
    missingCount: items.filter((x) => !x.exists).length,
  };
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
  createDimensionsCheckTaskIfNeeded,
  completeTask,
  getProductCreateTaskStatus,
  normalizeSkuList,
  reassignTask,
  canManageTasks,
  isWarehouseManagerUser,
  isAccountAdminUser,
  resolveDefaultAssigneeId,
};
