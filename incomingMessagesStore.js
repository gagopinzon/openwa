const fs = require('fs');
const path = require('path');

const DATA_DIR = path.join(__dirname, 'data');
const STORE_FILE = path.join(DATA_DIR, 'incoming-messages.json');
const MAX_MESSAGES = 500;

/** @type {Array<object>|null} */
let cache = null;

function ensureDataDir() {
  if (!fs.existsSync(DATA_DIR)) {
    fs.mkdirSync(DATA_DIR, { recursive: true });
  }
}

function load() {
  if (cache) return cache;
  ensureDataDir();
  if (!fs.existsSync(STORE_FILE)) {
    cache = [];
    return cache;
  }
  try {
    const raw = fs.readFileSync(STORE_FILE, 'utf8');
    const parsed = JSON.parse(raw);
    cache = Array.isArray(parsed.messages) ? parsed.messages : [];
  } catch {
    cache = [];
  }
  return cache;
}

function persist() {
  ensureDataDir();
  const messages = load();
  fs.writeFileSync(
    STORE_FILE,
    JSON.stringify({ version: 1, updatedAt: new Date().toISOString(), messages }, null, 2),
    'utf8'
  );
}

/**
 * Normaliza ids de WhatsApp/OpenWA (string u objeto con `_serialized`).
 * @param {unknown} raw
 * @returns {string|null}
 */
function normalizeMessageId(raw) {
  if (raw == null || raw === '') return null;
  if (typeof raw === 'string' || typeof raw === 'number') {
    const s = String(raw).trim();
    return s || null;
  }
  if (typeof raw === 'object') {
    if (raw._serialized) return String(raw._serialized).trim() || null;
    if (raw.id != null && (typeof raw.id === 'string' || typeof raw.id === 'number')) {
      return String(raw.id).trim() || null;
    }
  }
  return null;
}

/**
 * Busca un mensaje ya guardado (misma entrega o mismo mensaje WA).
 * @param {object[]} messages
 * @param {object} entry
 * @returns {object|null}
 */
function findExisting(messages, entry) {
  const id = entry.id || null;
  if (id && messages.some((m) => m.id === id)) {
    return messages.find((m) => m.id === id) || null;
  }

  const messageId = normalizeMessageId(entry.messageId);
  const openwaSessionId = entry.openwaSessionId || null;
  if (messageId && openwaSessionId) {
    const byMsg = messages.find(
      (m) =>
        m.openwaSessionId === openwaSessionId && normalizeMessageId(m.messageId) === messageId
    );
    if (byMsg) return byMsg;
  }

  // Fallback cuando OpenWA no manda id estable: misma línea + chat + cuerpo + timestamp.
  const chatId = entry.chatId || null;
  const body = entry.body || '';
  const timestamp = entry.timestamp || null;
  if (openwaSessionId && chatId && body && timestamp) {
    const byFp = messages.find(
      (m) =>
        m.openwaSessionId === openwaSessionId &&
        m.chatId === chatId &&
        m.body === body &&
        m.timestamp === timestamp
    );
    if (byFp) return byFp;
  }

  return null;
}

/**
 * @param {object} entry
 * @returns {object}
 */
function add(entry) {
  const messages = load();
  const existing = findExisting(messages, entry);
  if (existing) return existing;

  const messageId = normalizeMessageId(entry.messageId);
  const id =
    entry.id ||
    `${entry.openwaSessionId || 's'}_${messageId || entry.telefono || 'x'}_${Date.now()}`;

  const record = {
    id,
    timestamp: entry.timestamp || new Date().toISOString(),
    sessionId: entry.sessionId || null,
    openwaSessionId: entry.openwaSessionId || null,
    telefono: entry.telefono || '',
    contactName: entry.contactName || null,
    body: entry.body || '',
    messageId,
    chatId: entry.chatId || null,
    fromMe: Boolean(entry.fromMe),
    isGroup: Boolean(entry.isGroup),
    mediaType: entry.mediaType || null,
    autoReplyHandled: Boolean(entry.autoReplyHandled),
    autoReplyReason: entry.autoReplyReason || null
  };

  messages.unshift(record);
  if (messages.length > MAX_MESSAGES) {
    messages.length = MAX_MESSAGES;
  }
  persist();
  return record;
}

function reloadFromDisk() {
  cache = null;
  return load();
}

/**
 * @param {{ limit?: number, sessionId?: string }} [opts]
 */
function list(opts = {}) {
  compactDuplicates();
  let messages = load();
  if (opts.sessionId) {
    const sid = String(opts.sessionId);
    messages = messages.filter(
      (m) => m.sessionId === sid || m.openwaSessionId === sid
    );
  }
  const limit = Math.min(Math.max(parseInt(opts.limit, 10) || 100, 1), MAX_MESSAGES);
  return messages.slice(0, limit);
}

/**
 * Elimina filas históricas duplicadas (mismo messageId+sesión o misma huella).
 * @returns {{ removed: number }}
 */
function compactDuplicates() {
  const messages = load();
  if (!messages.length) return { removed: 0 };

  const kept = [];
  let removed = 0;
  for (const m of messages) {
    const hit = findExisting(kept, m);
    if (hit) {
      removed += 1;
      continue;
    }
    kept.push(m);
  }
  if (removed > 0) {
    cache = kept;
    persist();
  }
  return { removed };
}

function clear() {
  cache = [];
  persist();
  return { cleared: true };
}

/**
 * Quita mensajes del inbox local ligados a un chat o teléfono.
 * @param {{ chatId?: string, telefono?: string }} opts
 * @returns {{ removed: number }}
 */
function removeByChatOrPhone(opts = {}) {
  const chatId = String(opts.chatId || '').trim();
  const telefono = String(opts.telefono || '').replace(/\D/g, '');
  if (!chatId && !telefono) return { removed: 0 };

  const messages = load();
  const before = messages.length;
  const kept = messages.filter((m) => {
    if (chatId && String(m.chatId || '') === chatId) return false;
    if (telefono) {
      const phone = String(m.telefono || '').replace(/\D/g, '');
      if (phone && phone === telefono) return false;
    }
    return true;
  });
  if (kept.length === before) return { removed: 0 };
  cache = kept;
  persist();
  return { removed: before - kept.length };
}

/**
 * @param {string} id
 * @param {object} patch
 */
function update(id, patch) {
  const messages = load();
  const idx = messages.findIndex((m) => m.id === id);
  if (idx < 0) return null;
  messages[idx] = { ...messages[idx], ...patch };
  persist();
  return messages[idx];
}

module.exports = {
  add,
  list,
  clear,
  removeByChatOrPhone,
  update,
  reloadFromDisk,
  normalizeMessageId,
  compactDuplicates,
  MAX_MESSAGES
};
