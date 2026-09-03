/**
 * ИИ-черновик для редактируемых атрибутов и связанных полей МП.
 */

import productsService from './products.service.js';
import { gigachatChatCompletions } from './gigachat.client.js';
import { assertAiReady, aiHttpError } from '../utils/aiSettings.js';
import { instructionAllowsOverwrite } from '../utils/aiProductCardFields.js';
import logger from '../utils/logger.js';
import repositoryFactory from '../config/repository-factory.js';

const PROPOSE_FN = 'propose_attribute_editor';
const MAX_INSTRUCTION = 2000;
const MAX_FIELD = 12000;

function str(v) {
  return v == null ? '' : String(v).trim();
}

function parseToolArgs(raw) {
  if (raw == null) return {};
  if (typeof raw === 'object' && !Array.isArray(raw)) return raw;
  if (typeof raw === 'string') {
    try {
      return JSON.parse(raw.trim());
    } catch {
      const m = raw.match(/\{[\s\S]*\}/);
      if (m) {
        try {
          return JSON.parse(m[0]);
        } catch {
          return {};
        }
      }
    }
  }
  return {};
}

function extractFunctionCall(message) {
  if (message?.function_call?.name) return message.function_call;
  return null;
}

async function loadAiSettings(profileId) {
  const row = await repositoryFactory.getProfilesRepository().findById(profileId);
  if (!row) throw aiHttpError('Аккаунт не найден', 404);
  return assertAiReady(row.ai_settings ?? row.aiSettings);
}

function normalizeOutputFields(fields) {
  const list = Array.isArray(fields) ? fields : [];
  return list
    .map((f) => ({
      key: str(f?.key),
      label: str(f?.label) || str(f?.key),
      type: str(f?.type) || 'text',
    }))
    .filter((f) => f.key);
}

function buildProperties(outputFields) {
  const properties = {
    comment: { type: 'string', description: 'Кратко, что изменил' },
  };
  for (const f of outputFields) {
    if (f.type === 'vehicles') {
      properties.vehicles_json = {
        type: 'string',
        description:
          'JSON-массив автомobileй [{mark,model,modification}] текстом марки/модели/модификации. Только если просили заполнить таблицу авто.',
      };
      continue;
    }
    properties[f.key] = {
      type: 'string',
      description: `${f.label}. Многострочный текст через перенос строки, если нужно несколько значений.`,
    };
  }
  return properties;
}

function sanitizeProposal(raw, current, outputFields, { fillEmptyOnly }) {
  const src = raw && typeof raw === 'object' ? raw : {};
  const proposed = {};
  const changes = [];
  const warnings = [];

  for (const f of outputFields) {
    if (f.type === 'vehicles') continue;
    let next = str(src[f.key]);
    if (!next) continue;
    if (next.length > MAX_FIELD) {
      next = next.slice(0, MAX_FIELD);
      warnings.push(`${f.label}: обрезано`);
    }
    const prev = str(current[f.key]);
    if (next === prev) continue;
    if (fillEmptyOnly && prev.length >= 8) continue;
    proposed[f.key] = next;
    changes.push({ field: f.key, label: f.label, from: prev, to: next });
  }

  const vehiclesRaw = str(src.vehicles_json);
  if (vehiclesRaw) {
    try {
      const parsed = JSON.parse(vehiclesRaw);
      if (Array.isArray(parsed) && parsed.length) {
        proposed.vehicles_json = parsed;
        changes.push({
          field: 'vehicles_json',
          label: 'Автомобили Ozon',
          from: '',
          to: `${parsed.length} строк`,
        });
      }
    } catch {
      warnings.push('Не удалось разобрать vehicles_json от модели');
    }
  }

  return { proposed, changes, warnings, comment: str(src.comment) };
}

class AiAttributeEditorService {
  async propose(profileId, body = {}) {
    const settings = await loadAiSettings(profileId);
    const outputFields = normalizeOutputFields(body.outputFields);
    if (!outputFields.length) throw aiHttpError('Укажите поля для генерации', 400);

    const context = body.context && typeof body.context === 'object' ? body.context : {};
    const instruction = str(body.instruction).slice(0, MAX_INSTRUCTION);
    const fillEmptyOnly =
      body.fillEmptyOnly !== false && !instructionAllowsOverwrite(instruction);

    if (body.productId) {
      const product = await productsService.getById(body.productId, { profileId });
      const pid = product.profile_id ?? product.profileId;
      if (pid != null && String(pid) !== String(profileId)) {
        throw aiHttpError('Товар не найден', 404);
      }
    }

    const current = {};
    for (const f of outputFields) {
      if (f.type === 'vehicles') continue;
      current[f.key] = str(context[f.key]);
    }

    const fieldLabels = outputFields.map((f) => f.label).join(', ');
    const rules = [
      'Ты редактор карточки товара (ERP + маркетплейсы).',
      'Верни результат ТОЛЬКО через функцию propose_attribute_editor.',
      `Можно менять поля: ${fieldLabels}.`,
      'Не выдумывай совместимость и характеристики, которых нет во входных данных.',
      fillEmptyOnly
        ? 'Заполняй пустые поля; заполненные не переписывай без явной просьбы.'
        : 'Перепиши поля по запросу пользователя.',
    ];
    if (instruction) rules.push(`Запрос: ${instruction}`);
    rules.push(`Контекст:\n${JSON.stringify(context)}`);

    const response = await gigachatChatCompletions(settings, {
      model: settings.model,
      messages: [{ role: 'user', content: rules.join('\n') }],
      temperature: 0.25,
      max_tokens: 3500,
      function_call: { name: PROPOSE_FN },
      functions: [
        {
          name: PROPOSE_FN,
          description: 'Черновик значений атрибутов',
          parameters: {
            type: 'object',
            properties: buildProperties(outputFields),
          },
        },
      ],
    });

    const fn = extractFunctionCall(response?.choices?.[0]?.message || {});
    const raw = fn?.name ? parseToolArgs(fn.arguments) : {};
    const { proposed, changes, warnings, comment } = sanitizeProposal(raw, current, outputFields, {
      fillEmptyOnly,
    });

    logger.info('[AI] attribute editor', { productId: body.productId, changed: changes.length });

    return {
      productId: body.productId ?? null,
      proposed,
      changes,
      warnings,
      comment,
      fillEmptyOnlyApplied: fillEmptyOnly,
      model: settings.model,
    };
  }
}

export default new AiAttributeEditorService();
