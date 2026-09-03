import api from './api.js';

export const categoryVideoCoverTemplatesApi = {
  getAll: async () => {
    const response = await api.get('/category-video-cover-templates');
    return response.data;
  },

  getByCategoryId: async (categoryId) => {
    const response = await api.get(`/category-video-cover-templates/by-category/${categoryId}`);
    return response.data;
  },

  save: async (categoryId, settings) => {
    const response = await api.put(`/category-video-cover-templates/by-category/${categoryId}`, {
      settings,
    });
    return response.data;
  },

  getShared: async () => {
    const response = await api.get('/category-video-cover-templates/shared');
    return response.data;
  },

  saveShared: async (settings) => {
    const response = await api.put('/category-video-cover-templates/shared', { settings });
    return response.data;
  },

  deleteShared: async () => {
    const response = await api.delete('/category-video-cover-templates/shared');
    return response.data;
  },

  delete: async (categoryId) => {
    const response = await api.delete(`/category-video-cover-templates/by-category/${categoryId}`);
    return response.data;
  },
};
