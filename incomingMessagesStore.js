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
 * @param {object} entry
 * @returns {object}
 */
function add(entry) {
  const messages = load();
  const id =
    entry.id ||
    `${entry.openwaSessionId || 's'}_${entry.messageId || entry.telefono || 'x'}_${Date.now()}`;

  if (messages.some((m) => m.id === id)) {
    return messages.find((m) => m.id === id);
  }

  const record = {
    id,
    timestamp: entry.timestamp || new Date().toISOString(),
    sessionId: entry.sessionId || null,
    openwaSessionId: entry.openwaSessionId || null,
    telefono: entry.telefono || '',
    contactName: entry.contactName || null,
    body: entry.body || '',
    messageId: entry.messageId || null,
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

/**
 * @param {{ limit?: number, sessionId?: string }} [opts]
 */
function list(opts = {}) {
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
  MAX_MESSAGES
};
