/**
 * useEmployeeTasks Hook
 */

import { useState, useEffect, useCallback } from 'react';
import { employeeTasksApi } from '../services/employeeTasks.api';

export function useEmployeeTasks() {
  const [tasks, setTasks] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);

  const loadTasks = useCallback(async () => {
    try {
      setLoading(true);
      setError(null);
      const response = await employeeTasksApi.getAll();
      setTasks(response.data || []);
    } catch (err) {
      console.error('Error loading tasks:', err);
      setError(err.message || 'Ошибка загрузки задач');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    loadTasks();
  }, [loadTasks]);

  const createTask = async (data) => {
    const response = await employeeTasksApi.create(data);
    setTasks((prev) => [response.data, ...prev]);
    window.dispatchEvent(new Event('employee-tasks-stats-refresh'));
    return response.data;
  };

  const updateTask = async (id, data) => {
    const response = await employeeTasksApi.update(id, data);
    setTasks((prev) => prev.map((t) => (t.id === id ? response.data : t)));
    window.dispatchEvent(new Event('employee-tasks-stats-refresh'));
    return response.data;
  };

  const completeTask = async (id) => {
    const response = await employeeTasksApi.complete(id);
    setTasks((prev) => prev.map((t) => (t.id === id ? response.data : t)));
    window.dispatchEvent(new Event('employee-tasks-stats-refresh'));
    return response.data;
  };

  const reassignTask = async (id, assigneeId) => {
    const response = await employeeTasksApi.reassign(id, assigneeId);
    setTasks((prev) => prev.map((t) => (t.id === id ? response.data : t)));
    window.dispatchEvent(new Event('employee-tasks-stats-refresh'));
    return response.data;
  };

  const getProductCreateStatus = useCallback(async (id) => {
    const response = await employeeTasksApi.getProductCreateStatus(id);
    return response.data || { items: [], total: 0, createdCount: 0, missingCount: 0 };
  }, []);

  return {
    tasks,
    loading,
    error,
    loadTasks,
    createTask,
    updateTask,
    completeTask,
    getProductCreateStatus,
    reassignTask,
  };
}
