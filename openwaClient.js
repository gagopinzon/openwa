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
    const details =
      data.message ||
      data.error ||
      (Array.isArray(data.message) ? data.message.join('; ') : null) ||
      (data.errors ? JSON.stringify(data.errors) : null);
    let message = details || `OpenWA error ${response.status}`;
    if (typeof message === 'object') {
      message = JSON.stringify(message);
    }
    // Incluir body completo en 400 para depurar validaciones
    if (response.status === 400) {
      const raw = JSON.stringify(data).slice(0, 800);
      message = `${message} | body=${raw}`;
      console.warn(`[openwa] ${method} ${path} → 400 ${raw}`);
    }

    if (allowRetry && isRateLimitError(response.status, message)) {
      const retryAfterHeader = response.headers && response.headers['retry-after'];
      const retryAfterSec = parseInt(retryAfterHeader, 10);
      const attempt = Number(opts._rateLimitAttempt) || 0;
      const waitMs = Number.isFinite(retryAfterSec)
        ? Math.min(Math.max(retryAfterSec * 1000, 2000), 30000)
        : Math.min(4000 * (attempt + 1), 20000);
      console.warn(
        `[openwa] rate-limit ${method} ${path} — reintento ${attempt + 1} en ${waitMs}ms`
      );
      await sleep(waitMs);
      if (attempt < 2) {
        return openwaRequest(method, path, body, {
          ...opts,
          _rateLimitAttempt: attempt + 1
        });
      }
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
  const historyVPrefix = chatId
    ? `:${openwaSessionId}:${chatId}:`
    : `:${openwaSessionId}:`;
  for (const key of openwaCache.keys()) {
    if (key.startsWith(sessionPrefix)) {
      openwaCache.delete(key);
      continue;
    }
    // history / history:v2 / history:v3
    if (
      key.startsWith(historyPrefix) ||
      (key.startsWith('history:') && key.includes(historyVPrefix))
    ) {
      openwaCache.delete(key);
    }
  }
}

function isConnectedStatus(status) {
  const s = String(status || '').toLowerCase();
  return s === 'connected' || s === 'open' || s === 'ready';
}

/** Errores típicos cuando la sesión OpenWA/WhatsApp ya no está usable. */
function isDisconnectError(error) {
  const status = error && error.status;
  if (status === 409 || status === 502 || status === 503) return true;
  const msg = String((error && error.message) || error || '');
  return /not connected|disconnected|desconectad|session.*(closed|lost|not ready)|UNPAIRED|logged out|no está conectad|estado:.*(desconocido|close|conflict)|banned|bannead|restrict|blocked by whatsapp/i.test(
    msg
  );
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
 * Indicador de presencia en un chat (escribiendo / grabando / pausado).
 * WhatsApp suele apagar "typing" ~25s; hay que reenviarlo si se simula más tiempo.
 * @param {string} openwaSessionId
 * @param {string} chatId
 * @param {'typing'|'recording'|'paused'} state
 */
async function sendChatState(openwaSessionId, chatId, state) {
  const id = String(chatId || '').trim();
  const presence = String(state || '').trim();
  if (!id) throw new Error('chatId es obligatorio');
  if (!['typing', 'recording', 'paused'].includes(presence)) {
    throw new Error('state debe ser typing, recording o paused');
  }

  const data = await openwaRequest(
    'POST',
    `/sessions/${openwaSessionId}/chats/typing`,
    { chatId: id, state: presence }
  );
  return { success: true, raw: data };
}

/**
 * Marca un chat como leído (sendSeen) y limpia unreadCount en OpenWA.
 * @param {string} openwaSessionId
 * @param {string} chatId
 */
async function markChatRead(openwaSessionId, chatId) {
  const id = String(chatId || '').trim();
  if (!id) throw new Error('chatId es obligatorio');

  const data = await openwaRequest(
    'POST',
    `/sessions/${openwaSessionId}/chats/read`,
    { chatId: id }
  );
  invalidateOpenWACache({ openwaSessionId, chatId: id });
  return { success: data.success !== false, raw: data };
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
 * Borra un chat completo de la lista de WhatsApp (historial local del teléfono).
 * @param {string} openwaSessionId
 * @param {string} chatId - JID, ej. 521...@c.us
 */
async function deleteChat(openwaSessionId, chatId) {
  const id = String(chatId || '').trim();
  if (!id) throw new Error('chatId es obligatorio');
  if (!/^[^\s@]+@[^\s@]+$/.test(id)) {
    throw new Error('chatId inválido (se espera localpart@host)');
  }

  const data = await openwaRequest(
    'POST',
    `/sessions/${openwaSessionId}/chats/delete`,
    { chatId: id }
  );
  return {
    success: true,
    message: data.message || 'Chat eliminado',
    raw: data
  };
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
 * Mensajes de protocolo/cifrado que OpenWA no interpreta (p.ej. type "unknown").
 * @param {{ type?: string, body?: string, mediaType?: string }|null} msg
 */
function isUnknownPlaceholderMessage(msg) {
  if (!msg || typeof msg !== 'object') return false;
  const type = String(msg.type || msg.mediaType || '')
    .trim()
    .toLowerCase();
  if (type === 'unknown') return true;
  const body = String(msg.body || '')
    .trim()
    .toLowerCase();
  return body === '[unknown]';
}

function isViewableMediaType(type) {
  const t = String(type || '')
    .trim()
    .toLowerCase();
  return t === 'image' || t === 'sticker' || t === 'audio' || t === 'voice' || t === 'ptt';
}

function normalizeMediaPayload(msg) {
  if (!msg || typeof msg !== 'object') return null;
  const media = msg.media && typeof msg.media === 'object' ? msg.media : null;
  const mimetype =
    (media && media.mimetype) ||
    msg.mimetype ||
    msg.mimeType ||
    null;
  const data =
    (media && (media.data || media.base64)) ||
    msg.mediaData ||
    msg.base64 ||
    null;
  const omitted = Boolean(media && media.omitted);
  const filename = (media && media.filename) || msg.filename || null;
  if (!mimetype && !data && !omitted && !msg.hasMedia) return null;
  return {
    mimetype: mimetype ? String(mimetype) : null,
    filename: filename ? String(filename) : null,
    data: data ? String(data) : null,
    omitted,
    sizeBytes:
      media && media.sizeBytes != null
        ? Number(media.sizeBytes)
        : null
  };
}

/**
 * Historial de un chat (live desde WhatsApp).
 * @param {string} openwaSessionId
 * @param {string} chatId
 * @param {{ limit?: number, fresh?: boolean, includeMedia?: boolean }} [opts]
 */
async function getChatHistory(openwaSessionId, chatId, opts = {}) {
  const limit = Math.min(Math.max(parseInt(opts.limit, 10) || 50, 1), 100);
  const includeMedia = Boolean(opts.includeMedia);
  // No cachear historial con media (payload enorme / bytes sensibles en RAM).
  const cacheKey = `history:v4:n:${openwaSessionId}:${chatId}:${limit}`;
  if (!includeMedia && !opts.fresh) {
    const cached = getCached(cacheKey);
    if (cached) return cached;
  }

  const encoded = encodeURIComponent(String(chatId));
  const qs = new URLSearchParams({ limit: String(limit) });
  if (includeMedia) qs.set('includeMedia', 'true');
  const data = await openwaRequest(
    'GET',
    `/sessions/${openwaSessionId}/messages/${encoded}/history?${qs.toString()}`,
    undefined,
    { timeout: includeMedia ? 120000 : 30000 }
  );
  const raw = Array.isArray(data) ? data : data.messages || data.data || [];
  const messages = raw
    .map((msg) => {
      if (!msg || typeof msg !== 'object') return null;
      const body = String(msg.body || msg.text || msg.caption || '').trim();
      const type = String(msg.type || 'text');
      const media = normalizeMediaPayload(msg);
      return {
        id: msg.id || msg.waMessageId || null,
        chatId: msg.chatId || chatId,
        from: msg.from || null,
        to: msg.to || null,
        body: body || (type !== 'text' ? `[${type}]` : ''),
        type,
        fromMe: resolveMessageFromMe(msg),
        isGroup: Boolean(msg.isGroup),
        timestamp: msg.timestamp != null ? Number(msg.timestamp) : null,
        contactName:
          (msg.contact && (msg.contact.pushName || msg.contact.name)) ||
          msg.pushName ||
          msg.senderName ||
          null,
        hasMedia: Boolean(msg.hasMedia || (media && (media.data || media.mimetype))),
        media
      };
    })
    .filter(Boolean)
    .filter((msg) => !isUnknownPlaceholderMessage(msg));
  if (!includeMedia) {
    return setCached(cacheKey, messages);
  }
  return messages;
}

/**
 * Descarga bytes de media ya persistidos/archivados en OpenWA.
 * @returns {Promise<{ buffer: Buffer, mimetype: string }>}
 */
async function downloadMessageMedia(openwaSessionId, chatId, messageId) {
  assertOpenWAConfigured();
  const { baseUrl, apiKey } = getBaseConfig();
  const encodedChat = encodeURIComponent(String(chatId));
  const encodedMsg = encodeURIComponent(String(messageId));
  const response = await axios({
    method: 'GET',
    url: `${baseUrl}/sessions/${openwaSessionId}/messages/${encodedChat}/${encodedMsg}/media`,
    headers: { 'X-API-Key': apiKey },
    responseType: 'arraybuffer',
    timeout: 60000,
    validateStatus: () => true
  });

  if (response.status === 404) {
    throw createOpenWAError('No hay media almacenada para este mensaje', { status: 404 });
  }
  if (response.status < 200 || response.status >= 300) {
    let message = `OpenWA media error ${response.status}`;
    try {
      const text = Buffer.from(response.data || []).toString('utf8');
      const parsed = JSON.parse(text);
      message = parsed.message || parsed.error || message;
    } catch {
      /* ignore */
    }
    throw createOpenWAError(message, { status: response.status });
  }

  const contentType = String(
    (response.headers && (response.headers['content-type'] || response.headers['Content-Type'])) ||
      'application/octet-stream'
  )
    .split(';')[0]
    .trim();
  return {
    buffer: Buffer.from(response.data || []),
    mimetype: contentType || 'application/octet-stream'
  };
}

/**
 * Normaliza si un mensaje es propio (OpenWA/WhatsApp usan varios campos).
 * @returns {boolean|null}
 */
function resolveMessageFromMe(msg) {
  if (!msg || typeof msg !== 'object') return null;
  if (typeof msg.fromMe === 'boolean') return msg.fromMe;
  if (msg.fromMe === 1 || msg.fromMe === '1' || msg.fromMe === 'true') return true;
  if (msg.fromMe === 0 || msg.fromMe === '0' || msg.fromMe === 'false') return false;
  const dir = String(msg.direction || msg.messageDirection || msg.flow || '').toLowerCase();
  if (['outgoing', 'outbound', 'out', 'sent', 'fromme', 'from_me'].includes(dir)) {
    return true;
  }
  if (['incoming', 'inbound', 'in', 'received', 'tome', 'to_me'].includes(dir)) {
    return false;
  }
  if (msg.author === 'me' || msg.sender === 'me') return true;
  return null;
}

/**
 * Últimas N líneas de texto de un historial (cronológico) + dirección del último.
 * @param {Array} messages
 * @param {number} [maxLines=4]
 * @returns {{ previewLines: string[], lastFromMe: boolean|null }}
 */
function buildChatPreviewLines(messages, maxLines = 4) {
  const limit = Math.min(Math.max(parseInt(maxLines, 10) || 4, 1), 8);
  const list = (Array.isArray(messages) ? [...messages] : []).filter(
    (m) => !isUnknownPlaceholderMessage(m)
  );
  list.sort((a, b) => (Number(a.timestamp) || 0) - (Number(b.timestamp) || 0));
  const withBody = list.filter((m) => String((m && m.body) || '').trim());
  const lastMsg = withBody.length ? withBody[withBody.length - 1] : null;
  let lastFromMe = null;
  if (lastMsg) {
    if (typeof lastMsg.fromMe === 'boolean') lastFromMe = lastMsg.fromMe;
    else lastFromMe = resolveMessageFromMe(lastMsg);
  }
  const lines = [];
  for (let i = list.length - 1; i >= 0 && lines.length < limit; i--) {
    const body = String((list[i] && list[i].body) || '')
      .replace(/\s+/g, ' ')
      .trim();
    if (!body || body.toLowerCase() === '[unknown]') continue;
    lines.unshift(body.length > 140 ? `${body.slice(0, 140)}…` : body);
  }
  return {
    previewLines: lines,
    lastFromMe
  };
}

const INCOMING_WEBHOOK_FILTERS = {
  conditions: [
    // OpenWA valida operators: is | isNot | contains | equals
    // Para booleanos (fromMe/isGroup) su API exige `is`, no `equals` (equals → 400 Bad Request).
    { field: 'fromMe', operator: 'is', value: false },
    { field: 'isGroup', operator: 'is', value: false }
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

/**
 * Búsqueda global de mensajes en OpenWA (FTS).
 * @param {{ q: string, sessionId?: string, chatId?: string, limit?: number, offset?: number }} params
 * @returns {Promise<{ hits: Array, total: number, tookMs: number|null, provider: string|null, available: boolean }>}
 */
async function searchMessages(params = {}) {
  const q = String(params.q || '').trim();
  if (!q) {
    return { hits: [], total: 0, tookMs: 0, provider: null, available: true };
  }

  const qs = new URLSearchParams();
  qs.set('q', q);
  if (params.sessionId) qs.set('sessionId', String(params.sessionId));
  if (params.chatId) qs.set('chatId', String(params.chatId));
  const limit = Math.min(Math.max(parseInt(params.limit, 10) || 30, 1), 100);
  const offset = Math.max(parseInt(params.offset, 10) || 0, 0);
  qs.set('limit', String(limit));
  qs.set('offset', String(offset));

  try {
    const data = await openwaRequest('GET', `/search?${qs.toString()}`, undefined, {
      timeout: 45000
    });
    const hits = Array.isArray(data.hits)
      ? data.hits
      : Array.isArray(data.data)
        ? data.data
        : Array.isArray(data)
          ? data
          : [];
    return {
      hits,
      total: Number(data.total) || hits.length,
      tookMs: data.tookMs != null ? Number(data.tookMs) : null,
      provider: data.provider != null ? String(data.provider) : null,
      available: true
    };
  } catch (error) {
    if (error && (error.status === 501 || error.status === 404)) {
      return {
        hits: [],
        total: 0,
        tookMs: null,
        provider: null,
        available: false,
        error: error.message
      };
    }
    throw error;
  }
}

module.exports = {
  assertOpenWAConfigured,
  formatPhoneToChatId,
  getSessionStatus,
  isDisconnectError,
  sendTextMessage,
  sendChatState,
  markChatRead,
  editMessage,
  deleteMessage,
  deleteChat,
  getContact,
  blockContact,
  unblockContact,
  listChats,
  getChatHistory,
  downloadMessageMedia,
  isViewableMediaType,
  buildChatPreviewLines,
  searchMessages,
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
