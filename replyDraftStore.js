/**
 * Borradores de auto-respuesta pendientes de envío (en memoria).
 * Clave: openwaSessionId:chatId
 */

/** @typedef {{
 *   id: string,
 *   key: string,
 *   openwaSessionId: string,
 *   logicalSessionId: string|null,
 *   chatId: string,
 *   telefono: string|null,
 *   contactName: string|null,
 *   replyText: string|null,
 *   status: 'generating'|'scheduled'|'paused'|'sending',
 *   sendAt: number|null,
 *   createdAt: string,
 *   updatedAt: string,
 *   edited: boolean,
 *   incomingPreview: string,
 *   genId: number,
 *   items: object[]
 * }} ReplyDraft */

/** @type {Map<string, ReplyDraft>} */
const drafts = new Map();

function draftKey(openwaSessionId, chatId) {
  return `${String(openwaSessionId || '').trim()}:${String(chatId || '').trim()}`;
}

function makeId() {
  return `draft-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

/**
 * Vista pública para API / SSE (sin items internos).
 * @param {ReplyDraft|null|undefined} d
 */
function toPublic(d) {
  if (!d) return null;
  return {
    id: d.id,
    key: d.key,
    openwaSessionId: d.openwaSessionId,
    sessionId: d.logicalSessionId,
    chatId: d.chatId,
    telefono: d.telefono,
    contactName: d.contactName,
    replyText: d.replyText,
    status: d.status,
    sendAt: d.sendAt,
    createdAt: d.createdAt,
    updatedAt: d.updatedAt,
    edited: Boolean(d.edited),
    incomingPreview: d.incomingPreview || ''
  };
}

/**
 * @param {string} openwaSessionId
 * @param {string} chatId
 */
function get(openwaSessionId, chatId) {
  return drafts.get(draftKey(openwaSessionId, chatId)) || null;
}

/**
 * @param {string} logicalSessionId
 * @param {string} chatId
 */
function getByLogicalSession(logicalSessionId, chatId) {
  const sid = String(logicalSessionId || '').trim();
  const cid = String(chatId || '').trim();
  if (!sid || !cid) return null;
  for (const d of drafts.values()) {
    if (String(d.logicalSessionId || '') === sid && String(d.chatId || '') === cid) {
      return d;
    }
  }
  return null;
}

/**
 * @param {Partial<ReplyDraft> & { openwaSessionId: string, chatId: string }} input
 */
function upsert(input) {
  const key = draftKey(input.openwaSessionId, input.chatId);
  const now = new Date().toISOString();
  const prev = drafts.get(key);
  const next = {
    id: (prev && prev.id) || input.id || makeId(),
    key,
    openwaSessionId: String(input.openwaSessionId || '').trim(),
    logicalSessionId:
      input.logicalSessionId != null
        ? String(input.logicalSessionId || '').trim() || null
        : (prev && prev.logicalSessionId) || null,
    chatId: String(input.chatId || '').trim(),
    telefono:
      input.telefono !== undefined
        ? input.telefono
        : (prev && prev.telefono) || null,
    contactName:
      input.contactName !== undefined
        ? input.contactName
        : (prev && prev.contactName) || null,
    replyText:
      input.replyText !== undefined
        ? input.replyText
        : (prev && prev.replyText) || null,
    status: input.status || (prev && prev.status) || 'generating',
    sendAt: input.sendAt !== undefined ? input.sendAt : (prev && prev.sendAt) || null,
    createdAt: (prev && prev.createdAt) || now,
    updatedAt: now,
    edited: input.edited !== undefined ? Boolean(input.edited) : Boolean(prev && prev.edited),
    incomingPreview:
      input.incomingPreview !== undefined
        ? String(input.incomingPreview || '')
        : (prev && prev.incomingPreview) || '',
    genId:
      input.genId !== undefined
        ? Number(input.genId) || 0
        : (prev && prev.genId) || 0,
    items: Array.isArray(input.items)
      ? input.items
      : (prev && Array.isArray(prev.items) ? prev.items : [])
  };
  drafts.set(key, next);
  return next;
}

/**
 * @param {string} openwaSessionId
 * @param {string} chatId
 */
function remove(openwaSessionId, chatId) {
  const key = draftKey(openwaSessionId, chatId);
  const prev = drafts.get(key) || null;
  drafts.delete(key);
  return prev;
}

/**
 * @param {string} key
 */
function removeByKey(key) {
  const k = String(key || '').trim();
  const prev = drafts.get(k) || null;
  drafts.delete(k);
  return prev;
}

function listAll() {
  return [...drafts.values()].map(toPublic);
}

function resetForTests() {
  drafts.clear();
}

module.exports = {
  draftKey,
  toPublic,
  get,
  getByLogicalSession,
  upsert,
  remove,
  removeByKey,
  listAll,
  resetForTests
};
