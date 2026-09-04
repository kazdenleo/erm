import React, { useEffect, useRef, useState } from 'react';
import { Button } from '../../../components/common/Button/Button';
import { aiApi } from '../../../services/ai.api';
import { getApiErrorMessage } from '../../../utils/apiErrorMessage.js';
import { useAiEnabled } from '../../../hooks/useAiEnabled.js';
import './AnalyticsAiChat.css';

const EXAMPLES = [
  'Какие товары съедают прибыль?',
  'Почему к перечислению меньше продаж?',
  'Топ-5 SKU по выручке за этот период',
];

export function AnalyticsAiChat({ dateFrom, dateTo, marketplace, source = 'fbs' }) {
  const { enabled: ready, loading: configLoading } = useAiEnabled();
  const [messages, setMessages] = useState([]);
  const [input, setInput] = useState('');
  const [sending, setSending] = useState(false);
  const [error, setError] = useState(null);
  const listRef = useRef(null);

  useEffect(() => {
    if (!listRef.current) return;
    listRef.current.scrollTop = listRef.current.scrollHeight;
  }, [messages, sending]);

  const send = async (text) => {
    const content = String(text || '').trim();
    if (!content || sending || !ready) return;
    const next = [...messages, { role: 'user', content }];
    setMessages(next);
    setInput('');
    setSending(true);
    setError(null);
    try {
      const data = await aiApi.chat({
        messages: next,
        context: { dateFrom, dateTo, marketplace, source },
      });
      const reply = String(data?.reply || '').trim();
      setMessages([...next, { role: 'assistant', content: reply || 'Пустой ответ модели.' }]);
    } catch (err) {
      setError(getApiErrorMessage(err, 'Не удалось получить ответ GigaChat'));
    } finally {
      setSending(false);
    }
  };

  if (configLoading || !ready) return null;

  return (
    <div className="analytics-ai-chat">
      <div className="analytics-ai-chat__head">
        <strong>Ассистент GigaChat</strong>
        <span className="analytics-ai-chat__meta">
          {dateFrom && dateTo ? `${dateFrom} — ${dateTo}` : 'период страницы'}
          {marketplace && marketplace !== 'all' ? ` · ${marketplace}` : ' · все МП'}
        </span>
      </div>

      <div className="analytics-ai-chat__messages" ref={listRef}>
        {messages.length === 0 && (
          <div className="analytics-ai-chat__examples">
            {EXAMPLES.map((q) => (
              <button key={q} type="button" onClick={() => send(q)} disabled={sending}>
                {q}
              </button>
            ))}
          </div>
        )}
        {messages.map((msg, idx) => (
          <div
            key={`${msg.role}-${idx}`}
            className={`analytics-ai-chat__msg analytics-ai-chat__msg--${msg.role}`}
          >
            {msg.content}
          </div>
        ))}
        {sending && <div className="analytics-ai-chat__msg analytics-ai-chat__msg--assistant">Смотрю данные…</div>}
      </div>
      {error && <div className="analytics-ai-chat__error">{error}</div>}
      <form
        className="analytics-ai-chat__form"
        onSubmit={(e) => {
          e.preventDefault();
          send(input);
        }}
      >
        <input
          className="analytics-ai-chat__input"
          value={input}
          onChange={(e) => setInput(e.target.value)}
          placeholder="Спросите про продажи, удержания или прибыль…"
          disabled={sending}
        />
        <Button type="submit" variant="primary" size="small" disabled={sending || !input.trim()}>
          Спросить
        </Button>
      </form>
    </div>
  );
}
