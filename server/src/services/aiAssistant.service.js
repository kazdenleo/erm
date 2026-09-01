/**
 * ИИ-ассистент: GigaChat + чтение аналитики FBS (без записи в БД).
 */

import repositoryFactory from '../config/repository-factory.js';
import marketplaceFbsReportsService from './marketplaceFbsReports.service.js';
import { gigachatChatCompletions, gigachatListModels } from './gigachat.client.js';
import {
  assertAiReady,
  mergeAiSettings,
  toPublicAiSettings,
  aiHttpError,
} from '../utils/aiSettings.js';
import logger from '../utils/logger.js';

const MAX_TOOL_ROUNDS = 5;
const MAX_HISTORY = 16;
const RUB_FIELDS = [
  'soldAmount',
  'commissionAmount',
  'logisticsAmount',
  'storageAmount',
  'penaltyAmount',
  'acquiringAmount',
  'otherDeductions',
  'payoutAmount',
  'costAmount',
  'additionalExpensesAmount',
  'taxAmount',
  'netIncome',
  'expensesTotal',
  'retailAmount',
];

const FUNCTIONS = [
  {
    name: 'get_fbs_summary',
    description:
      'Сводка продаж FBS за период: выручка, удержания маркетплейса, к перечислению, себестоимость, налог, чистая прибыль, число заказов. Вызывай, когда нужны итоги или сравнение цифр.',
    parameters: {
      type: 'object',
      properties: {
        dateFrom: { type: 'string', description: 'Начало периода YYYY-MM-DD. Если не указано — взять период со страницы.' },
        dateTo: { type: 'string', description: 'Конец периода YYYY-MM-DD' },
        marketplace: {
          type: 'string',
          enum: ['all', 'ozon', 'wb', 'ym'],
          description: 'Фильтр маркетплейса. all — все.',
        },
      },
    },
  },
  {
    name: 'get_fbs_products',
    description:
      'Список товаров FBS за период с экономикой (продажи, удержания, выплата, себестоимость, прибыль). Для топов, аутсайдеров, поиска артикула.',
    parameters: {
      type: 'object',
      properties: {
        dateFrom: { type: 'string' },
        dateTo: { type: 'string' },
        marketplace: { type: 'string', enum: ['all', 'ozon', 'wb', 'ym'] },
        search: { type: 'string', description: 'Фильтр по артикулу или названию' },
        sort: {
          type: 'string',
          enum: ['soldAmount', 'netIncome', 'soldQty', 'expensesTotal'],
          description: 'Сортировка по убыванию. По умолчанию soldAmount.',
        },
        limit: { type: 'integer', description: 'Сколько строк вернуть, 1–40. По умолчанию 20.' },
      },
    },
  },
  {
    name: 'get_fbs_orders',
    description: 'Список заказов/отправлений FBS за период с ценой продажи, удержаниями и выплатой.',
    parameters: {
      type: 'object',
      properties: {
        dateFrom: { type: 'string' },
        dateTo: { type: 'string' },
        marketplace: { type: 'string', enum: ['all', 'ozon', 'wb', 'ym'] },
        search: { type: 'string', description: 'Номер заказа, отправления или артикул' },
        limit: { type: 'integer', description: '1–25, по умолчанию 15.' },
      },
    },
  },
  {
    name: 'lookup_fbs_order',
    description: 'Карточка одного заказа FBS по номеру заказа или отправления.',
    parameters: {
      type: 'object',
      properties: {
        marketplace: { type: 'string', enum: ['ozon', 'wb', 'ym'] },
        orderId: { type: 'string', description: 'Номер заказа или отправления' },
      },
      required: ['orderId'],
    },
  },
];

function money(n) {
  const v = Number(n);
  return Number.isFinite(v) ? Math.round(v) : 0;
}

function compactMoneyObject(row) {
  if (!row || typeof row !== 'object') return row;
  const out = {};
  for (const [k, v] of Object.entries(row)) {
    if (v == null) continue;
    if (k === 'breakdown' || k === 'amountTooltips' || k === 'reportLines') continue;
    if (RUB_FIELDS.includes(k) || /amount|income|payout|tax|cost|expense/i.test(k)) {
      out[k] = money(v);
    } else if (typeof v === 'number' && Number.isFinite(v)) {
      out[k] = Number.isInteger(v) ? v : Math.round(v * 100) / 100;
    } else {
      out[k] = v;
    }
  }
  return out;
}

function compactProduct(row) {
  return compactMoneyObject({
    sku: row.sku,
    erpSku: row.erpSku,
    name: row.productName,
    qty: Number(row.soldQty) || 0,
    sales: row.soldAmount,
    holds: row.expensesTotal,
    payout: row.payoutAmount,
    cost: (Number(row.costAmount) || 0) + (Number(row.additionalExpensesAmount) || 0),
    tax: row.taxAmount,
    profit: row.netIncome,
  });
}

function compactOrder(row) {
  return compactMoneyObject({
    marketplace: row.marketplace,
    date: row.operationDate,
    orderId: row.orderId,
    postingNumber: row.postingNumber,
    sku: row.sku,
    name: row.productName,
    qty: Number(row.quantity) || 0,
    sales: row.retailAmount,
    holds: row.expensesTotal,
    payout: row.payoutAmount,
    cost: (Number(row.costAmount) || 0) + (Number(row.additionalExpensesAmount) || 0),
    tax: row.taxAmount,
    profit: row.netIncome,
  });
}

function normalizeMp(value, fallback = 'all') {
  const s = String(value || fallback || 'all').trim().toLowerCase();
  if (s === 'wildberries' || s === 'wb') return 'wb';
  if (s === 'yandex' || s === 'ym') return 'ym';
  if (s === 'ozon') return 'ozon';
  return 'all';
}

function ymdOr(value, fallback) {
  const s = String(value || '').trim();
  return /^\d{4}-\d{2}-\d{2}$/.test(s) ? s : fallback;
}

function messageText(message) {
  const c = message?.content;
  if (typeof c === 'string') return c;
  if (Array.isArray(c)) {
    return c
      .map((part) => {
        if (typeof part === 'string') return part;
        if (part && typeof part === 'object') return part.text || part.content || '';
        return '';
      })
      .join('');
  }
  return '';
}

function extractFunctionCall(message) {
  if (message?.function_call?.name) return message.function_call;
  const c = message?.content;
  if (!Array.isArray(c)) return null;
  for (const part of c) {
    if (part?.function_call?.name) return part.function_call;
  }
  return null;
}

function parseToolArgs(raw) {
  if (raw == null) return {};
  if (typeof raw === 'object' && !Array.isArray(raw)) return raw;
  if (typeof raw === 'string') {
    try {
      const parsed = JSON.parse(raw);
      return parsed && typeof parsed === 'object' ? parsed : {};
    } catch {
      return {};
    }
  }
  return {};
}

function matchesSearch(row, search) {
  const q = String(search || '').trim().toLowerCase();
  if (!q) return true;
  const blob = [
    row.sku,
    row.erpSku,
    row.productName,
    row.name,
    row.orderId,
    row.postingNumber,
  ]
    .filter(Boolean)
    .join(' ')
    .toLowerCase();
  return blob.includes(q);
}

class AiAssistantService {
  async _loadProfile(profileId) {
    if (!repositoryFactory.isUsingPostgreSQL()) {
      throw aiHttpError('ИИ доступен только при работе с PostgreSQL', 400);
    }
    const repo = repositoryFactory.getProfilesRepository();
    const row = await repo.findById(profileId);
    if (!row) throw aiHttpError('Аккаунт не найден', 404);
    return row;
  }

  async getPublicConfig(profileId) {
    const row = await this._loadProfile(profileId);
    return toPublicAiSettings(row.ai_settings ?? row.aiSettings);
  }

  async saveConfig(profileId, incoming) {
    const repo = repositoryFactory.getProfilesRepository();
    const row = await this._loadProfile(profileId);
    const next = mergeAiSettings(row.ai_settings ?? row.aiSettings, incoming || {});
    const saved = await repo.update(profileId, { ai_settings: next });
    return toPublicAiSettings(saved?.ai_settings ?? next);
  }

  async testConnection(profileId) {
    const row = await this._loadProfile(profileId);
    const settings = assertAiReady(row.ai_settings ?? row.aiSettings);
    const models = await gigachatListModels(settings);
    const ids = (models?.data || []).map((m) => m.id || m).filter(Boolean);
    return {
      ok: true,
      message: ids.length
        ? `Подключение успешно. Доступны модели: ${ids.slice(0, 8).join(', ')}`
        : 'Подключение успешно.',
      models: ids,
    };
  }

  async _runTool(name, args, { profileId, pageContext }) {
    const dateFrom = ymdOr(args.dateFrom, pageContext.dateFrom);
    const dateTo = ymdOr(args.dateTo, pageContext.dateTo);
    const marketplace = normalizeMp(args.marketplace, pageContext.marketplace);

    if (name === 'get_fbs_summary') {
      const data = await marketplaceFbsReportsService.getFbsByProduct({
        profileId,
        dateFrom,
        dateTo,
        marketplace,
        limit: 1000,
      });
      return {
        period: data.period,
        marketplace: data.marketplace,
        summary: compactMoneyObject(data.summary),
        tax: data.taxMeta
          ? { taxSystem: data.taxMeta.taxSystemLabel, organization: data.taxMeta.organizationName }
          : null,
      };
    }

    if (name === 'get_fbs_products') {
      const limit = Math.min(40, Math.max(1, parseInt(args.limit, 10) || 20));
      const data = await marketplaceFbsReportsService.getFbsByProduct({
        profileId,
        dateFrom,
        dateTo,
        marketplace,
        limit: 500,
      });
      const sortKey = ['soldAmount', 'netIncome', 'soldQty', 'expensesTotal'].includes(args.sort)
        ? args.sort
        : 'soldAmount';
      let items = (data.items || []).filter((row) => matchesSearch(row, args.search));
      items.sort((a, b) => (Number(b[sortKey]) || 0) - (Number(a[sortKey]) || 0));
      return {
        period: data.period,
        marketplace: data.marketplace,
        totalMatched: items.length,
        items: items.slice(0, limit).map(compactProduct),
      };
    }

    if (name === 'get_fbs_orders') {
      const limit = Math.min(25, Math.max(1, parseInt(args.limit, 10) || 15));
      const data = await marketplaceFbsReportsService.getFbsByOrder({
        profileId,
        dateFrom,
        dateTo,
        marketplace,
        limit: 400,
      });
      let items = (data.items || []).filter((row) => matchesSearch(row, args.search));
      return {
        period: data.period || { dateFrom, dateTo },
        marketplace,
        totalMatched: items.length,
        items: items.slice(0, limit).map(compactOrder),
      };
    }

    if (name === 'lookup_fbs_order') {
      const orderId = String(args.orderId || '').trim();
      if (!orderId) return { error: 'Не указан номер заказа' };
      const mp = normalizeMp(args.marketplace, pageContext.marketplace);
      if (mp === 'all') {
        return { error: 'Укажите маркетплейс: ozon, wb или ym' };
      }
      const data = await marketplaceFbsReportsService.lookupByOrder({
        profileId,
        marketplace: mp,
        orderId,
      });
      return compactMoneyObject(data);
    }

    return { error: `Неизвестная функция ${name}` };
  }

  _sanitizeHistory(messages) {
    const list = Array.isArray(messages) ? messages : [];
    const out = [];
    for (const msg of list) {
      const role = msg?.role === 'assistant' ? 'assistant' : msg?.role === 'user' ? 'user' : null;
      const content = String(msg?.content || '').trim();
      if (!role || !content) continue;
      out.push({ role, content: content.slice(0, 8000) });
    }
    return out.slice(-MAX_HISTORY);
  }

  /**
   * GigaChat 2 Max / thinking: functions нельзя слать вместе с role=system
   * (и с обычными assistant-репликами без function_call).
   */
  _buildFunctionDialog(system, history) {
    const prior = history.slice(0, -1);
    const last = history[history.length - 1];
    const parts = [system];
    if (prior.length) {
      parts.push(
        `Предыдущий диалог:\n${prior
          .map((m) => `${m.role === 'assistant' ? 'Ассистент' : 'Пользователь'}: ${m.content}`)
          .join('\n')}`
      );
    }
    parts.push(`Вопрос: ${last.content}`);
    return [{ role: 'user', content: parts.join('\n\n') }];
  }

  _functionCallPayload(fn) {
    const args = parseToolArgs(fn?.arguments);
    return {
      name: String(fn?.name || ''),
      arguments: args,
    };
  }

  async chat(profileId, { messages, context } = {}) {
    const row = await this._loadProfile(profileId);
    const settings = assertAiReady(row.ai_settings ?? row.aiSettings);
    const history = this._sanitizeHistory(messages);
    if (!history.length || history[history.length - 1].role !== 'user') {
      throw aiHttpError('Нужно сообщение пользователя');
    }

    const pageContext = {
      dateFrom: ymdOr(context?.dateFrom, null),
      dateTo: ymdOr(context?.dateTo, null),
      marketplace: normalizeMp(context?.marketplace, 'all'),
      source: String(context?.source || 'fbs'),
    };

    const system = [
      'Ты аналитик ERP по продажам FBS (Ozon, Wildberries, Яндекс Маркет).',
      'Отвечай по-русски, кратко и по цифрам из инструментов. Не выдумывай суммы, которых нет в ответе функции.',
      'Деньги — целые рубли. Если данных нет — скажи, что нужно нажать «Загрузить с маркетплейсов».',
      'Ты только читаешь данные, не меняешь товары и заказы.',
      pageContext.dateFrom && pageContext.dateTo
        ? `Период на экране: ${pageContext.dateFrom} … ${pageContext.dateTo}, маркетплейс: ${pageContext.marketplace}. Если пользователь не задал другой период — используй этот.`
        : '',
    ]
      .filter(Boolean)
      .join(' ');

    const dialog = this._buildFunctionDialog(system, history);
    const usedTools = [];
    let lastToolResult = null;

    for (let round = 0; round < MAX_TOOL_ROUNDS; round += 1) {
      const last = dialog[dialog.length - 1];
      const canSendFunctions = last?.role === 'user' || last?.role === 'function';
      const response = await gigachatChatCompletions(settings, {
        model: settings.model,
        messages: dialog,
        temperature: 0.2,
        max_tokens: 1800,
        function_call: canSendFunctions ? 'auto' : 'none',
        ...(canSendFunctions ? { functions: FUNCTIONS } : {}),
      });

      const choice = response?.choices?.[0] || {};
      const message = choice.message || {};
      const finish = choice.finish_reason;
      const fn = extractFunctionCall(message);

      if ((finish === 'function_call' || fn?.name) && fn?.name) {
        const args = parseToolArgs(fn.arguments);
        usedTools.push(fn.name);
        let result;
        try {
          result = await this._runTool(fn.name, args, { profileId, pageContext });
        } catch (err) {
          logger.warn('[AI] tool failed', { name: fn.name, message: err.message });
          result = { error: err.message || String(err) };
        }
        lastToolResult = result;
        const assistantMsg = {
          role: 'assistant',
          content: messageText(message),
          function_call: this._functionCallPayload(fn),
        };
        if (message.functions_state_id) {
          assistantMsg.functions_state_id = message.functions_state_id;
        }
        dialog.push(assistantMsg);
        const fnMsg = {
          role: 'function',
          name: fn.name,
          content: JSON.stringify(result),
        };
        if (message.functions_state_id) {
          fnMsg.functions_state_id = message.functions_state_id;
        }
        dialog.push(fnMsg);
        continue;
      }

      const text = messageText(message).trim();
      if (!text) {
        if (lastToolResult) {
          return {
            reply:
              'Получил данные из отчёта FBS, но модель не сформулировала текст. Попробуйте уточнить вопрос — например: «итоги за период» или «топ товаров по прибыли».',
            usedTools,
            model: settings.model,
          };
        }
        throw aiHttpError('GigaChat вернул пустой ответ. Попробуйте переформулировать вопрос.', 502);
      }
      return { reply: text, usedTools, model: settings.model };
    }

    throw aiHttpError('Модель слишком долго вызывала инструменты. Упростите вопрос.', 502);
  }
}

export default new AiAssistantService();
