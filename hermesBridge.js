const crypto = require('crypto');
const incomingMessagesStore = require('./incomingMessagesStore');

const DEFAULT_LIMIT = 50;
const MAX_LIMIT = 200;

function getBridgeToken() {
  return String(process.env.HERMES_BRIDGE_TOKEN || '').trim();
}

function isConfigured() {
  return Boolean(getBridgeToken());
}

function extractToken(req) {
  const auth = String(req.headers.authorization || '').trim();
  const bearer = auth.startsWith('Bearer ') ? auth.slice(7).trim() : '';
  return String(
    req.headers['x-hermes-token'] || bearer || req.query.token || ''
  ).trim();
}

function tokensMatch(expected, got) {
  if (!expected || !got) return false;
  try {
    const a = Buffer.from(expected);
    const b = Buffer.from(got);
    if (a.length !== b.length) return false;
    return crypto.timingSafeEqual(a, b);
  } catch {
    return false;
  }
}

/**
 * @param {import('express').Request} req
 * @param {import('express').Response} res
 * @returns {boolean}
 */
function verifyRequest(req, res) {
  const expected = getBridgeToken();
  if (!expected) {
    res.status(503).json({
      success: false,
      error: 'Hermes bridge no configurado. Define HERMES_BRIDGE_TOKEN en .env'
    });
    return false;
  }
  const got = extractToken(req);
  if (!tokensMatch(expected, got)) {
    res.status(401).json({ success: false, error: 'Token Hermes inválido' });
    return false;
  }
  return true;
}

/**
 * @param {string|number|Date|null|undefined} raw
 * @returns {Date|null}
 */
function parseSince(raw) {
  if (raw == null || raw === '') return null;
  if (raw instanceof Date) {
    return Number.isFinite(raw.getTime()) ? raw : null;
  }
  const s = String(raw).trim();
  if (!s) return null;

  if (/^\d+$/.test(s)) {
    const n = Number(s);
    if (!Number.isFinite(n)) return null;
    const ms = s.length <= 10 ? n * 1000 : n;
    const d = new Date(ms);
    return Number.isFinite(d.getTime()) ? d : null;
  }

  const d = new Date(s);
  return Number.isFinite(d.getTime()) ? d : null;
}

/**
 * @param {object} message
 * @returns {object}
 */
function normalizeForHermes(message) {
  return {
    id: message.id,
    messageId: message.messageId,
    timestamp: message.timestamp,
    sessionId: message.sessionId,
    openwaSessionId: message.openwaSessionId,
    telefono: message.telefono,
    contactName: message.contactName,
    body: message.body,
    chatId: message.chatId,
    fromMe: Boolean(message.fromMe),
    isGroup: Boolean(message.isGroup),
    mediaType: message.mediaType || null,
    autoReplyHandled: Boolean(message.autoReplyHandled),
    autoReplyReason: message.autoReplyReason || null,
    hermesStatus: message.hermesStatus || null,
    hermesAckAt: message.hermesAckAt || null,
    replyMessage: message.replyMessage || null
  };
}

/**
 * Mensajes entrantes para el daemon Hermes (Windows → polling WSL).
 * @param {{ since?: string|number|Date, limit?: number, sessionId?: string, openwaSessionId?: string, includeHandled?: boolean }} opts
 */
function listInbox(opts = {}) {
  const sinceDate = parseSince(opts.since);
  const sinceMs = sinceDate ? sinceDate.getTime() : null;

  const limitRaw = parseInt(opts.limit, 10);
  const limit = Math.min(
    Math.max(Number.isFinite(limitRaw) ? limitRaw : DEFAULT_LIMIT, 1),
    MAX_LIMIT
  );

  let messages = incomingMessagesStore.list({
    limit: incomingMessagesStore.MAX_MESSAGES,
    sessionId: opts.sessionId || undefined
  });

  messages = messages.filter((m) => !m.fromMe && !m.isGroup);

  if (opts.openwaSessionId) {
    const sid = String(opts.openwaSessionId).trim();
    messages = messages.filter((m) => m.openwaSessionId === sid);
  }

  if (sinceMs != null) {
    messages = messages.filter((m) => {
      const t = new Date(m.timestamp).getTime();
      return Number.isFinite(t) && t > sinceMs;
    });
  }

  if (!opts.includeHandled) {
    messages = messages.filter((m) => !m.autoReplyHandled);
  }

  messages.sort(
    (a, b) => new Date(a.timestamp).getTime() - new Date(b.timestamp).getTime()
  );

  const slice = messages.slice(-limit);
  return {
    messages: slice.map(normalizeForHermes),
    total: slice.length,
    since: sinceDate ? sinceDate.toISOString() : null,
    serverTime: new Date().toISOString()
  };
}

const MAX_ACK_BATCH = 100;
const HERMES_STATUSES = new Set([
  'esperando_respuesta',
  'negociando_reunion',
  'reunion_agendada',
  'meeting_scheduled',
  'lost_lead',
  'perdido',
  'skipped'
]);

/**
 * @param {unknown} value
 * @returns {string[]}
 */
function normalizeIdList(value) {
  if (value == null) return [];
  const raw = Array.isArray(value) ? value : [value];
  return [
    ...new Set(
      raw
        .map((v) => String(v || '').trim())
        .filter(Boolean)
    )
  ];
}

/**
 * Marca mensajes del inbox como procesados por Hermes.
 * @param {{ ids?: string|string[], messageIds?: string|string[], status?: string, replyMessage?: string }} input
 */
function ackMessages(input = {}) {
  const ids = normalizeIdList(input.ids);
  const messageIds = normalizeIdList(input.messageIds);
  if (!ids.length && !messageIds.length) {
    const err = new Error('ids o messageIds es obligatorio');
    err.status = 400;
    throw err;
  }
  if (ids.length + messageIds.length > MAX_ACK_BATCH) {
    const err = new Error(`Máximo ${MAX_ACK_BATCH} ids por request`);
    err.status = 400;
    throw err;
  }

  const statusRaw = input.status != null ? String(input.status).trim() : '';
  if (statusRaw && !HERMES_STATUSES.has(statusRaw)) {
    const err = new Error(
      `status inválido. Valores: ${[...HERMES_STATUSES].join(', ')}`
    );
    err.status = 400;
    throw err;
  }

  const patch = {
    autoReplyHandled: true,
    autoReplyReason: 'hermes',
    hermesAckAt: new Date().toISOString()
  };
  if (statusRaw) patch.hermesStatus = statusRaw;
  if (input.replyMessage != null && String(input.replyMessage).trim()) {
    patch.replyMessage = String(input.replyMessage).trim();
  }

  const all = incomingMessagesStore.list({ limit: incomingMessagesStore.MAX_MESSAGES });
  const targets = new Map();

  for (const id of ids) {
    targets.set(id, { kind: 'id', value: id });
  }

  for (const messageId of messageIds) {
    const norm = incomingMessagesStore.normalizeMessageId(messageId) || messageId;
    const match = all.find((m) => {
      const stored = incomingMessagesStore.normalizeMessageId(m.messageId);
      return stored === norm || m.messageId === messageId;
    });
    if (match) {
      targets.set(match.id, { kind: 'messageId', value: messageId });
    } else {
      targets.set(`__missing_msg__:${messageId}`, { kind: 'messageId', value: messageId, missing: true });
    }
  }

  const acknowledged = [];
  const notFound = [];

  for (const [key, meta] of targets.entries()) {
    if (meta.missing) {
      notFound.push({ messageId: meta.value });
      continue;
    }
    const updated = incomingMessagesStore.update(key, patch);
    if (updated) {
      acknowledged.push(normalizeForHermes(updated));
    } else if (meta.kind === 'id') {
      notFound.push({ id: meta.value });
    } else {
      notFound.push({ messageId: meta.value });
    }
  }

  return {
    acknowledged,
    notFound,
    total: acknowledged.length
  };
}

module.exports = {
  DEFAULT_LIMIT,
  MAX_LIMIT,
  MAX_ACK_BATCH,
  HERMES_STATUSES,
  getBridgeToken,
  isConfigured,
  extractToken,
  verifyRequest,
  parseSince,
  listInbox,
  ackMessages,
  normalizeForHermes
};
