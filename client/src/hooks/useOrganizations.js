/**
 * useOrganizations Hook
 */

import { useState, useEffect } from 'react';
import { organizationsApi } from '../services/organizations.api';

export function useOrganizations() {
  const [organizations, setOrganizations] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);

  useEffect(() => {
    loadOrganizations();
  }, []);

  const loadOrganizations = async () => {
    try {
      setLoading(true);
      setError(null);
      const response = await organizationsApi.getAll();
      setOrganizations(response.data || []);
    } catch (err) {
      console.error('Error loading organizations:', err);
      setError(err.message || 'Ошибка загрузки организаций');
    } finally {
      setLoading(false);
    }
  };

  const createOrganization = async (data) => {
    try {
      const response = await organizationsApi.create(data);
      setOrganizations(prev => [...prev, response.data]);
      return response.data;
    } catch (err) {
      console.error('Error creating organization:', err);
      throw err;
    }
  };

  const updateOrganization = async (id, data) => {
    try {
      const response = await organizationsApi.update(id, data);
      setOrganizations(prev => prev.map(org => org.id === id ? response.data : org));
      return response.data;
    } catch (err) {
      console.error('Error updating organization:', err);
      throw err;
    }
  };

  const deleteOrganization = async (id) => {
    try {
      await organizationsApi.delete(id);
      setOrganizations(prev => prev.filter(org => org.id !== id));
    } catch (err) {
      console.error('Error deleting organization:', err);
      throw err;
    }
  };

  return {
    organizations,
    loading,
    error,
    loadOrganizations,
    createOrganization,
    updateOrganization,
    deleteOrganization
  };
}
