/**
 * ИИ-черновик для редактируемых атрибутов и связанных полей МП.
 */

import productsService from './products.service.js';
import { gigachatChatCompletions } from './gigachat.client.js';
import { assertAiReady, aiHttpError } from '../utils/aiSettings.js';
import { instructionAllowsOverwrite, MAX_BULK_AI_CARDS } from '../utils/aiProductCardFields.js';
import logger from '../utils/logger.js';
import repositoryFactory from '../config/repository-factory.js';

const PROPOSE_FN = 'propose_attribute_editor';
const MAX_INSTRUCTION = 2000;
const MAX_FIELD = 12000;

function str(v) {
  return v == null ? '' : String(v).trim();
}

/** GigaChat иногда отдаёт переносы как буквальные «\n» вместо реальных. */
function normalizeMultilineText(v) {
  let t = str(v);
  if (!t) return '';
  if (/\\[nrt]/.test(t)) {
    t = t
      .replace(/\\r\\n/g, '\n')
      .replace(/\\n/g, '\n')
      .replace(/\\r/g, '\n')
      .replace(/\\t/g, '\t');
  }
  return t.trim();
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
          'JSON-массив автомобилей [{mark,model,modification}] текстом марки/модели/модификации. Только если просили заполнить таблицу авто.',
      };
      continue;
    }
    properties[f.key] = {
      type: 'string',
      description: `${f.label}. Многострочный текст: реальные переносы строк (не символы \\n). Список — по одному значению на строку. Без заглушек вроде «Авто 1».`,
    };
  }
  return properties;
}

function stringifyDraftValue(value) {
  if (value == null) return '';
  if (Array.isArray(value)) {
    return value.map(stringifyDraftValue).filter(Boolean).join(', ');
  }
  if (typeof value === 'object') {
    try {
      return JSON.stringify(value);
    } catch {
      return '';
    }
  }
  return String(value);
}

function bestFieldValue(cardDraft, clientContext, field) {
  for (const c of [
    clientContext?.[field.key],
    clientContext?.[field.label],
    cardDraft?.[field.key],
  ]) {
    const s = str(c);
    if (s) return s;
  }
  return '';
}

/** Полный снимок карточки: массовый ИИ не должен опираться только на видимые ячейки таблицы. */
function buildCardDraft(product) {
  if (!product || typeof product !== 'object') return {};
  const dim = (key) => str(product[key]);
  const out = {
    sku: str(product.sku),
    name: str(product.name),
    description: str(product.description),
    brand: str(product.brand || product.brand_name),
    country_of_origin: str(product.country_of_origin || product.countryOfOrigin),
    category_name: str(product.category_name || product.categoryName),
    mp_ozon_name: str(product.mp_ozon_name),
    mp_ozon_description: str(product.mp_ozon_description),
    mp_wb_name: str(product.mp_wb_name),
    mp_wb_description: str(product.mp_wb_description),
    mp_ym_name: str(product.mp_ym_name),
    mp_ym_description: str(product.mp_ym_description),
    product_length: dim('product_length'),
    product_width: dim('product_width'),
    product_height: dim('product_height'),
    product_weight: dim('product_weight'),
    length: dim('length'),
    width: dim('width'),
    height: dim('height'),
    weight: dim('weight'),
  };
  const attrs = product.attribute_values || product.attributeValues || {};
  if (attrs && typeof attrs === 'object' && !Array.isArray(attrs)) {
    for (const [id, val] of Object.entries(attrs)) {
      if (id == null || String(id).trim() === '') continue;
      out[`erp_attr_${id}`] = stringifyDraftValue(val);
    }
  }
  return out;
}

function sanitizeProposal(raw, current, outputFields, { fillEmptyOnly }) {
  const src = raw && typeof raw === 'object' ? raw : {};
  const proposed = {};
  const changes = [];
  const warnings = [];

  for (const f of outputFields) {
    if (f.type === 'vehicles') continue;
    let next = normalizeMultilineText(src[f.key]);
    if (!next) continue;
    if (next.length > MAX_FIELD) {
      next = next.slice(0, MAX_FIELD);
      warnings.push(`${f.label}: обрезано`);
    }
    const prev = normalizeMultilineText(current[f.key]);
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

    const clientContext = body.context && typeof body.context === 'object' ? body.context : {};
    const instruction = str(body.instruction).slice(0, MAX_INSTRUCTION);
    const fillEmptyOnly =
      body.fillEmptyOnly !== false && !instructionAllowsOverwrite(instruction);

    let cardDraft = {};
    if (body.productId) {
      // Нужен WithDetails — обычный getById не подгружает attribute_values
      const product =
        (await productsService.getByIdWithDetails(body.productId)) ||
        (await productsService.getById(body.productId));
      if (!product) throw aiHttpError('Товар не найден', 404);
      const pid = product.profile_id ?? product.profileId;
      if (pid != null && String(pid) !== String(profileId)) {
        throw aiHttpError('Товар не найден', 404);
      }
      cardDraft = buildCardDraft(product);
    }

    // Контекст: выбранные поля пользователя + подстановка значений с карточки,
    // если клиент прислал пустые (частый баг: в UI выбрано, а в draft пусто).
    const context = {};
    const clientEntries = Object.entries(clientContext);
    if (clientEntries.length) {
      for (const [key, value] of clientEntries) {
        if (value == null) {
          context[key] = '';
          continue;
        }
        context[key] =
          typeof value === 'string' ? value : stringifyDraftValue(value);
      }
    } else {
      Object.assign(context, cardDraft);
    }

    const current = {};
    for (const f of outputFields) {
      if (f.type === 'vehicles') continue;
      const best = bestFieldValue(cardDraft, clientContext, f);
      current[f.key] = best;
      // В промпт — и подпись, и ключ, с реальным значением с карточки при необходимости
      context[f.label] = best;
      context[f.key] = best;
    }

    // Любые erp_attr_* из карточки, которые клиент уже указал ключом, но пустыми
    for (const [key, value] of Object.entries(cardDraft)) {
      if (!String(key).startsWith('erp_attr_')) continue;
      if (Object.prototype.hasOwnProperty.call(clientContext, key) && !str(context[key])) {
        context[key] = str(value);
      }
    }

    const fieldLabels = outputFields.map((f) => f.label).join(', ');
    const emptyOutputs = outputFields
      .filter((f) => f.type !== 'vehicles' && !str(current[f.key]))
      .map((f) => f.label);
    const rules = [
      'Ты редактор карточки товара (ERP + маркетплейсы).',
      'Верни результат ТОЛЬКО через функцию propose_attribute_editor.',
      `Можно менять поля: ${fieldLabels}.`,
      'Опирайся только на поля из блока «Контекст» ниже (их выбрал пользователь).',
      'Если в контексте поле пустое — данных нет: не выдумывай марки/модели и не пиши плейсхолдеры («Авто 1», «пример»).',
      'Многострочный текст — настоящие переносы строк, не символы \\n.',
      fillEmptyOnly
        ? 'Заполняй пустые поля; заполненные не переписывай без явной просьбы.'
        : 'Перепиши поля по запросу пользователя, даже если они уже заполнены.',
    ];
    if (emptyOutputs.length) {
      rules.push(
        `Внимание: сейчас пустые поля в контексте: ${emptyOutputs.join(', ')}. Не заполняй их выдуманным текстом.`
      );
    }
    if (instruction) rules.push(`Запрос: ${instruction}`);
    rules.push(`Контекст:\n${JSON.stringify(context)}`);

    const response = await gigachatChatCompletions(settings, {
      model: settings.model,
      messages: [{ role: 'user', content: rules.join('\n') }],
      temperature: 0.25,
      max_tokens: 8000,
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

    for (const f of outputFields) {
      if (f.type === 'vehicles') continue;
      if (!str(current[f.key])) {
        warnings.push(
          `«${f.label}» на карточке пустое — в запрос ушло без данных. Заполните атрибут или выберите другие поля в «Учитывать».`
        );
      }
    }

    const contextPreview = {};
    for (const f of outputFields) {
      if (f.type === 'vehicles') continue;
      const v = str(context[f.label] || context[f.key] || current[f.key]);
      contextPreview[f.label] = v ? `${v.slice(0, 120)}${v.length > 120 ? '…' : ''}` : '(пусто)';
    }

    logger.info('[AI] attribute editor', {
      productId: body.productId,
      changed: changes.length,
      contextPreview,
    });

    return {
      productId: body.productId ?? null,
      proposed,
      changes,
      warnings,
      comment,
      contextPreview,
      fillEmptyOnlyApplied: fillEmptyOnly,
      model: settings.model,
    };
  }

  async proposeBulk(profileId, body = {}) {
    const list = Array.isArray(body.items) ? body.items : [];
    if (!list.length) throw aiHttpError('Нет товаров для генерации', 400);
    if (list.length > MAX_BULK_AI_CARDS) {
      throw aiHttpError(`За один раз не больше ${MAX_BULK_AI_CARDS} товаров`, 400);
    }
    const items = [];
    for (const it of list) {
      const one = await this.propose(profileId, {
        productId: it.productId,
        instruction: body.instruction,
        context: it.context,
        outputFields: body.outputFields,
        fillEmptyOnly: body.fillEmptyOnly,
      });
      items.push({ ...one, sku: str(it.sku) || one.sku || '' });
    }
    return { items };
  }
}

export default new AiAttributeEditorService();
