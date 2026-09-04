import React, { useEffect, useRef, useState } from 'react';
import { Button } from '../common/Button/Button';
import { aiApi } from '../../services/ai.api';
import { getApiErrorMessage } from '../../utils/apiErrorMessage.js';
import { instructionAllowsOverwrite, MAX_BULK_AI_CARDS } from '../../utils/aiProductCardFields.js';
import { useAiEnabled } from '../../hooks/useAiEnabled.js';
import {
  AI_DESCRIPTION_CONTEXT_FIELDS,
  AI_DESCRIPTION_CONTEXT_KEYS,
  AI_DESCRIPTION_OUTPUT_FIELDS,
  AI_DESCRIPTION_OUTPUT_KEYS,
  DESCRIPTION_AI_EXAMPLES,
  filterDraftForAiContext,
  formatAiChangesPreview,
} from '../../utils/aiDescriptionFields.js';
import './ProductDescriptionAiChat.css';

function toggleKey(list, key) {
  if (list.includes(key)) {
    const next = list.filter((k) => k !== key);
    return next.length ? next : list;
  }
  return [...list, key];
}

export function ProductDescriptionAiChat({
  compact = false,
  disabled = false,
  productId = null,
  getDraft,
  bulkItems = [],
  onApply,
  onApplyBulk,
  className = '',
}) {
  const isBulk = Array.isArray(bulkItems) && bulkItems.length > 0;
  const { enabled: aiReady, loading: configLoading } = useAiEnabled();
  const [messages, setMessages] = useState([]);
  const [input, setInput] = useState('');
  const [outputFields, setOutputFields] = useState(() => [...AI_DESCRIPTION_OUTPUT_KEYS]);
  const [contextFields, setContextFields] = useState(() => [...AI_DESCRIPTION_CONTEXT_KEYS]);
  const [fillEmptyOnly, setFillEmptyOnly] = useState(true);
  const [sending, setSending] = useState(false);
  const [error, setError] = useState(null);
  const [lastResult, setLastResult] = useState(null);
  const listRef = useRef(null);

  useEffect(() => {
    if (!listRef.current) return;
    listRef.current.scrollTop = listRef.current.scrollHeight;
  }, [messages, sending]);

  const ready = aiReady && !disabled;

  const send = async (text) => {
    const instruction = String(text || '').trim();
    if (!instruction || sending || !ready) return;
    const fillEmpty =
      fillEmptyOnly && !instructionAllowsOverwrite(instruction);
    const fields = outputFields.filter((k) => AI_DESCRIPTION_OUTPUT_KEYS.includes(k));
    if (!fields.length) {
      setError('Выберите хотя бы одно поле описания для генерации.');
      return;
    }

    const userMsg = { role: 'user', content: instruction };
    setMessages((prev) => [...prev, userMsg]);
    setInput('');
    setSending(true);
    setError(null);
    setLastResult(null);

    try {
      if (isBulk) {
        const items = bulkItems.filter((it) => it?.productId);
        if (!items.length) throw new Error('Нет сохранённых товаров для генерации');
        const allItems = [];
        for (let i = 0; i < items.length; i += MAX_BULK_AI_CARDS) {
          const chunk = items.slice(i, i + MAX_BULK_AI_CARDS).map((it) => ({
            productId: it.productId,
            draft: filterDraftForAiContext(it.draft, contextFields),
          }));
          const data = await aiApi.proposeProductCardsBulk({
            items: chunk,
            instruction,
            fields,
            fillEmptyOnly: fillEmpty,
          });
          allItems.push(...(data?.items || []));
        }
        const changed = allItems.filter((it) => it?.changes?.length);
        const reply = changed.length
          ? `Готово для ${changed.length} из ${items.length} товаров.\n\n${changed
              .slice(0, 3)
              .map(
                (it) =>
                  `${it.sku || it.productId}:\n${formatAiChangesPreview(it.changes)}`
              )
              .join('\n\n')}${changed.length > 3 ? `\n\n…и ещё ${changed.length - 3}` : ''}`
          : 'Модель не предложила изменений. Уточните запрос или снимите «Только пустые».';
        setLastResult({ bulk: true, items: allItems });
        setMessages((prev) => [...prev, { role: 'assistant', content: reply }]);
      } else {
        const draft =
          typeof getDraft === 'function'
            ? filterDraftForAiContext(getDraft(), contextFields)
            : {};
        const data = await aiApi.proposeProductCard({
          productId: productId || undefined,
          draft,
          instruction,
          fields,
          fillEmptyOnly: fillEmpty,
        });
        const reply = data?.changes?.length
          ? `${data.comment ? `${data.comment}\n\n` : ''}${formatAiChangesPreview(data.changes)}`
          : 'Модель не предложила изменений. Уточните запрос или снимите «Только пустые».';
        setLastResult({ bulk: false, data });
        setMessages((prev) => [...prev, { role: 'assistant', content: reply }]);
      }
    } catch (err) {
      setError(getApiErrorMessage(err, 'Не удалось получить ответ GigaChat'));
    } finally {
      setSending(false);
    }
  };

  const applyLast = () => {
    if (!lastResult) return;
    if (lastResult.bulk) {
      const items = (lastResult.items || []).filter((it) => it?.changes?.length);
      if (items.length) onApplyBulk?.(items);
    } else if (lastResult.data?.proposed && Object.keys(lastResult.data.proposed).length) {
      onApply?.(lastResult.data.proposed, lastResult.data);
    }
  };

  const canApply = lastResult?.bulk
    ? (lastResult.items || []).some((it) => it?.changes?.length)
    : !!(lastResult?.data?.changes?.length);

  if (configLoading || !ready) return null;

  return (
    <div
      className={`product-desc-ai-chat${compact ? ' product-desc-ai-chat--compact' : ''}${className ? ` ${className}` : ''}`}
    >
      <div className="product-desc-ai-chat__head">
        <strong>ИИ — описание</strong>
        {isBulk ? (
          <span className="product-desc-ai-chat__meta">товаров: {bulkItems.length}</span>
        ) : null}
      </div>

      <>
          <div className="product-desc-ai-chat__sections">
            <p className="product-desc-ai-chat__section-title">Заполнить поля</p>
            <div className="product-desc-ai-chat__checks">
              {AI_DESCRIPTION_OUTPUT_FIELDS.map((f) => (
                <label key={f.key} className="product-desc-ai-chat__check">
                  <input
                    type="checkbox"
                    checked={outputFields.includes(f.key)}
                    onChange={() => setOutputFields((prev) => toggleKey(prev, f.key))}
                    disabled={sending}
                  />
                  {f.label}
                </label>
              ))}
            </div>
          </div>

          <div className="product-desc-ai-chat__sections">
            <p className="product-desc-ai-chat__section-title">Учитывать при генерации</p>
            <div className="product-desc-ai-chat__checks">
              {AI_DESCRIPTION_CONTEXT_FIELDS.map((f) => (
                <label key={f.key} className="product-desc-ai-chat__check">
                  <input
                    type="checkbox"
                    checked={contextFields.includes(f.key)}
                    onChange={() => setContextFields((prev) => toggleKey(prev, f.key))}
                    disabled={sending}
                  />
                  {f.label}
                </label>
              ))}
            </div>
          </div>

          <label className="product-desc-ai-chat__check">
            <input
              type="checkbox"
              checked={fillEmptyOnly}
              onChange={(e) => setFillEmptyOnly(e.target.checked)}
              disabled={sending}
            />
            Только пустые — не переписывать уже заполненное
          </label>

          <div className="product-desc-ai-chat__messages" ref={listRef}>
            {messages.length === 0 && (
              <div className="product-desc-ai-chat__examples">
                {DESCRIPTION_AI_EXAMPLES.map((q) => (
                  <button key={q} type="button" onClick={() => send(q)} disabled={sending}>
                    {q}
                  </button>
                ))}
              </div>
            )}
            {messages.map((msg, idx) => (
              <div
                key={`${msg.role}-${idx}`}
                className={`product-desc-ai-chat__msg product-desc-ai-chat__msg--${msg.role}`}
              >
                {msg.content}
              </div>
            ))}
            {sending ? (
              <div className="product-desc-ai-chat__msg product-desc-ai-chat__msg--assistant">
                Готовлю описание…
              </div>
            ) : null}
          </div>

          {error ? <div className="product-desc-ai-chat__error">{error}</div> : null}

          <form
            className="product-desc-ai-chat__form"
            onSubmit={(e) => {
              e.preventDefault();
              send(input);
            }}
          >
            <textarea
              className="product-desc-ai-chat__input"
              value={input}
              onChange={(e) => setInput(e.target.value)}
              placeholder="Напишите, как изменить описание…"
              disabled={sending}
              rows={compact ? 2 : 3}
            />
            <div className="product-desc-ai-chat__actions">
              <Button type="submit" variant="primary" size="small" disabled={sending || !input.trim()}>
                Отправить
              </Button>
              {canApply ? (
                <Button type="button" variant="secondary" size="small" onClick={applyLast} disabled={sending}>
                  Подставить результат
                </Button>
              ) : null}
            </div>
            <p className="product-desc-ai-chat__apply-hint">
              В ERP и на МП ничего не уходит, пока не нажмёте «Сохранить» в таблице или карточке.
            </p>
          </form>
        </>
      )}
    </div>
  );
}
