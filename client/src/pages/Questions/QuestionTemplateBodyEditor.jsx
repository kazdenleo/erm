/**
 * Редактор текста шаблона с визуальной вставкой переменных
 */

import React, { useRef } from 'react';
import {
  QUESTION_TEMPLATE_PREVIEW_SAMPLE_NAME,
  applyQuestionTemplate,
  splitTemplateForDisplay,
  templateContainsNamePlaceholder,
} from './questionTemplateText';
import { QuestionTextInsertToolbar } from './QuestionTextInsertToolbar';

function TemplateTextPreview({ text, sampleName, label }) {
  const resolved = applyQuestionTemplate(text, { buyerName: sampleName });
  const parts = splitTemplateForDisplay(text);
  const hasName = templateContainsNamePlaceholder(text);

  return (
    <div className="questions-template-preview-block">
      <div className="questions-template-preview-block__label">{label}</div>
      {hasName ? (
        <p className="questions-template-preview-block__resolved">{resolved}</p>
      ) : (
        <p className="questions-template-preview-block__resolved questions-template-preview-block__resolved--muted">
          {text.trim() ? text : '—'}
        </p>
      )}
      {hasName && parts.length > 0 ? (
        <p className="questions-template-preview-block__tokens text-muted small">
          В шаблоне:{' '}
          {parts.map((part, i) =>
            part.type === 'text' ? (
              <span key={`t-${i}`}>{part.value}</span>
            ) : part.type === 'name' ? (
              <span key={`n-${i}`} className="questions-template-token" title="Имя покупателя">
                Имя покупателя
              </span>
            ) : (
              <span key={`p-${i}`}>{part.value}</span>
            )
          )}
        </p>
      ) : null}
    </div>
  );
}

export function QuestionTemplateBodyEditor({ id, value, onChange, disabled }) {
  const textareaRef = useRef(null);

  return (
    <div className="questions-template-body-editor">
      <QuestionTextInsertToolbar
        textareaRef={textareaRef}
        value={value}
        onChange={onChange}
        disabled={disabled}
        mode="template"
        showProduct={false}
      />

      <textarea
        ref={textareaRef}
        id={id}
        className="form-control questions-template-body-editor__textarea"
        rows={5}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        disabled={disabled}
        placeholder="Здравствуйте! Нажмите «Имя покупателя», чтобы вставить метку для подстановки имени."
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
    if (part.type === 'product') {
      nodes.push(<span key={`p-${i}`}>{part.value}</span>);
      len += part.value.length;
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
