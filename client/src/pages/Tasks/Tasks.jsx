/**
 * Tasks Page — задачи сотрудникам
 */

import React, { useEffect, useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { useEmployeeTasks } from '../../hooks/useEmployeeTasks';
import { useAuth } from '../../context/AuthContext';
import { usersApi } from '../../services/users.api';
import { Button } from '../../components/common/Button/Button';
import { Modal } from '../../components/common/Modal/Modal';
import './Tasks.css';

function userDisplayName(u) {
  if (!u) return '—';
  const name =
    u.full_name ||
    [u.last_name, u.first_name, u.middle_name].filter(Boolean).join(' ').trim() ||
    u.email ||
    `#${u.id}`;
  return name;
}

function taskCreatorLabel(task) {
  return (
    task.created_by_full_name ||
    task.created_by_email ||
    (task.created_by_id != null ? `#${task.created_by_id}` : 'Система')
  );
}

function formatDate(v) {
  if (!v) return '—';
  try {
    return new Date(v).toLocaleString('ru-RU');
  } catch {
    return String(v);
  }
}

function formatDateShort(v) {
  if (!v) return '—';
  try {
    return new Date(v).toLocaleDateString('ru-RU');
  } catch {
    return String(v);
  }
}

function dimItemsOf(task) {
  return Array.isArray(task?.meta?.items) ? task.meta.items : [];
}

function productCreateSkuListOf(task) {
  return Array.isArray(task?.meta?.sku_list) ? task.meta.sku_list : [];
}

function taskPreviewMeta(task) {
  const isDimensions = task.task_type === 'dimensions_check';
  const dimItems = dimItemsOf(task);
  if (isDimensions && dimItems.length > 0) {
    const n = dimItems.length;
    return `${n} ${n === 1 ? 'артикул' : n < 5 ? 'артикула' : 'артикулов'}`;
  }
  if (task.task_type === 'product_create') {
    const n = productCreateSkuListOf(task).length;
    if (n > 0) {
      return `${n} ${n === 1 ? 'артикул' : n < 5 ? 'артикула' : 'артикулов'}`;
    }
  }
  return null;
}

export function Tasks() {
  const { user, accountRole, isAccountAdmin } = useAuth();
  const { tasks, loading, error, createTask, updateTask, completeTask, reassignTask, getProductCreateStatus } = useEmployeeTasks();
  const [statusFilter, setStatusFilter] = useState('open');
  const [selectedId, setSelectedId] = useState(null);
  const [isModalOpen, setIsModalOpen] = useState(false);
  const [editingId, setEditingId] = useState(null);
  const [title, setTitle] = useState('');
  const [description, setDescription] = useState('');
  const [skuListText, setSkuListText] = useState('');
  const [assigneeId, setAssigneeId] = useState('');
  const [candidates, setCandidates] = useState([]);
  const [saving, setSaving] = useState(false);
  const [reassignFor, setReassignFor] = useState(null);
  const [reassignId, setReassignId] = useState('');
  const [productCreateStatus, setProductCreateStatus] = useState(null);
  const [productCreateLoading, setProductCreateLoading] = useState(false);

  const canManage =
    isAccountAdmin ||
    String(accountRole || '').toLowerCase() === 'warehouse_manager';

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const res = await usersApi.getInviteCandidates();
        if (!cancelled) setCandidates(res.data || []);
      } catch (e) {
        console.error('Failed to load assignees', e);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  const filtered = useMemo(() => {
    if (statusFilter === 'all') return tasks;
    return tasks.filter((t) => t.status === statusFilter);
  }, [tasks, statusFilter]);

  const selectedTask = useMemo(() => {
    if (selectedId == null) return null;
    return tasks.find((t) => Number(t.id) === Number(selectedId)) || null;
  }, [tasks, selectedId]);

  useEffect(() => {
    if (selectedId == null) return;
    if (!tasks.some((t) => Number(t.id) === Number(selectedId))) {
      setSelectedId(null);
    }
  }, [tasks, selectedId]);

  const selectedTaskId = selectedTask?.id;
  const selectedTaskType = selectedTask?.task_type;
  const selectedSkuKey =
    selectedTaskType === 'product_create'
      ? productCreateSkuListOf(selectedTask).join('\n')
      : '';

  useEffect(() => {
    if (selectedTaskType !== 'product_create' || selectedTaskId == null) {
      setProductCreateStatus(null);
      setProductCreateLoading(false);
      return undefined;
    }
    let cancelled = false;
    setProductCreateLoading(true);
    (async () => {
      try {
        const data = await getProductCreateStatus(selectedTaskId);
        if (!cancelled) setProductCreateStatus(data);
      } catch (e) {
        if (!cancelled) {
          setProductCreateStatus({
            items: [],
            total: 0,
            createdCount: 0,
            missingCount: 0,
            error: e?.message || String(e),
          });
        }
      } finally {
        if (!cancelled) setProductCreateLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [getProductCreateStatus, selectedTaskId, selectedTaskType, selectedSkuKey]);

  const closeFormModal = () => {
    setIsModalOpen(false);
    setEditingId(null);
  };

  const openCreate = () => {
    setEditingId(null);
    setTitle('');
    setDescription('');
    setSkuListText('');
    const defaultManager = candidates.find(
      (c) => String(c.account_role || '').toLowerCase() === 'warehouse_manager'
    );
    const defaultAdmin = candidates.find(
      (c) =>
        String(c.account_role || '').toLowerCase() === 'admin' ||
        c.is_profile_admin === true
    );
    const fallback = defaultManager || defaultAdmin;
    setAssigneeId(fallback ? String(fallback.id) : '');
    setIsModalOpen(true);
  };

  const openEdit = (task) => {
    setEditingId(task.id);
    setTitle(task.title || '');
    setDescription(task.description || '');
    setSkuListText(
      task.task_type === 'dimensions_check' ? '' : productCreateSkuListOf(task).join('\n')
    );
    setAssigneeId(task.assignee_id != null ? String(task.assignee_id) : '');
    setIsModalOpen(true);
  };

  const handleSave = async (e) => {
    e.preventDefault();
    if (!title.trim()) {
      alert('Укажите название задачи');
      return;
    }
    const payload = {
      title: title.trim(),
      description: description.trim() || null,
      skuList: skuListText,
      assigneeId: assigneeId ? Number(assigneeId) : null,
    };
    try {
      setSaving(true);
      if (editingId) {
        const updated = await updateTask(editingId, payload);
        closeFormModal();
        if (updated?.id != null) setSelectedId(updated.id);
      } else {
        const created = await createTask(payload);
        closeFormModal();
        if (created?.id != null) setSelectedId(created.id);
      }
    } catch (err) {
      alert(
        (editingId ? 'Ошибка сохранения задачи: ' : 'Ошибка создания задачи: ') +
          (err.response?.data?.message || err.message || String(err))
      );
    } finally {
      setSaving(false);
    }
  };

  const handleComplete = async (task) => {
    if (!window.confirm('Отметить задачу выполненной?')) return;
    try {
      await completeTask(task.id);
    } catch (err) {
      alert('Ошибка: ' + (err.message || String(err)));
    }
  };

  const handleReassign = async (e) => {
    e.preventDefault();
    if (!reassignFor || !reassignId) return;
    try {
      setSaving(true);
      await reassignTask(reassignFor.id, Number(reassignId));
      setReassignFor(null);
      setReassignId('');
    } catch (err) {
      alert('Ошибка переадресации: ' + (err.message || String(err)));
    } finally {
      setSaving(false);
    }
  };

  const editingTask =
    editingId != null
      ? tasks.find((t) => Number(t.id) === Number(editingId)) || null
      : null;
  const hideSkuField = editingTask?.task_type === 'dimensions_check';

  const formModal = (
    <Modal
      isOpen={isModalOpen}
      onClose={closeFormModal}
      title={editingId ? 'Редактировать задачу' : 'Новая задача'}
      size="md"
    >
      <form className="task-form" onSubmit={handleSave}>
        <label>
          Название
          <input
            type="text"
            value={title}
            onChange={(e) => setTitle(e.target.value)}
            placeholder="Кратко, что сделать"
            required
          />
        </label>
        <label>
          Описание
          <textarea
            rows={4}
            value={description}
            onChange={(e) => setDescription(e.target.value)}
            placeholder="Подробности (необязательно)"
          />
        </label>
        {!hideSkuField && (
          <label>
            Артикулы для создания товаров
            <textarea
              rows={5}
              value={skuListText}
              onChange={(e) => setSkuListText(e.target.value)}
              placeholder="По одному на строку или через запятую"
            />
          </label>
        )}
        <label>
          Исполнитель
          <select
            value={assigneeId}
            onChange={(e) => setAssigneeId(e.target.value)}
          >
            <option value="">Руководитель склада, иначе администратор</option>
            {candidates.map((c) => (
              <option key={c.id} value={c.id}>
                {userDisplayName(c)}
              </option>
            ))}
          </select>
        </label>
        <div className="task-form-actions">
          <Button
            type="button"
            variant="secondary"
            onClick={closeFormModal}
            disabled={saving}
          >
            Отмена
          </Button>
          <Button type="submit" variant="primary" disabled={saving}>
            {saving ? 'Сохранение…' : editingId ? 'Сохранить' : 'Создать'}
          </Button>
        </div>
      </form>
    </Modal>
  );

  if (loading) {
    return <div className="loading">Загрузка задач...</div>;
  }

  if (error) {
    return <div className="error">Ошибка: {error}</div>;
  }

  if (selectedTask) {
    const task = selectedTask;
    const isOpen = task.status === 'open';
    const isAssignee =
      task.assignee_id != null && Number(task.assignee_id) === Number(user?.id);
    const isCreator =
      task.created_by_id != null && Number(task.created_by_id) === Number(user?.id);
    const canEdit = isOpen && (canManage || isCreator);
    const dimItems = dimItemsOf(task);
    const isDimensions = task.task_type === 'dimensions_check';
    const isProductCreate = task.task_type === 'product_create';
    const productUrl =
      task.meta?.url ||
      (task.product_id ? `/products?open=${task.product_id}` : null) ||
      (dimItems[0]?.product_id ? `/products?open=${dimItems[0].product_id}` : null);

    return (
      <div className="card">
        <div className="tasks-detail-top">
          <Button
            size="small"
            variant="secondary"
            onClick={() => setSelectedId(null)}
          >
            ← К списку
          </Button>
        </div>

        <h1 className="title">{task.title}</h1>
        <div className="task-meta" style={{ marginTop: 8 }}>
          <span className={`task-badge ${isOpen ? 'open' : 'done'}`}>
            {isOpen ? 'Открыта' : 'Выполнена'}
          </span>
          {isDimensions && <span className="task-badge">Габариты</span>}
          {isProductCreate && <span className="task-badge">Создание товаров</span>}
          <span>Исполнитель: {taskAssigneeLabel(task)}</span>
          <span>Создатель: {taskCreatorLabel(task)}</span>
          <span>Создана: {formatDate(task.created_at)}</span>
          {task.updated_at && task.updated_at !== task.created_at && (
            <span>Обновлена: {formatDate(task.updated_at)}</span>
          )}
        </div>

        {isDimensions && dimItems.length > 0 ? (
          <div className="task-desc">
            <div style={{ marginBottom: 8 }}>
              После обновления с маркетплейсов изменились габариты/вес. Проверьте товары:
            </div>
            <ul className="task-sku-list">
              {dimItems.map((it) => {
                const sku = it.sku || `#${it.product_id}`;
                const href = it.product_id ? `/products?open=${it.product_id}` : null;
                const mps = Array.isArray(it.marketplaces)
                  ? it.marketplaces
                  : it.marketplace
                    ? [it.marketplace]
                    : [];
                return (
                  <li key={String(it.product_id)}>
                    {href ? <Link to={href}>{sku}</Link> : sku}
                    {it.name ? ` — ${it.name}` : ''}
                    {mps.length
                      ? ` [${mps.map((m) => String(m).toUpperCase()).join(', ')}]`
                      : ''}
                  </li>
                );
              })}
            </ul>
          </div>
        ) : isProductCreate ? (
          <div className="task-desc">
            <div style={{ marginBottom: 8 }}>
              Список артикулов для создания товаров:
            </div>
            {productCreateStatus?.error ? (
              <div className="task-create-status-summary">Ошибка проверки: {productCreateStatus.error}</div>
            ) : productCreateLoading ? (
              <div className="task-create-status-summary">Сверяем с базой...</div>
            ) : (
              <div className="task-create-status-summary">
                Уже созданы: {productCreateStatus?.createdCount || 0} · Ещё не созданы: {productCreateStatus?.missingCount || 0}
              </div>
            )}
            <ul className="task-sku-list">
              {(productCreateStatus?.items?.length
                ? productCreateStatus.items
                : productCreateSkuListOf(task).map((sku) => ({ sku, exists: null }))
              ).map((it) => (
                <li key={it.sku}>
                  {it.exists && it.product_id ? (
                    <Link to={`/products?open=${it.product_id}`}>{it.sku}</Link>
                  ) : (
                    it.sku
                  )}
                  {' — '}
                  <span className={`task-create-state ${it.exists === true ? 'is-exists' : it.exists === false ? 'is-missing' : ''}`}>
                    {it.exists === true
                      ? `уже создан${it.product_name ? ` (${it.product_name})` : ''}`
                      : it.exists === false
                        ? 'ещё не создан'
                        : 'проверяем'}
                  </span>
                </li>
              ))}
            </ul>
          </div>
        ) : (
          task.description && <div className="task-desc">{task.description}</div>
        )}

        {!isDimensions && task.product_sku && (
          <div className="task-meta" style={{ marginTop: 12 }}>
            <span>
              Товар:{' '}
              {productUrl ? (
                <Link to={productUrl}>{task.product_sku}</Link>
              ) : (
                task.product_sku
              )}
            </span>
          </div>
        )}

        {isOpen && (
          <div className="task-actions">
            {(canManage || isAssignee) && (
              <Button
                size="small"
                variant="success"
                onClick={() => handleComplete(task)}
              >
                Выполнить
              </Button>
            )}
            {canEdit && (
              <Button
                size="small"
                variant="secondary"
                onClick={() => openEdit(task)}
              >
                Редактировать
              </Button>
            )}
            {canManage && (
              <Button
                size="small"
                variant="secondary"
                onClick={() => {
                  setReassignFor(task);
                  setReassignId(
                    task.assignee_id != null ? String(task.assignee_id) : ''
                  );
                }}
              >
                Переадресовать
              </Button>
            )}
            {!isDimensions && productUrl && (
              <Link to={productUrl}>
                <Button size="small" variant="secondary">
                  Открыть товар
                </Button>
              </Link>
            )}
          </div>
        )}

        <Modal
          isOpen={!!reassignFor}
          onClose={() => setReassignFor(null)}
          title="Переадресовать задачу"
          size="md"
        >
          <form className="task-form" onSubmit={handleReassign}>
            <p style={{ margin: 0, fontSize: 13 }}>{reassignFor?.title}</p>
            <label>
              Новый исполнитель
              <select
                value={reassignId}
                onChange={(e) => setReassignId(e.target.value)}
                required
              >
                <option value="" disabled>
                  Выберите сотрудника
                </option>
                {candidates.map((c) => (
                  <option key={c.id} value={c.id}>
                    {userDisplayName(c)}
                  </option>
                ))}
              </select>
            </label>
            <div className="task-form-actions">
              <Button
                type="button"
                variant="secondary"
                onClick={() => setReassignFor(null)}
                disabled={saving}
              >
                Отмена
              </Button>
              <Button type="submit" variant="primary" disabled={saving || !reassignId}>
                {saving ? 'Сохранение…' : 'Переадресовать'}
              </Button>
            </div>
          </form>
        </Modal>
        {formModal}
      </div>
    );
  }

  return (
    <div className="card">
      <h1 className="title">Задачи</h1>
      <p className="subtitle">
        Выберите задачу, чтобы открыть подробности. По умолчанию назначаются на руководителя склада.
      </p>

      <div className="tasks-toolbar">
        <div className="tasks-filters">
          <Button
            size="small"
            variant={statusFilter === 'open' ? 'primary' : 'secondary'}
            onClick={() => setStatusFilter('open')}
          >
            Открытые
          </Button>
          <Button
            size="small"
            variant={statusFilter === 'done' ? 'primary' : 'secondary'}
            onClick={() => setStatusFilter('done')}
          >
            Выполненные
          </Button>
          <Button
            size="small"
            variant={statusFilter === 'all' ? 'primary' : 'secondary'}
            onClick={() => setStatusFilter('all')}
          >
            Все
          </Button>
        </div>
        <Button variant="primary" onClick={openCreate}>
          Создать задачу
        </Button>
      </div>

      <div className="tasks-list">
        {filtered.length === 0 ? (
          <div className="empty-state">
            <p>Задач пока нет</p>
            <Button onClick={openCreate}>Создать первую задачу</Button>
          </div>
        ) : (
          filtered.map((task) => {
            const isOpen = task.status === 'open';
            const isDimensions = task.task_type === 'dimensions_check';
            const isProductCreate = task.task_type === 'product_create';
            const preview = taskPreviewMeta(task);
            return (
              <button
                type="button"
                key={task.id}
                className={`task-item task-item--row${isOpen ? '' : ' is-done'}`}
                onClick={() => setSelectedId(task.id)}
              >
                <div className="task-row-main">
                  <div className="task-title">{task.title}</div>
                  <div className="task-meta">
                    <span className={`task-badge ${isOpen ? 'open' : 'done'}`}>
                      {isOpen ? 'Открыта' : 'Выполнена'}
                    </span>
                    {isDimensions && <span className="task-badge">Габариты</span>}
                    {isProductCreate && <span className="task-badge">Создание товаров</span>}
                    {preview && <span>{preview}</span>}
                    <span>{taskAssigneeLabel(task)}</span>
                    <span>{formatDateShort(task.created_at)}</span>
                  </div>
                </div>
                <span className="task-row-chevron" aria-hidden>
                  ›
                </span>
              </button>
            );
          })
        )}
      </div>

      {formModal}
    </div>
  );
}
