/**
 * Caché en memoria de media desencriptada (imagen/audio) por mensaje.
 * Evita re-descargar en cada poll y permite servir vía /media sin base64 en el JSON.
 */

const DEFAULT_TTL_MS = 45 * 60 * 1000;
const MAX_ENTRIES = 400;

/** @type {Map<string, { buffer: Buffer, mimetype: string, expiresAt: number }>} */
const cache = new Map();

function mediaKey(openwaSessionId, chatId, messageId) {
  return `${String(openwaSessionId || '')}::${String(chatId || '')}::${String(messageId || '')}`;
}

function pruneExpired() {
  const now = Date.now();
  for (const [key, row] of cache.entries()) {
    if (!row || row.expiresAt <= now) cache.delete(key);
  }
  while (cache.size > MAX_ENTRIES) {
    const oldest = cache.keys().next().value;
    if (oldest == null) break;
    cache.delete(oldest);
  }
}

/**
 * @param {string} openwaSessionId
 * @param {string} chatId
 * @param {string} messageId
 * @param {{ buffer: Buffer, mimetype?: string, ttlMs?: number }} data
 */
function put(openwaSessionId, chatId, messageId, data) {
  if (!openwaSessionId || !chatId || !messageId || !data || !data.buffer) return false;
  const buffer = Buffer.isBuffer(data.buffer) ? data.buffer : Buffer.from(data.buffer);
  if (!buffer.length) return false;
  pruneExpired();
  cache.set(mediaKey(openwaSessionId, chatId, messageId), {
    buffer,
    mimetype: String(data.mimetype || 'application/octet-stream'),
    expiresAt: Date.now() + (Number(data.ttlMs) > 0 ? Number(data.ttlMs) : DEFAULT_TTL_MS)
  });
  return true;
}

/**
 * @param {string} openwaSessionId
 * @param {string} chatId
 * @param {string} messageId
 * @param {string} mimetype
 * @param {string} base64OrDataUri
 */
function putFromBase64(openwaSessionId, chatId, messageId, mimetype, base64OrDataUri) {
  const raw = String(base64OrDataUri || '').trim();
  if (!raw) return false;
  const comma = raw.indexOf(',');
  const b64 =
    raw.startsWith('data:') && comma >= 0 ? raw.slice(comma + 1) : raw.replace(/^base64,/i, '');
  try {
    const buffer = Buffer.from(b64, 'base64');
    return put(openwaSessionId, chatId, messageId, {
      buffer,
      mimetype: mimetype || 'application/octet-stream'
    });
  } catch {
    return false;
  }
}

/**
 * @returns {{ buffer: Buffer, mimetype: string }|null}
 */
function get(openwaSessionId, chatId, messageId) {
  const key = mediaKey(openwaSessionId, chatId, messageId);
  const row = cache.get(key);
  if (!row) return null;
  if (row.expiresAt <= Date.now()) {
    cache.delete(key);
    return null;
  }
  // Refresh TTL on hit
  row.expiresAt = Date.now() + DEFAULT_TTL_MS;
  return { buffer: row.buffer, mimetype: row.mimetype };
}

function has(openwaSessionId, chatId, messageId) {
  return Boolean(get(openwaSessionId, chatId, messageId));
}

module.exports = {
  put,
  putFromBase64,
  get,
  has,
  mediaKey
};
