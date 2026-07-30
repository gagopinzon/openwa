const axios = require('axios');
const { extractProfileNameFromOpenWA } = require('./messageSignature');

function getBaseConfig() {
  const baseUrl = (process.env.OPENWA_BASE_URL || 'https://openwa.protalentconnections.com/api').replace(
    /\/$/,
    ''
  );
  const apiKey = process.env.OPENWA_API_KEY || '';
  return { baseUrl, apiKey };
}

function assertOpenWAConfigured() {
  const { apiKey } = getBaseConfig();
  if (!apiKey) {
    throw new Error('OPENWA_API_KEY no está configurado en las variables de entorno');
  }
}

function normalizeOpenWASessionRow(row) {
  if (!row || typeof row !== 'object') return null;
  const id = row.id || row.sessionId;
  if (!id) return null;
  return {
    id: String(id),
    name: String(row.name || row.profileName || id),
    status: String(row.status || row.state || ''),
    phoneNumber: row.phoneNumber || row.phone ? String(row.phoneNumber || row.phone) : ''
  };
}

/**
 * Lista sesiones disponibles en el servidor OpenWA.
 * @param {{ status?: string, limit?: number }} [params]
 */
async function listOpenWASessions(params = {}) {
  const qs = new URLSearchParams();
  if (params.status) qs.set('status', params.status);
  if (params.limit) qs.set('limit', String(params.limit));
  const query = qs.toString() ? `?${qs.toString()}` : '';

  const data = await openwaRequest('GET', `/sessions${query}`);
  const rawList = Array.isArray(data)
    ? data
    : data.data || data.sessions || [];

  return rawList.map(normalizeOpenWASessionRow).filter(Boolean);
}

/** Formatea número MX a chatId de OpenWA (ej. 521234567890@c.us) */
function formatPhoneToChatId(phoneNumber) {
  const clean = String(phoneNumber || '').replace(/\D/g, '');
  if (clean.length < 10) {
    throw new Error('El número de teléfono debe tener al menos 10 dígitos');
  }

  let normalized;
  if (clean.length === 10) {
    normalized = `521${clean}`;
  } else if (clean.startsWith('521') && clean.length >= 13) {
    normalized = clean;
  } else if (clean.startsWith('52') && clean.length === 12) {
    normalized = `521${clean.slice(2)}`;
  } else if (clean.startsWith('52')) {
    normalized = clean;
  } else {
    normalized = `521${clean.slice(-10)}`;
  }

  return `${normalized}@c.us`;
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function isRateLimitError(status, message) {
  if (status === 429) return true;
  const msg = String(message || '');
  return /ThrottlerException|Too Many Requests/i.test(msg);
}

function createOpenWAError(message, { status, code } = {}) {
  const err = new Error(message);
  if (status != null) err.status = status;
  if (code) err.code = code;
  return err;
}

async function openwaRequest(method, path, body, opts = {}) {
  const { baseUrl, apiKey } = getBaseConfig();
  assertOpenWAConfigured();

  const timeout = Number.isFinite(opts.timeout) ? opts.timeout : 30000;
  const allowRetry = opts.retry !== false;

  const response = await axios({
    method,
    url: `${baseUrl}${path}`,
    headers: {
      'Content-Type': 'application/json',
      'X-API-Key': apiKey
    },
    data: body,
    timeout,
    validateStatus: () => true
  });

  const data = response.data || {};
  if (response.status < 200 || response.status >= 300) {
    const message =
      data.message || data.error || `OpenWA error ${response.status}`;

    if (allowRetry && isRateLimitError(response.status, message)) {
      const retryAfterHeader = response.headers && response.headers['retry-after'];
      const retryAfterSec = parseInt(retryAfterHeader, 10);
      const waitMs = Number.isFinite(retryAfterSec)
        ? Math.min(Math.max(retryAfterSec * 1000, 1000), 10000)
        : 3000;
      await sleep(waitMs);
      return openwaRequest(method, path, body, { ...opts, retry: false });
    }

    if (isRateLimitError(response.status, message)) {
      throw createOpenWAError(message, {
        status: 429,
        code: 'RATE_LIMIT'
      });
    }

    throw createOpenWAError(message, { status: response.status });
  }
  return data;
}

const OPENWA_CACHE_TTL_MS = 18000;
const openwaCache = new Map();

function getCached(key) {
  const entry = openwaCache.get(key);
  if (!entry) return undefined;
  if (Date.now() > entry.expiresAt) {
    openwaCache.delete(key);
    return undefined;
  }
  return entry.value;
}

function setCached(key, value, ttlMs = OPENWA_CACHE_TTL_MS) {
  openwaCache.set(key, { value, expiresAt: Date.now() + ttlMs });
  return value;
}

function invalidateOpenWACache({ openwaSessionId, chatId } = {}) {
  if (!openwaSessionId) {
    openwaCache.clear();
    return;
  }
  const sessionPrefix = `chats:${openwaSessionId}:`;
  const historyPrefix = chatId
    ? `history:${openwaSessionId}:${chatId}:`
    : `history:${openwaSessionId}:`;
  for (const key of openwaCache.keys()) {
    if (key.startsWith(sessionPrefix) || key.startsWith(historyPrefix)) {
      openwaCache.delete(key);
    }
  }
}

function isConnectedStatus(status) {
  const s = String(status || '').toLowerCase();
  return s === 'connected' || s === 'open' || s === 'ready';
}

/**
 * @param {string} openwaSessionId
 * @returns {Promise<{ connected: boolean, status: string, raw: object }>}
 */
async function getSessionStatus(openwaSessionId) {
  const data = await openwaRequest('GET', `/sessions/${openwaSessionId}`);
  const status = data.status || data.state || '';
  return {
    connected: isConnectedStatus(status),
    status: String(status),
    profileName: extractProfileName(data),
    raw: data
  };
}

/** @param {object|null|undefined} raw */
function extractProfileName(raw) {
  return extractProfileNameFromOpenWA(raw);
}

async function sendTextMessage(openwaSessionId, chatId, text) {
  const data = await openwaRequest(
    'POST',
    `/sessions/${openwaSessionId}/messages/send-text`,
    { chatId, text }
  );
  return {
    messageId: data.id || data.messageId,
    raw: data
  };
}

/**
 * Edita un mensaje propio.
 * @param {string} openwaSessionId
 * @param {{ chatId: string, messageId: string, body: string }} input
 */
async function editMessage(openwaSessionId, input) {
  const chatId = String(input.chatId || '').trim();
  const messageId = String(input.messageId || '').trim();
  const body = String(input.body || '').trim();
  if (!chatId) throw new Error('chatId es obligatorio');
  if (!messageId) throw new Error('messageId es obligatorio');
  if (!body) throw new Error('El texto del mensaje no puede estar vacío');
  if (body.length > 4096) throw new Error('El mensaje es demasiado largo (máx. 4096)');

  const data = await openwaRequest(
    'POST',
    `/sessions/${openwaSessionId}/messages/edit`,
    { chatId, messageId, body }
  );
  return {
    messageId: data.messageId || messageId,
    timestamp: data.timestamp != null ? Number(data.timestamp) : null,
    raw: data
  };
}

/**
 * Elimina un mensaje (por defecto para todos).
 * @param {string} openwaSessionId
 * @param {{ chatId: string, messageId: string, forEveryone?: boolean }} input
 */
async function deleteMessage(openwaSessionId, input) {
  const chatId = String(input.chatId || '').trim();
  const messageId = String(input.messageId || '').trim();
  if (!chatId) throw new Error('chatId es obligatorio');
  if (!messageId) throw new Error('messageId es obligatorio');

  const data = await openwaRequest(
    'POST',
    `/sessions/${openwaSessionId}/messages/delete`,
    {
      chatId,
      messageId,
      forEveryone: input.forEveryone !== false
    }
  );
  return { success: true, raw: data };
}

/**
 * @param {string} openwaSessionId
 * @param {string} contactId - JID, ej. 521...@c.us
 */
async function getContact(openwaSessionId, contactId) {
  const encoded = encodeURIComponent(String(contactId || '').trim());
  if (!encoded) throw new Error('contactId es obligatorio');
  const data = await openwaRequest(
    'GET',
    `/sessions/${openwaSessionId}/contacts/${encoded}`
  );
  return {
    id: String(data.id || contactId),
    name: data.name || data.pushName || null,
    isBlocked: Boolean(data.isBlocked),
    raw: data
  };
}

/**
 * @param {string} openwaSessionId
 * @param {string} contactId
 */
async function blockContact(openwaSessionId, contactId) {
  const encoded = encodeURIComponent(String(contactId || '').trim());
  if (!encoded) throw new Error('contactId es obligatorio');
  const data = await openwaRequest(
    'POST',
    `/sessions/${openwaSessionId}/contacts/${encoded}/block`,
    {}
  );
  return { success: true, message: data.message || 'Contacto bloqueado', raw: data };
}

/**
 * @param {string} openwaSessionId
 * @param {string} contactId
 */
async function unblockContact(openwaSessionId, contactId) {
  const encoded = encodeURIComponent(String(contactId || '').trim());
  if (!encoded) throw new Error('contactId es obligatorio');
  const data = await openwaRequest(
    'DELETE',
    `/sessions/${openwaSessionId}/contacts/${encoded}/block`
  );
  return { success: true, message: data.message || 'Contacto desbloqueado', raw: data };
}

/**
 * Lista chats activos de una sesión OpenWA (más recientes primero).
 * @param {string} openwaSessionId
 * @param {{ limit?: number, offset?: number }} [opts]
 */
async function listChats(openwaSessionId, opts = {}) {
  const qs = new URLSearchParams();
  const limit = Math.min(Math.max(parseInt(opts.limit, 10) || 100, 1), 1000);
  const offset = Math.max(parseInt(opts.offset, 10) || 0, 0);
  qs.set('limit', String(limit));
  qs.set('offset', String(offset));

  const cacheKey = `chats:${openwaSessionId}:${limit}:${offset}`;
  if (!opts.fresh) {
    const cached = getCached(cacheKey);
    if (cached) return cached;
  }

  const data = await openwaRequest(
    'GET',
    `/sessions/${openwaSessionId}/chats?${qs.toString()}`
  );
  const raw = Array.isArray(data) ? data : data.data || data.chats || [];
  const chats = raw
    .map((row) => {
      if (!row || typeof row !== 'object') return null;
      const id = row.id || row.chatId;
      if (!id) return null;
      return {
        id: String(id),
        name: String(row.name || row.pushName || row.chatName || id),
        isGroup: Boolean(row.isGroup),
        unreadCount: Number(row.unreadCount) || 0,
        timestamp: row.timestamp != null ? Number(row.timestamp) : null,
        lastMessage: row.lastMessage != null ? String(row.lastMessage) : ''
      };
    })
    .filter(Boolean);
  return setCached(cacheKey, chats);
}

/**
 * Historial de un chat (live desde WhatsApp).
 * @param {string} openwaSessionId
 * @param {string} chatId
 * @param {{ limit?: number, fresh?: boolean }} [opts]
 */
async function getChatHistory(openwaSessionId, chatId, opts = {}) {
  const limit = Math.min(Math.max(parseInt(opts.limit, 10) || 50, 1), 100);
  const cacheKey = `history:${openwaSessionId}:${chatId}:${limit}`;
  if (!opts.fresh) {
    const cached = getCached(cacheKey);
    if (cached) return cached;
  }

  const encoded = encodeURIComponent(String(chatId));
  const data = await openwaRequest(
    'GET',
    `/sessions/${openwaSessionId}/messages/${encoded}/history?limit=${limit}`
  );
  const raw = Array.isArray(data) ? data : data.messages || data.data || [];
  const messages = raw
    .map((msg) => {
      if (!msg || typeof msg !== 'object') return null;
      const body = String(msg.body || msg.text || msg.caption || '').trim();
      const type = String(msg.type || 'text');
      return {
        id: msg.id || msg.waMessageId || null,
        chatId: msg.chatId || chatId,
        from: msg.from || null,
        to: msg.to || null,
        body: body || (type !== 'text' ? `[${type}]` : ''),
        type,
        fromMe: Boolean(msg.fromMe || msg.direction === 'outgoing'),
        isGroup: Boolean(msg.isGroup),
        timestamp: msg.timestamp != null ? Number(msg.timestamp) : null,
        contactName:
          (msg.contact && (msg.contact.pushName || msg.contact.name)) ||
          msg.pushName ||
          msg.senderName ||
          null
      };
    })
    .filter(Boolean);
  return setCached(cacheKey, messages);
}

const INCOMING_WEBHOOK_FILTERS = {
  conditions: [
    { field: 'fromMe', operator: 'equals', value: false },
    { field: 'isGroup', operator: 'equals', value: false }
  ]
};

/**
 * @param {string} openwaSessionId
 * @param {{ url: string, events?: string[], secret?: string, filters?: object }} body
 */
async function createWebhook(openwaSessionId, body) {
  const payload = {
    url: body.url,
    events: body.events || ['message.received'],
    filters: body.filters !== undefined ? body.filters : INCOMING_WEBHOOK_FILTERS
  };
  if (body.secret) payload.secret = body.secret;
  return openwaRequest('POST', `/sessions/${openwaSessionId}/webhooks`, payload);
}

/**
 * @param {string} openwaSessionId
 */
async function listWebhooks(openwaSessionId) {
  const data = await openwaRequest('GET', `/sessions/${openwaSessionId}/webhooks`);
  return Array.isArray(data) ? data : data.data || data.webhooks || [];
}

/**
 * @param {string} openwaSessionId
 * @param {string} webhookId
 */
async function deleteWebhook(openwaSessionId, webhookId) {
  return openwaRequest('DELETE', `/sessions/${openwaSessionId}/webhooks/${webhookId}`);
}

/**
 * @param {string} openwaSessionId
 * @param {string} webhookId
 */
async function testWebhook(openwaSessionId, webhookId) {
  return openwaRequest('POST', `/sessions/${openwaSessionId}/webhooks/${webhookId}/test`);
}

module.exports = {
  assertOpenWAConfigured,
  formatPhoneToChatId,
  getSessionStatus,
  sendTextMessage,
  editMessage,
  deleteMessage,
  getContact,
  blockContact,
  unblockContact,
  listChats,
  getChatHistory,
  invalidateOpenWACache,
  isConnectedStatus,
  listOpenWASessions,
  normalizeOpenWASessionRow,
  extractProfileName,
  createWebhook,
  listWebhooks,
  deleteWebhook,
  testWebhook,
  INCOMING_WEBHOOK_FILTERS
};
