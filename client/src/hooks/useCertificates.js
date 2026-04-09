/**
 * useCertificates
 */

import { useEffect, useState } from 'react';
import { certificatesApi } from '../services/certificates.api';

export function useCertificates() {
  const [items, setItems] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');

  const load = async (opts = {}) => {
    try {
      setLoading(true);
      setError('');
      const res = await certificatesApi.getAll(opts);
      setItems(res?.data || []);
    } catch (e) {
      setError(e?.message || 'Ошибка загрузки сертификатов');
      setItems([]);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    load();
  }, []);

  const create = async (data) => {
    const res = await certificatesApi.create(data);
    const created = res?.data;
    if (created) setItems((prev) => [created, ...prev]);
    return created;
  };

  const update = async (id, updates) => {
    const res = await certificatesApi.update(id, updates);
    const updated = res?.data;
    if (updated) setItems((prev) => prev.map((x) => String(x.id) === String(id) ? updated : x));
    return updated;
  };

  const remove = async (id) => {
    await certificatesApi.remove(id);
    setItems((prev) => prev.filter((x) => String(x.id) !== String(id)));
  };

  return { items, loading, error, load, create, update, remove };
}

