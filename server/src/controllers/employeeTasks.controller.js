/**
 * Employee Tasks Controller
 */

import repositoryFactory from '../config/repository-factory.js';
import { tenantListProfileId, TENANT_LIST_EMPTY } from '../utils/tenantListProfileId.js';
import employeeTasksService, {
  canManageTasks,
  canEditTask,
  isAccountAdminUser,
} from '../services/employeeTasks.service.js';
import employeeTasksRepository from '../repositories/employee_tasks.repository.pg.js';

function requireProfile(req, res) {
  const tid = tenantListProfileId(req);
  if (tid === TENANT_LIST_EMPTY || tid == null) {
    res.status(403).json({ ok: false, message: 'Нет привязки к аккаунту' });
    return null;
  }
  return tid;
}

async function assertTaskAccess(taskId, profileId) {
  const task = await employeeTasksRepository.findById(taskId);
  if (!task) {
    const err = new Error('Задача не найдена');
    err.statusCode = 404;
    throw err;
  }
  if (Number(task.profile_id) !== Number(profileId)) {
    const err = new Error('Нет доступа');
    err.statusCode = 403;
    throw err;
  }
  return task;
}

export const employeeTasksController = {
  async getAll(req, res, next) {
    try {
      const profileId = requireProfile(req, res);
      if (profileId == null) return;
      const status = req.query.status ? String(req.query.status) : undefined;
      const mine = req.query.mine === '1' || req.query.mine === 'true';
      const manage = canManageTasks(req.user) || isAccountAdminUser(req.user);
      const list = await employeeTasksRepository.findAll({
        profileId,
        status: status || undefined,
        involvedUserId: !manage || mine ? req.user.id : undefined,
      });
      res.json({ ok: true, data: list });
    } catch (error) {
      next(error);
    }
  },

  /** GET /employee-tasks/stats — openCount для бейджа в меню (только задачи текущего исполнителя) */
  async getStats(req, res, next) {
    try {
      const profileId = requireProfile(req, res);
      if (profileId == null) return;
      const openCount = await employeeTasksRepository.countOpen({
        profileId,
        assigneeId: req.user.id,
      });
      res.json({ ok: true, data: { openCount } });
    } catch (error) {
      next(error);
    }
  },

  async create(req, res, next) {
    try {
      const profileId = requireProfile(req, res);
      if (profileId == null) return;
      const { title, description, assigneeId, assignee_id, skuList, sku_list, taskType, task_type } = req.body || {};
      const task = await employeeTasksService.createTextTask({
        profileId,
        title,
        description,
        assigneeId: assigneeId ?? assignee_id,
        createdById: req.user?.id ?? null,
        skuList: skuList ?? sku_list,
        taskType: taskType ?? task_type,
      });
      res.status(201).json({ ok: true, data: task });
    } catch (error) {
      next(error);
    }
  },

  async update(req, res, next) {
    try {
      const profileId = requireProfile(req, res);
      if (profileId == null) return;
      const task = await assertTaskAccess(req.params.id, profileId);
      if (!canEditTask(task, req.user)) {
        return res.status(403).json({
          ok: false,
          message: 'Редактировать может только создатель задачи, руководитель склада или администратор',
        });
      }
      if (task.status !== 'open') {
        return res.status(400).json({ ok: false, message: 'Задача уже закрыта' });
      }
      const { title, description, assigneeId, assignee_id, skuList, sku_list, taskType, task_type } = req.body || {};
      const updated = await employeeTasksService.updateTask(task, {
        profileId,
        title,
        description,
        assigneeId: assigneeId ?? assignee_id,
        skuList: skuList ?? sku_list,
        taskType: taskType ?? task_type,
      });
      res.json({ ok: true, data: updated });
    } catch (error) {
      next(error);
    }
  },

  async getProductCreateStatus(req, res, next) {
    try {
      const profileId = requireProfile(req, res);
      if (profileId == null) return;
      const task = await assertTaskAccess(req.params.id, profileId);
      const data = await employeeTasksService.getProductCreateTaskStatus(task, profileId);
      res.json({ ok: true, data });
    } catch (error) {
      next(error);
    }
  },

  async complete(req, res, next) {
    try {
      const profileId = requireProfile(req, res);
      if (profileId == null) return;
      const task = await assertTaskAccess(req.params.id, profileId);
      if (task.status !== 'open') {
        return res.status(400).json({ ok: false, message: 'Задача уже закрыта' });
      }
      const manage = canManageTasks(req.user);
      const isAssignee = task.assignee_id != null && Number(task.assignee_id) === Number(req.user.id);
      if (!manage && !isAssignee) {
        return res.status(403).json({ ok: false, message: 'Выполнить может только исполнитель или руководитель склада' });
      }
      const updated = await employeeTasksService.completeTask(task, req.user.id);
      res.json({ ok: true, data: updated });
    } catch (error) {
      next(error);
    }
  },

  async reassign(req, res, next) {
    try {
      const profileId = requireProfile(req, res);
      if (profileId == null) return;
      if (!canManageTasks(req.user)) {
        return res.status(403).json({
          ok: false,
          message: 'Переадресовать задачу может руководитель склада или администратор',
        });
      }
      const task = await assertTaskAccess(req.params.id, profileId);
      if (task.status !== 'open') {
        return res.status(400).json({ ok: false, message: 'Задача уже закрыта' });
      }
      const assigneeId = req.body?.assigneeId ?? req.body?.assignee_id;
      const updated = await employeeTasksService.reassignTask(task, assigneeId, profileId);
      res.json({ ok: true, data: updated });
    } catch (error) {
      next(error);
    }
  },
};
