/**
 * Редактор текста шаблона с визуальной вставкой «Имя покупателя»
 */

import React, { useRef } from 'react';
import {
  QUESTION_TEMPLATE_NAME_TOKEN,
  QUESTION_TEMPLATE_PREVIEW_SAMPLE_NAME,
  applyQuestionTemplate,
  splitTemplateForDisplay,
  templateContainsNamePlaceholder,
} from './questionTemplateText';

function TemplateTextPreview({ text, sampleName, label }) {
  const resolved = applyQuestionTemplate(text, { buyerName: sampleName });
  const parts = splitTemplateForDisplay(text);
  const hasToken = templateContainsNamePlaceholder(text);

  return (
    <div className="questions-template-preview-block">
      <div className="questions-template-preview-block__label">{label}</div>
      {hasToken ? (
        <p className="questions-template-preview-block__resolved">{resolved}</p>
      ) : (
        <p className="questions-template-preview-block__resolved questions-template-preview-block__resolved--muted">
          {text.trim() ? text : '—'}
        </p>
      )}
      {hasToken && parts.length > 0 ? (
        <p className="questions-template-preview-block__tokens text-muted small">
          В шаблоне:{' '}
          {parts.map((part, i) =>
            part.type === 'name' ? (
              <span key={`n-${i}`} className="questions-template-token" title="Подставится имя покупателя">
                Имя покупателя
              </span>
            ) : (
              <span key={`t-${i}`}>{part.value}</span>
            )
          )}
        </p>
      ) : null}
    </div>
  );
}

export function QuestionTemplateBodyEditor({ id, value, onChange, disabled }) {
  const textareaRef = useRef(null);

  const insertNameToken = () => {
    const el = textareaRef.current;
    const token = QUESTION_TEMPLATE_NAME_TOKEN;
    const body = String(value ?? '');

    if (!el) {
      onChange(body ? `${body}${body.endsWith(' ') ? '' : ' '}${token}` : token);
      return;
    }

    const start = el.selectionStart ?? body.length;
    const end = el.selectionEnd ?? body.length;
    const before = body.slice(0, start);
    const after = body.slice(end);
    const needSpace = before.length > 0 && !/[\s([{«"']$/.test(before);
    const insert = `${needSpace ? ' ' : ''}${token}`;
    const newBody = before + insert + after;
    onChange(newBody);

    const cursor = start + insert.length;
    requestAnimationFrame(() => {
      el.focus();
      el.setSelectionRange(cursor, cursor);
    });
  };

  return (
    <div className="questions-template-body-editor">
      <div className="questions-template-body-editor__toolbar">
        <span className="questions-template-body-editor__toolbar-label">Вставить в текст:</span>
        <button
          type="button"
          className="questions-template-token questions-template-token--insert"
          onClick={insertNameToken}
          disabled={disabled}
          title="Вставить метку «Имя покупателя» в позицию курсора"
        >
          <span className="questions-template-token__icon" aria-hidden="true">
            👤
          </span>
          Имя покупателя
        </button>
      </div>

      <textarea
        ref={textareaRef}
        id={id}
        className="form-control questions-template-body-editor__textarea"
        rows={5}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        disabled={disabled}
        placeholder="Здравствуйте! Нажмите «Имя покупателя» выше, чтобы обратиться к клиенту по имени."
      />

      {String(value ?? '').trim() ? (
        <div className="questions-template-preview">
          <div className="questions-template-preview__title">Как будет выглядеть ответ</div>
          <div className="questions-template-preview__grid">
            <TemplateTextPreview
              text={value}
              sampleName={QUESTION_TEMPLATE_PREVIEW_SAMPLE_NAME}
              label={`Если имя известно (пример: ${QUESTION_TEMPLATE_PREVIEW_SAMPLE_NAME})`}
            />
            <TemplateTextPreview text={value} sampleName="" label="Если имя не пришло с маркетплейса" />
          </div>
        </div>
      ) : null}
    </div>
  );
}

export function TemplateBodySnippet({ text, maxLen = 160 }) {
  const parts = splitTemplateForDisplay(text);
  if (!parts.length) return <span className="text-muted">—</span>;

  let len = 0;
  const nodes = [];
  for (let i = 0; i < parts.length; i++) {
    const part = parts[i];
    if (part.type === 'name') {
      nodes.push(
        <span key={`n-${i}`} className="questions-template-token questions-template-token--inline">
          Имя
        </span>
      );
      len += 4;
      continue;
    }
    const chunk = part.value;
    const room = maxLen - len;
    if (room <= 0) break;
    const slice = chunk.length > room ? `${chunk.slice(0, room)}…` : chunk;
    nodes.push(<span key={`t-${i}`}>{slice}</span>);
    len += slice.length;
    if (chunk.length > room) break;
  }
  return <>{nodes}</>;
}
