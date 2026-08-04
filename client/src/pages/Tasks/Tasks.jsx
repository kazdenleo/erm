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

function taskAssigneeLabel(task) {
  return (
    task.assignee_full_name ||
    task.assignee_email ||
    (task.assignee_id != null ? `#${task.assignee_id}` : 'Не назначен')
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

function taskPreviewMeta(task) {
  const isDimensions = task.task_type === 'dimensions_check';
  const dimItems = dimItemsOf(task);
  if (isDimensions && dimItems.length > 0) {
    const n = dimItems.length;
    return `${n} ${n === 1 ? 'артикул' : n < 5 ? 'артикула' : 'артикулов'}`;
  }
  return null;
}

export function Tasks() {
  const { user, accountRole, isAccountAdmin } = useAuth();
  const { tasks, loading, error, createTask, completeTask, reassignTask } = useEmployeeTasks();
  const [statusFilter, setStatusFilter] = useState('open');
  const [selectedId, setSelectedId] = useState(null);
  const [isModalOpen, setIsModalOpen] = useState(false);
  const [title, setTitle] = useState('');
  const [description, setDescription] = useState('');
  const [assigneeId, setAssigneeId] = useState('');
  const [candidates, setCandidates] = useState([]);
  const [saving, setSaving] = useState(false);
  const [reassignFor, setReassignFor] = useState(null);
  const [reassignId, setReassignId] = useState('');

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

  const openCreate = () => {
    setTitle('');
    setDescription('');
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

  const handleCreate = async (e) => {
    e.preventDefault();
    if (!title.trim()) {
      alert('Укажите название задачи');
      return;
    }
    try {
      setSaving(true);
      const created = await createTask({
        title: title.trim(),
        description: description.trim() || null,
        assigneeId: assigneeId ? Number(assigneeId) : null,
      });
      setIsModalOpen(false);
      if (created?.id != null) setSelectedId(created.id);
    } catch (err) {
      alert('Ошибка создания задачи: ' + (err.message || String(err)));
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
    const dimItems = dimItemsOf(task);
    const isDimensions = task.task_type === 'dimensions_check';
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
          <span>Исполнитель: {taskAssigneeLabel(task)}</span>
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

      <Modal
        isOpen={isModalOpen}
        onClose={() => setIsModalOpen(false)}
        title="Новая задача"
        size="md"
      >
        <form className="task-form" onSubmit={handleCreate}>
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
              onClick={() => setIsModalOpen(false)}
              disabled={saving}
            >
              Отмена
            </Button>
            <Button type="submit" variant="primary" disabled={saving}>
              {saving ? 'Сохранение…' : 'Создать'}
            </Button>
          </div>
        </form>
      </Modal>
    </div>
  );
}
