import api from './api.js';

export const demoUxApi = {
  get: async () => {
    const r = await api.get('/users/me/ux-progress');
    return r.data?.data ?? r.data;
  },
  patch: async (body) => {
    const r = await api.patch('/users/me/ux-progress', body);
    return r.data?.data ?? r.data;
  },
  completeStep: async (stepId) => {
    const r = await api.patch('/users/me/ux-progress', { completeStep: stepId });
    return r.data?.data ?? r.data;
  },
  dismissHint: async (hintKey) => {
    const r = await api.patch('/users/me/ux-progress', { dismissHint: hintKey });
    return r.data?.data ?? r.data;
  },
  dismissChecklist: async () => {
    const r = await api.patch('/users/me/ux-progress', { checklistDismissed: true });
    return r.data?.data ?? r.data;
  },
  extendDemo: async () => {
    const r = await api.post('/users/me/demo-extend');
    return r.data?.data ?? r.data;
  },
};
