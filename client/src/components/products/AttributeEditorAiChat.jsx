import React, { useEffect, useRef, useState } from 'react';
import { Button } from '../common/Button/Button';
import { aiApi } from '../../services/ai.api';
import { getApiErrorMessage } from '../../utils/apiErrorMessage.js';
import { instructionAllowsOverwrite } from '../../utils/aiProductCardFields.js';
import { useAiEnabled } from '../../hooks/useAiEnabled.js';
import {
  APPLICABILITY_AI_EXAMPLES,
  DEFAULT_ATTR_EDITOR_CONTEXT_FIELDS,
  DEFAULT_ATTR_EDITOR_CONTEXT_KEYS,
  filterContextForAttrEditor,
  formatAttrEditorChangesPreview,
} from '../../utils/aiAttributeEditorFields.js';
import './ProductDescriptionAiChat.css';

function toggleKey(list, key) {
  if (list.includes(key)) {
    const next = list.filter((k) => k !== key);
    return next.length ? next : list;
  }
  return [...list, key];
}

export function AttributeEditorAiChat({
  productId = null,
  getContext,
  outputFields = [],
  onApply,
  examples = APPLICABILITY_AI_EXAMPLES,
  className = '',
}) {
  const { enabled: aiReady, loading: aiLoading } = useAiEnabled();
  const [messages, setMessages] = useState([]);
  const [input, setInput] = useState('');
  const [contextKeys, setContextKeys] = useState(() => [...DEFAULT_ATTR_EDITOR_CONTEXT_KEYS]);
  const [fillEmptyOnly, setFillEmptyOnly] = useState(true);
  const [sending, setSending] = useState(false);
  const [error, setError] = useState(null);
  const listRef = useRef(null);

  useEffect(() => {
    if (listRef.current) listRef.current.scrollTop = listRef.current.scrollHeight;
  }, [messages, sending]);

  const send = async (text) => {
    const instruction = String(text || '').trim();
    if (!instruction || sending || !aiReady) return;
    const fillEmpty = fillEmptyOnly && !instructionAllowsOverwrite(instruction);
    const ctx = typeof getContext === 'function' ? getContext() : {};
    const context = filterContextForAttrEditor(
      { ...ctx, ...Object.fromEntries((outputFields || []).map((f) => [f.key, ctx[f.key] ?? ''])) },
      contextKeys
    );
    for (const f of outputFields || []) {
      if (f.key && ctx[f.key] != null) context[f.key] = String(ctx[f.key]);
    }

    setMessages((prev) => [...prev, { role: 'user', content: instruction }]);
    setInput('');
    setSending(true);
    setError(null);
    try {
      const data = await aiApi.proposeAttributeEditor({
        productId,
        instruction,
        context,
        outputFields,
        fillEmptyOnly: fillEmpty,
      });
      const reply = data?.changes?.length
        ? `${data.comment ? `${data.comment}\n\n` : ''}${formatAttrEditorChangesPreview(data.changes)}`
        : 'Модель не предложила изменений. Уточните запрос или снимите «Только пустые».';
      setMessages((prev) => [...prev, { role: 'assistant', content: reply, proposed: data?.proposed }]);
    } catch (e) {
      setError(getApiErrorMessage(e));
    } finally {
      setSending(false);
    }
  };

  if (aiLoading || !aiReady) return null;

  const lastProposed = [...messages].reverse().find((m) => m.proposed)?.proposed;

  return (
    <div className={`product-desc-ai-chat product-desc-ai-chat--compact ${className}`.trim()}>
      <div className="product-desc-ai-chat__head">
        <strong>ИИ-чат</strong>
        <span className="product-desc-ai-chat__meta">
          видит выбранные поля карточки и может заполнить это значение
        </span>
      </div>
      <div className="product-desc-ai-chat__chips">
        {DEFAULT_ATTR_EDITOR_CONTEXT_FIELDS.map((f) => (
          <button
            key={f.key}
            type="button"
            className={`btn btn-sm ${contextKeys.includes(f.key) ? 'btn-primary' : 'btn-outline-secondary'}`}
            onClick={() => setContextKeys((prev) => toggleKey(prev, f.key))}
          >
            {f.label}
          </button>
        ))}
      </div>
      <label className="form-check small mb-2">
        <input
          type="checkbox"
          className="form-check-input me-2"
          checked={fillEmptyOnly}
          onChange={(e) => setFillEmptyOnly(e.target.checked)}
        />
        Только пустые поля
      </label>
      <div ref={listRef} className="product-desc-ai-chat__messages">
        {messages.map((m, i) => (
          <div key={i} className={`product-desc-ai-chat__msg product-desc-ai-chat__msg--${m.role}`}>
            {m.content}
          </div>
        ))}
        {sending ? <div className="text-muted small">Думаю…</div> : null}
      </div>
      {error ? <div className="alert alert-danger py-1 small">{error}</div> : null}
      <div className="d-flex flex-wrap gap-1 mb-2">
        {examples.map((ex) => (
          <button key={ex} type="button" className="btn btn-link btn-sm p-0" onClick={() => send(ex)}>
            {ex}
          </button>
        ))}
      </div>
      <div className="d-flex gap-2">
        <input
          className="form-control form-control-sm"
          value={input}
          disabled={sending}
          placeholder="Например: заполни применимость по OEM"
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && !e.shiftKey) {
              e.preventDefault();
              send(input);
            }
          }}
        />
        <Button type="button" variant="primary" size="small" disabled={sending || !input.trim()} onClick={() => send(input)}>
          Отправить
        </Button>
      </div>
      {lastProposed ? (
        <Button type="button" variant="secondary" size="small" className="mt-2" onClick={() => onApply?.(lastProposed)}>
          Вставить в поля
        </Button>
      ) : null}
    </div>
  );
}

export default AttributeEditorAiChat;
