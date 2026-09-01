/**
 * Черновик текстовых полей карточки товара через GigaChat.
 * В БД и на маркетплейсы ничего не пишет — только превью патча.
 */

import productsService from './products.service.js';
import { gigachatChatCompletions } from './gigachat.client.js';
import {
  assertAiReady,
  aiHttpError,
} from '../utils/aiSettings.js';
import {
  AI_CARD_FIELD_MAX,
  AI_CARD_FIELD_LABEL,
  AI_CARD_FIELDS,
  MAX_BULK_AI_CARDS,
  normalizeAiCardFields,
  instructionAllowsOverwrite,
} from '../utils/aiProductCardFields.js';
import logger from '../utils/logger.js';
import repositoryFactory from '../config/repository-factory.js';

const PROPOSE_FN = 'propose_product_card';
const PROPOSE_BULK_FN = 'propose_product_cards';

function str(v) {
  return v == null ? '' : String(v).trim();
}

function parseToolArgs(raw) {
  if (raw == null) return {};
  if (typeof raw === 'object' && !Array.isArray(raw)) return unwrapPatch(raw);
  if (typeof raw === 'string') {
    const s = raw.trim();
    try {
      const parsed = JSON.parse(s);
      return parsed && typeof parsed === 'object' ? unwrapPatch(parsed) : {};
    } catch {
      const m = s.match(/\{[\s\S]*\}/);
      if (!m) return {};
      try {
        const parsed = JSON.parse(m[0]);
        return parsed && typeof parsed === 'object' ? unwrapPatch(parsed) : {};
      } catch {
        return {};
      }
    }
  }
  return {};
}

function unwrapPatch(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return {};
  const nested = raw[PROPOSE_FN] || raw[PROPOSE_BULK_FN] || raw.patch || raw.fields;
  const src = nested && typeof nested === 'object' && !Array.isArray(nested) ? nested : raw;
  const byLabel = Object.fromEntries(AI_CARD_FIELDS.map((f) => [f.label.toLowerCase(), f.key]));
  const out = { ...src };
  for (const [k, v] of Object.entries(src)) {
    const mapped = byLabel[String(k).toLowerCase()];
    if (mapped && (out[mapped] == null || out[mapped] === '')) out[mapped] = v;
  }
  return out;
}

function extractFunctionCall(message) {
  if (message?.function_call?.name) return message.function_call;
  const c = message?.content;
  if (Array.isArray(c)) {
    for (const part of c) {
      if (part?.function_call?.name) return part.function_call;
    }
  }
  const extra = message?.functions_state || message?.thinking_functions;
  if (Array.isArray(extra)) {
    for (const part of extra) {
      if (part?.name || part?.function_call?.name) {
        return part.function_call || part;
      }
    }
  }
  return null;
}

function parseJsonObject(text) {
  const s = str(text);
  if (!s) return null;
  try {
    const parsed = JSON.parse(s);
    return parsed && typeof parsed === 'object' ? unwrapPatch(parsed) : null;
  } catch {
    const m = s.match(/\{[\s\S]*\}/);
    if (!m) return null;
    try {
      const parsed = JSON.parse(m[0]);
      return parsed && typeof parsed === 'object' ? unwrapPatch(parsed) : null;
    } catch {
      return null;
    }
  }
}

function compactProduct(product, draft = {}) {
  const src = { ...(product || {}), ...(draft && typeof draft === 'object' ? draft : {}) };
  const out = {
    id: src.id ?? src.product_id ?? null,
    sku: str(src.sku),
    name: str(src.name),
    description: str(src.description),
    brand: str(src.brand || src.brand_name),
    country_of_origin: str(src.country_of_origin || src.countryOfOrigin),
    category: str(src.category_name || src.categoryName || src.category),
    mp_ozon_name: str(src.mp_ozon_name),
    mp_ozon_description: str(src.mp_ozon_description),
    mp_wb_name: str(src.mp_wb_name),
    mp_wb_description: str(src.mp_wb_description),
    mp_ym_name: str(src.mp_ym_name),
    mp_ym_description: str(src.mp_ym_description),
  };
  return out;
}

function sanitizePatch(raw, current, fields, { fillEmptyOnly }) {
  const src = raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {};
  const proposed = {};
  const changes = [];
  const warnings = [];
  const skippedFilled = [];
  for (const key of fields) {
    let next = str(src[key]);
    if (!next) continue;
    const max = AI_CARD_FIELD_MAX[key] || 2000;
    if (next.length > max) {
      next = next.slice(0, max).trim();
      warnings.push(`${AI_CARD_FIELD_LABEL[key] || key}: обрезано до ${max} символов`);
    }
    const prev = str(current[key]);
    if (next === prev) continue;
    if (fillEmptyOnly && prev.length >= 12) {
      skippedFilled.push({ field: key, label: AI_CARD_FIELD_LABEL[key] || key, from: prev });
      continue;
    }
    proposed[key] = next;
    changes.push({
      field: key,
      label: AI_CARD_FIELD_LABEL[key] || key,
      from: prev,
      to: next,
    });
  }
  return { proposed, changes, warnings, skippedFilled, comment: str(src.comment) };
}

function fieldProperties(fields) {
  const properties = {
    comment: { type: 'string', description: 'Кратко, что заполнил и на что опирался' },
  };
  for (const key of fields) {
    properties[key] = {
      type: 'string',
      description: `${AI_CARD_FIELD_LABEL[key] || key}. Обязательно верни новый текст, если поле нужно заполнить или переписать.`,
    };
  }
  return properties;
}

async function loadOwnedProduct(profileId, productId) {
  const id = Number(productId);
  if (!Number.isInteger(id) || id < 1) {
    throw aiHttpError('Некорректный id товара', 400);
  }
  const product = await productsService.getById(id);
  const pid = product.profile_id ?? product.profileId;
  if (pid != null && String(pid) !== String(profileId)) {
    throw aiHttpError('Товар не найден', 404);
  }
  return product;
}

async function loadAiSettings(profileId) {
  if (!repositoryFactory.isUsingPostgreSQL()) {
    throw aiHttpError('ИИ доступен только при работе с PostgreSQL', 400);
  }
  const row = await repositoryFactory.getProfilesRepository().findById(profileId);
  if (!row) throw aiHttpError('Аккаунт не найден', 404);
  return assertAiReady(row.ai_settings ?? row.aiSettings);
}

const MAX_INSTRUCTION = 2000;

function buildUserPrompt({ instruction, fields, fillEmptyOnly, items }) {
  const fieldLabels = fields.map((k) => AI_CARD_FIELD_LABEL[k] || k).join(', ');
  const rules = [
    'Ты редактор карточек товаров для маркетплейсов Ozon, Wildberries и Яндекс Маркет.',
    'Верни черновик ТОЛЬКО через функцию. Не отвечай обычным текстом.',
    `Можно менять только поля: ${fieldLabels}.`,
    'Пиши по-русски, коротко, без воды и эмодзи. Не выдумывай характеристики, сертификаты, размеры и совместимость, которых нет во входных данных.',
    'SKU, штрихкоды, цены и id не трогай.',
    fillEmptyOnly
      ? 'Заполняй пустые поля. Уже заполненные не переписывай, если пользователь явно не попросил переписать.'
      : 'Перепиши указанные поля по пожеланию пользователя, даже если они уже заполнены.',
    'Названия для МП — продающие, но без капса и без спама ключами. Описание — факты из карточки.',
  ];
  const userNote = str(instruction).slice(0, MAX_INSTRUCTION);
  if (userNote) rules.push(`Пожелание пользователя: ${userNote}`);
  rules.push(`Данные:\n${JSON.stringify(items)}`);
  return rules.join('\n');
}

async function callPropose(settings, { functionName, parameters, userContent }) {
  const response = await gigachatChatCompletions(settings, {
    model: settings.model,
    messages: [{ role: 'user', content: userContent }],
    temperature: 0.3,
    max_tokens: 3500,
    function_call: { name: functionName },
    functions: [
      {
        name: functionName,
        description: 'Черновик текстовых полей карточки. Верни готовый текст по каждому полю, которое нужно заполнить или переписать.',
        parameters,
      },
    ],
  });
  const message = response?.choices?.[0]?.message || {};
  const fn = extractFunctionCall(message);
  if (fn?.name) {
    const args = parseToolArgs(fn.arguments);
    const hasText = Object.entries(args).some(([k, v]) => k !== 'comment' && str(v));
    if (hasText) return args;
  }
  const fromText = parseJsonObject(
    typeof message.content === 'string'
      ? message.content
      : Array.isArray(message.content)
        ? message.content
            .map((p) => (typeof p === 'string' ? p : p?.text || p?.content || ''))
            .join('\n')
        : ''
  );
  if (fromText) {
    const hasText = Object.entries(fromText).some(([k, v]) => k !== 'comment' && str(v));
    if (hasText) return fromText;
  }
  if (fn?.name) return parseToolArgs(fn.arguments);
  throw aiHttpError('GigaChat не вернул черновик полей. Попробуйте ещё раз или упростите запрос.', 422);
}

class AiProductCardService {
  async propose(profileId, { productId, draft, instruction, fields, fillEmptyOnly } = {}) {
    const settings = await loadAiSettings(profileId);
    const wanted = normalizeAiCardFields(fields);
    const fillEmpty = fillEmptyOnly !== false && !instructionAllowsOverwrite(instruction);
    let current = {};
    let sku = '';
    let id = productId || null;
    if (productId) {
      const product = await loadOwnedProduct(profileId, productId);
      current = compactProduct(product, draft);
      sku = current.sku;
      id = product.id;
    } else {
      current = compactProduct({}, draft);
      sku = current.sku;
    }
    if (!str(current.name) && !str(current.sku) && !str(instruction)) {
      throw aiHttpError('Нужны название, артикул или текстовое пожелание', 400);
    }

    const raw = await callPropose(settings, {
      functionName: PROPOSE_FN,
      parameters: { type: 'object', properties: fieldProperties(wanted) },
      userContent: buildUserPrompt({
        instruction,
        fields: wanted,
        fillEmptyOnly: fillEmpty,
        items: current,
      }),
    });
    const { proposed, changes, warnings, skippedFilled, comment } = sanitizePatch(raw, current, wanted, {
      fillEmptyOnly: fillEmpty,
    });
    logger.info('[AI] product card draft', {
      productId: id,
      changed: changes.length,
      fillEmpty,
    });
    return {
      productId: id,
      sku,
      current,
      proposed,
      changes,
      warnings,
      comment,
      fillEmptyOnlyApplied: fillEmpty,
      emptyReason: changes.length
        ? null
        : skippedFilled.length
          ? 'all_filled'
          : 'no_model_changes',
      model: settings.model,
    };
  }

  async proposeBulk(profileId, { items, instruction, fields, fillEmptyOnly } = {}) {
    const settings = await loadAiSettings(profileId);
    const wanted = normalizeAiCardFields(fields);
    const fillEmpty = fillEmptyOnly !== false && !instructionAllowsOverwrite(instruction);
    const list = Array.isArray(items) ? items : [];
    if (!list.length) throw aiHttpError('Нет товаров для черновика');
    if (list.length > MAX_BULK_AI_CARDS) {
      throw aiHttpError(`За один раз не больше ${MAX_BULK_AI_CARDS} товаров`, 400);
    }

    const packed = [];
    for (const row of list) {
      const pid = row?.productId ?? row?.id;
      let current;
      if (pid) {
        const product = await loadOwnedProduct(profileId, pid);
        current = compactProduct(product, row?.draft);
      } else {
        current = compactProduct({}, row?.draft);
      }
      packed.push({
        productId: pid || null,
        sku: current.sku,
        current,
      });
    }

    const raw = await callPropose(settings, {
      functionName: PROPOSE_BULK_FN,
      parameters: {
        type: 'object',
        properties: {
          comment: { type: 'string' },
          items: {
            type: 'array',
            items: {
              type: 'object',
              properties: {
                sku: { type: 'string' },
                ...fieldProperties(wanted),
              },
            },
          },
        },
      },
      userContent: buildUserPrompt({
        instruction,
        fields: wanted,
        fillEmptyOnly: fillEmpty,
        items: packed.map((p) => p.current),
      }),
    });

    const rawItems = Array.isArray(raw.items)
      ? raw.items
      : Array.isArray(raw)
        ? raw
        : packed.length === 1
          ? [raw]
          : [];
    const bySku = new Map();
    for (const it of rawItems) {
      const sku = str(it?.sku).toLowerCase();
      if (sku) bySku.set(sku, it);
    }

    const outItems = packed.map((p, idx) => {
      const rawItem = bySku.get(str(p.sku).toLowerCase()) || rawItems[idx] || {};
      const { proposed, changes, warnings, skippedFilled, comment } = sanitizePatch(rawItem, p.current, wanted, {
        fillEmptyOnly: fillEmpty,
      });
      return {
        productId: p.productId,
        sku: p.sku,
        current: p.current,
        proposed,
        changes,
        warnings,
        comment,
        emptyReason: changes.length
          ? null
          : skippedFilled.length
            ? 'all_filled'
            : 'no_model_changes',
      };
    });

    logger.info('[AI] product card bulk draft', {
      count: outItems.length,
      changed: outItems.filter((x) => x.changes.length).length,
    });

    return {
      items: outItems,
      comment: str(raw.comment),
      fillEmptyOnlyApplied: fillEmpty,
      emptyReason: outItems.some((x) => x.changes.length)
        ? null
        : outItems.some((x) => x.emptyReason === 'all_filled')
          ? 'all_filled'
          : 'no_model_changes',
      model: settings.model,
    };
  }
}

export default new AiProductCardService();
