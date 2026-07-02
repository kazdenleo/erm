/**
 * Управление шаблонами быстрых ответов на вопросы
 */

import React, { useCallback, useEffect, useState } from 'react';
import { Button } from '../../components/common/Button/Button';
import { Modal } from '../../components/common/Modal/Modal';
import { questionAnswerTemplatesApi } from '../../services/questionAnswerTemplates.api';
import { QuestionTemplateBodyEditor, TemplateBodySnippet } from './QuestionTemplateBodyEditor';

const EMPTY_FORM = { title: '', body: '' };

export function QuestionTemplatesModal({ isOpen, onClose }) {
  const [items, setItems] = useState([]);
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  const [editingId, setEditingId] = useState(null);
  const [form, setForm] = useState(EMPTY_FORM);

  const load = useCallback(async () => {
    try {
      setLoading(true);
      setError('');
      const data = await questionAnswerTemplatesApi.getAll();
      setItems(Array.isArray(data) ? data : []);
    } catch (e) {
      setError(e?.response?.data?.message || e?.message || 'Не удалось загрузить шаблоны');
      setItems([]);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    if (!isOpen) return;
    setEditingId(null);
    setForm(EMPTY_FORM);
    void load();
  }, [isOpen, load]);

  const startEdit = (tpl) => {
    setEditingId(String(tpl.id));
    setForm({ title: tpl.title || '', body: tpl.body || '' });
    setError('');
  };

  const startCreate = () => {
    setEditingId('new');
    setForm(EMPTY_FORM);
    setError('');
  };

  const cancelForm = () => {
    setEditingId(null);
    setForm(EMPTY_FORM);
    setError('');
  };

  const saveForm = async () => {
    const title = String(form.title ?? '').trim();
    const body = String(form.body ?? '');
    if (!title) {
      setError('Укажите название шаблона');
      return;
    }
    try {
      setSaving(true);
      setError('');
      if (editingId === 'new') {
        const created = await questionAnswerTemplatesApi.create({ title, body });
        setItems((prev) => [...prev, created]);
      } else {
        const updated = await questionAnswerTemplatesApi.update(editingId, { title, body });
        setItems((prev) => prev.map((t) => (String(t.id) === String(editingId) ? updated : t)));
      }
      cancelForm();
    } catch (e) {
      setError(e?.response?.data?.message || e?.message || 'Не удалось сохранить шаблон');
    } finally {
      setSaving(false);
    }
  };

  const removeTemplate = async (id) => {
    if (!window.confirm('Удалить этот шаблон?')) return;
    try {
      setSaving(true);
      setError('');
      await questionAnswerTemplatesApi.remove(id);
      setItems((prev) => prev.filter((t) => String(t.id) !== String(id)));
      if (String(editingId) === String(id)) cancelForm();
    } catch (e) {
      setError(e?.response?.data?.message || e?.message || 'Не удалось удалить шаблон');
    } finally {
      setSaving(false);
    }
  };

  return (
    <Modal isOpen={isOpen} onClose={onClose} title="Шаблоны ответов" size="large" usePortal>
      <div className="questions-templates-modal">
        <p className="text-muted small questions-templates-hint">
          Вставьте метку <strong>Имя покупателя</strong> — при выборе шаблона в ответе подставится имя из вопроса
          (или «Покупатель», если имя неизвестно).
        </p>

        {error && <div className="error questions-templates-error">{error}</div>}

        {loading ? (
          <div className="loading">Загрузка…</div>
        ) : (
          <>
            <div className="questions-templates-list">
              {items.length === 0 && editingId !== 'new' ? (
                <p className="text-muted small">Шаблонов пока нет. Добавьте первый.</p>
              ) : (
                items.map((tpl) => (
                  <div key={tpl.id} className="questions-templates-item">
                    <div className="questions-templates-item__main">
                      <strong className="questions-templates-item__title">{tpl.title}</strong>
                      <p className="questions-templates-item__preview">
                        <TemplateBodySnippet text={tpl.body} />
                      </p>
                    </div>
                    <div className="questions-templates-item__actions">
                      <Button type="button" variant="secondary" size="small" onClick={() => startEdit(tpl)} disabled={saving}>
                        Изменить
                      </Button>
                      <Button
                        type="button"
                        variant="secondary"
                        size="small"
                        onClick={() => void removeTemplate(tpl.id)}
                        disabled={saving}
                      >
                        Удалить
                      </Button>
                    </div>
                  </div>
                ))
              )}
            </div>

            {editingId ? (
              <div className="questions-templates-form">
                <label className="label" htmlFor="qtpl-title">
                  Название (для кнопки выбора)
                </label>
                <input
                  id="qtpl-title"
                  className="form-control"
                  value={form.title}
                  onChange={(e) => setForm((f) => ({ ...f, title: e.target.value }))}
                  disabled={saving}
                  placeholder="Например: Уточните VIN"
                />
                <label className="label" htmlFor="qtpl-body">
                  Текст шаблона
                </label>
                <QuestionTemplateBodyEditor
                  id="qtpl-body"
                  value={form.body}
                  onChange={(body) => setForm((f) => ({ ...f, body }))}
                  disabled={saving}
                />
                <div className="questions-templates-form-actions">
                  <Button type="button" variant="primary" onClick={() => void saveForm()} disabled={saving}>
                    {saving ? 'Сохранение…' : editingId === 'new' ? 'Добавить' : 'Сохранить'}
                  </Button>
                  <Button type="button" variant="secondary" onClick={cancelForm} disabled={saving}>
                    Отмена
                  </Button>
                </div>
              </div>
            ) : (
              <Button type="button" variant="secondary" onClick={startCreate} disabled={saving}>
                + Добавить шаблон
              </Button>
            )}
          </>
        )}
      </div>
    </Modal>
  );
}
