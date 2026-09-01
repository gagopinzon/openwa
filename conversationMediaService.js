/**
 * Hidratación de media de un chat: una sola descarga includeMedia compartida
 * entre peticiones concurrentes del mismo chat.
 */

const { getChatHistory } = require('./openwaClient');
const mediaCacheStore = require('./mediaCacheStore');
const cvFileStore = require('./cvFileStore');

function normalizeMediaPayload(msg) {
  if (!msg || typeof msg !== 'object') return null;
  const media = msg.media && typeof msg.media === 'object' ? msg.media : null;
  const mimetype =
    (media && media.mimetype) || msg.mimetype || msg.mimeType || null;
  const data =
    (media && (media.data || media.base64)) || msg.mediaData || msg.base64 || null;
  if (!data) return null;
  return {
    mimetype: mimetype ? String(mimetype) : null,
    filename: (media && media.filename) || msg.filename || msg.fileName || null,
    data: String(data)
  };
}

function bufferFromMediaData(data) {
  const raw = String(data || '').trim();
  if (!raw) return null;
  const comma = raw.indexOf(',');
  const b64 =
    raw.startsWith('data:') && comma >= 0 ? raw.slice(comma + 1) : raw.replace(/^base64,/i, '');
  try {
    const buffer = Buffer.from(b64, 'base64');
    return buffer.length ? buffer : null;
  } catch {
    return null;
  }
}

/**
 * Intenta obtener el PDF del mensaje: webhook inline → download → hydrate + retry.
 */
async function resolveIncomingDocumentMedia(
  openwaSessionId,
  chatId,
  msg,
  downloadMessageMedia
) {
  const inline = normalizeMediaPayload(msg);
  if (inline && inline.data) {
    const buffer = bufferFromMediaData(inline.data);
    if (buffer && cvFileStore.isValidPdfBuffer(buffer)) {
      return {
        buffer,
        mimetype: inline.mimetype || 'application/pdf',
        filename: inline.filename
      };
    }
  }

  const messageId = msg.id || msg.messageId;
  if (!messageId) return null;

  let media = await resolveMessageMedia(
    openwaSessionId,
    chatId,
    messageId,
    downloadMessageMedia
  );
  if (media && media.buffer && cvFileStore.isValidPdfBuffer(media.buffer)) {
    return media;
  }

  await hydrateChatMedia(openwaSessionId, chatId, 80);
  await new Promise((r) => setTimeout(r, 1500));
  media = await resolveMessageMedia(
    openwaSessionId,
    chatId,
    messageId,
    downloadMessageMedia
  );
  if (media && media.buffer && cvFileStore.isValidPdfBuffer(media.buffer)) {
    return media;
  }

  return media && media.buffer ? { ...media, invalidPdf: true } : null;
}

/** @type {Map<string, Promise<{ count: number, messages: Array }>>} */
const inflight = new Map();

function chatKey(openwaSessionId, chatId) {
  return `${openwaSessionId}::${chatId}`;
}

function guessMimetypeFromType(type) {
  const t = String(type || '').toLowerCase();
  if (t === 'image' || t === 'sticker') return 'image/jpeg';
  if (t === 'audio' || t === 'voice' || t === 'ptt') return 'audio/ogg';
  return 'application/octet-stream';
}

/**
 * Descarga historial con includeMedia y llena mediaCacheStore.
 * @returns {Promise<{ count: number, messages: Array }>}
 */
async function hydrateChatMedia(openwaSessionId, chatId, limit = 80) {
  const key = chatKey(openwaSessionId, chatId);
  if (inflight.has(key)) return inflight.get(key);

  const job = (async () => {
    const history = await getChatHistory(openwaSessionId, chatId, {
      limit,
      includeMedia: true,
      fresh: true
    });
    let count = 0;
    for (const msg of history) {
      if (!msg || !msg.id || !msg.media || !msg.media.data) continue;
      const ok = mediaCacheStore.putFromBase64(
        openwaSessionId,
        chatId,
        msg.id,
        msg.media.mimetype || guessMimetypeFromType(msg.type),
        msg.media.data
      );
      if (ok) count += 1;
    }
    return { count, messages: history };
  })().finally(() => {
    inflight.delete(key);
  });

  inflight.set(key, job);
  return job;
}

/**
 * Resuelve bytes de un mensaje: caché → OpenWA /media → hydrate includeMedia.
 * @returns {Promise<{ buffer: Buffer, mimetype: string }|null>}
 */
async function resolveMessageMedia(openwaSessionId, chatId, messageId, downloadMessageMedia) {
  let hit = mediaCacheStore.get(openwaSessionId, chatId, messageId);
  if (hit) return hit;

  if (typeof downloadMessageMedia === 'function') {
    try {
      hit = await downloadMessageMedia(openwaSessionId, chatId, messageId);
      if (hit && hit.buffer) {
        mediaCacheStore.put(openwaSessionId, chatId, messageId, hit);
        return hit;
      }
    } catch (err) {
      if (!(err && err.status === 404)) throw err;
    }
  }

  await hydrateChatMedia(openwaSessionId, chatId, 80);
  return mediaCacheStore.get(openwaSessionId, chatId, messageId);
}

module.exports = {
  hydrateChatMedia,
  resolveMessageMedia,
  resolveIncomingDocumentMedia,
  guessMimetypeFromType
};
