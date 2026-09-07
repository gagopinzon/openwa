/**
 * Genera el borrador al llegar el mensaje, muestra gracia, envía al vencer.
 * Si llega otro mensaje: regenera y reinicia el timer.
 */

const replyDraftStore = require('./replyDraftStore');
const messageBatcher = require('./messageBatcher');

/** @type {Map<string, NodeJS.Timeout>} */
const sendTimers = new Map();

/** @type {((event: string, data: object) => void)|null} */
let broadcastFn = null;

/** @type {(items: object[], opts?: object) => Promise<object>}|null */
let processFn = null;

function setHandlers({ broadcastEvent, processBatched }) {
  if (typeof broadcastEvent === 'function') broadcastFn = broadcastEvent;
  if (typeof processBatched === 'function') processFn = processBatched;
}

function emit(event, data, draftOrItem) {
  const fromItem =
    draftOrItem &&
    Array.isArray(draftOrItem.items) &&
    draftOrItem.items[0] &&
    typeof draftOrItem.items[0].broadcastEvent === 'function'
      ? draftOrItem.items[0].broadcastEvent
      : null;
  const fromDirect =
    draftOrItem && typeof draftOrItem.broadcastEvent === 'function'
      ? draftOrItem.broadcastEvent
      : null;
  const fn = fromItem || fromDirect || broadcastFn;
  if (typeof fn === 'function') {
    try {
      fn(event, data);
    } catch (err) {
      console.warn('[reply-draft] broadcast:', err.message);
    }
  }
}

function parseKey(key) {
  const s = String(key || '');
  const idx = s.indexOf(':');
  if (idx < 0) return { openwaSessionId: s, chatId: '' };
  return { openwaSessionId: s.slice(0, idx), chatId: s.slice(idx + 1) };
}

function clearSendTimer(key) {
  const t = sendTimers.get(key);
  if (t) clearTimeout(t);
  sendTimers.delete(key);
}

function scheduleSend(key, delayMs) {
  clearSendTimer(key);
  const wait = Math.max(0, Number(delayMs) || 0);
  if (wait === 0) {
    void flushSend(key);
    return;
  }
  const timer = setTimeout(() => {
    sendTimers.delete(key);
    void flushSend(key);
  }, wait);
  sendTimers.set(key, timer);
}

function delayForCount(count) {
  if (messageBatcher.skipBatchDelays()) return 0;
  return count <= 1
    ? messageBatcher.getFirstDelayMs()
    : messageBatcher.getNextDelayMs();
}

/**
 * @param {object} item batch item (mismo shape que messageBatcher)
 * @param {{ immediate?: boolean, skipDelay?: boolean }} [opts]
 */
async function enqueueInbound(item, opts = {}) {
  if (!item || !item.openwaSessionId || !item.chatId) {
    return { handled: false, reason: 'invalid_item' };
  }
  if (typeof processFn !== 'function') {
    return { handled: false, reason: 'draft_service_unconfigured' };
  }

  const key = replyDraftStore.draftKey(item.openwaSessionId, item.chatId);
  const prev = replyDraftStore.get(item.openwaSessionId, item.chatId);
  const items = prev && Array.isArray(prev.items) ? [...prev.items, item] : [item];
  const combinedBody = messageBatcher.combineBatchBodies(items);
  const immediate = Boolean(opts.immediate) || Boolean(item.incomingDocument);
  const skipDelay =
    Boolean(opts.skipDelay) ||
    Boolean(item.testMode) ||
    messageBatcher.skipBatchDelays();

  const delayMs = immediate || skipDelay ? 0 : delayForCount(items.length);
  const sendAt = Date.now() + delayMs;
  const genId = ((prev && prev.genId) || 0) + 1;

  const draft = replyDraftStore.upsert({
    openwaSessionId: item.openwaSessionId,
    logicalSessionId: item.logicalSessionId || null,
    chatId: item.chatId,
    telefono: item.normalizedPhone || null,
    contactName: item.contactName || null,
    replyText: null,
    status: delayMs === 0 ? 'sending' : 'generating',
    sendAt: delayMs === 0 ? Date.now() : sendAt,
    edited: false,
    incomingPreview: combinedBody.slice(0, 240),
    genId,
    items
  });

  emit('replyDraftUpdated', replyDraftStore.toPublic(draft), draft);

  if (delayMs === 0) {
    // Documento / sin gracia: generar y enviar en el procesador completo
    clearSendTimer(key);
    const result = await processFn(items, {});
    replyDraftStore.removeByKey(key);
    emit(
      'replyDraftCleared',
      {
        key,
        sessionId: item.logicalSessionId || null,
        openwaSessionId: item.openwaSessionId,
        chatId: item.chatId,
        reason: 'sent_immediate'
      },
      item
    );
    return result || { handled: false, reason: 'batch_empty' };
  }

  scheduleSend(key, delayMs);
  void regenerate(key, genId);

  return {
    handled: false,
    reason: 'draft_pending',
    batchCount: items.length,
    delayMs,
    sendAt,
    telefono: item.normalizedPhone,
    openwaSessionId: item.openwaSessionId,
    sessionId: item.logicalSessionId
  };
}

/**
 * @param {string} key
 * @param {number} genId
 */
async function regenerate(key, genId) {
  const { openwaSessionId, chatId } = parseKey(key);
  let current = replyDraftStore.get(openwaSessionId, chatId);
  if (!current || current.genId !== genId) return;
  if (typeof processFn !== 'function') return;

  replyDraftStore.upsert({
    openwaSessionId,
    chatId,
    status: 'generating',
    items: current.items
  });
  emit('replyDraftUpdated', replyDraftStore.toPublic(replyDraftStore.get(openwaSessionId, chatId)), current);

  try {
    const result = await processFn(current.items, { draftOnly: true, genId });
    current = replyDraftStore.get(openwaSessionId, chatId);
    if (!current || current.genId !== genId) return;

    if (result && result.reason === 'chat_busy') {
      setTimeout(() => {
        const d = replyDraftStore.get(openwaSessionId, chatId);
        if (d && d.genId === genId) void regenerate(key, genId);
      }, 1000);
      return;
    }

    if (result && result.replyMessage) {
      const next = replyDraftStore.upsert({
        openwaSessionId,
        chatId,
        replyText: String(result.replyMessage),
        status: current.status === 'paused' ? 'paused' : 'scheduled',
        items: current.items
      });
      emit('replyDraftUpdated', replyDraftStore.toPublic(next), next);
    } else {
      const reason = (result && result.reason) || 'empty_reply';
      console.warn(`[reply-draft] generación sin texto key=${key} reason=${reason}`);
      if (reason === 'cancelled_by_pause' || reason === 'ai_paused_for_contact') {
        clearSendTimer(key);
        replyDraftStore.remove(openwaSessionId, chatId);
        emit(
          'replyDraftCleared',
          {
            key,
            sessionId: current.logicalSessionId,
            openwaSessionId,
            chatId,
            reason
          },
          current
        );
      }
    }
  } catch (err) {
    console.error('[reply-draft] regenerate error:', err.message || err);
    current = replyDraftStore.get(openwaSessionId, chatId);
    if (current && current.genId === genId) {
      const next = replyDraftStore.upsert({
        openwaSessionId,
        chatId,
        status: current.status === 'paused' ? 'paused' : 'scheduled',
        items: current.items
      });
      emit('replyDraftUpdated', replyDraftStore.toPublic(next), next);
    }
  }
}

/**
 * @param {string} key
 */
async function flushSend(key) {
  const { openwaSessionId, chatId } = parseKey(key);
  let draft = replyDraftStore.get(openwaSessionId, chatId);
  if (!draft) return;
  if (draft.status === 'paused') return;
  if (typeof processFn !== 'function') return;

  // Si aún genera, reintenta pronto
  if (draft.status === 'generating' || !draft.replyText) {
    scheduleSend(key, 800);
    return;
  }

  const items = draft.items || [];
  const preparedReply = draft.replyText;
  const sending = replyDraftStore.upsert({
    openwaSessionId,
    chatId,
    status: 'sending',
    items
  });
  emit('replyDraftUpdated', replyDraftStore.toPublic(sending), sending);

  try {
    const result = await processFn(items, { preparedReply });
    if (result && result.reason === 'chat_busy') {
      replyDraftStore.upsert({
        openwaSessionId,
        chatId,
        status: 'scheduled',
        replyText: preparedReply,
        sendAt: Date.now() + 1000,
        items
      });
      scheduleSend(key, 1000);
      emit(
        'replyDraftUpdated',
        replyDraftStore.toPublic(replyDraftStore.get(openwaSessionId, chatId)),
        draft
      );
      return;
    }
  } catch (err) {
    console.error('[reply-draft] flushSend error:', err.message || err);
  }

  replyDraftStore.remove(openwaSessionId, chatId);
  clearSendTimer(key);
  emit(
    'replyDraftCleared',
    {
      key,
      sessionId: draft.logicalSessionId,
      openwaSessionId,
      chatId,
      reason: 'sent'
    },
    draft
  );
}

/**
 * @param {string} openwaSessionId
 * @param {string} chatId
 */
function pauseSend(openwaSessionId, chatId) {
  const key = replyDraftStore.draftKey(openwaSessionId, chatId);
  const draft = replyDraftStore.get(openwaSessionId, chatId);
  if (!draft) return null;
  clearSendTimer(key);
  const next = replyDraftStore.upsert({
    openwaSessionId,
    chatId,
    status: 'paused',
    sendAt: null,
    items: draft.items
  });
  emit('replyDraftUpdated', replyDraftStore.toPublic(next), next);
  return replyDraftStore.toPublic(next);
}

/**
 * @param {string} openwaSessionId
 * @param {string} chatId
 * @param {number} [resumeDelayMs]
 */
function resumeSend(openwaSessionId, chatId, resumeDelayMs) {
  const draft = replyDraftStore.get(openwaSessionId, chatId);
  if (!draft) return null;
  const key = replyDraftStore.draftKey(openwaSessionId, chatId);
  const delay =
    resumeDelayMs != null && Number.isFinite(Number(resumeDelayMs))
      ? Math.max(0, Number(resumeDelayMs))
      : messageBatcher.getNextDelayMs();
  const sendAt = Date.now() + delay;
  const next = replyDraftStore.upsert({
    openwaSessionId,
    chatId,
    status: draft.replyText ? 'scheduled' : 'generating',
    sendAt,
    items: draft.items
  });
  scheduleSend(key, delay);
  emit('replyDraftUpdated', replyDraftStore.toPublic(next), next);
  if (!draft.replyText) {
    void regenerate(key, next.genId);
  }
  return replyDraftStore.toPublic(next);
}

/**
 * @param {string} openwaSessionId
 * @param {string} chatId
 * @param {string} text
 */
function updateText(openwaSessionId, chatId, text) {
  const draft = replyDraftStore.get(openwaSessionId, chatId);
  if (!draft) return null;
  const next = replyDraftStore.upsert({
    openwaSessionId,
    chatId,
    replyText: String(text || ''),
    edited: true,
    status: draft.status === 'generating' ? 'scheduled' : draft.status,
    items: draft.items
  });
  emit('replyDraftUpdated', replyDraftStore.toPublic(next), next);
  return replyDraftStore.toPublic(next);
}

/**
 * @param {string} openwaSessionId
 * @param {string} chatId
 */
async function sendNow(openwaSessionId, chatId) {
  const key = replyDraftStore.draftKey(openwaSessionId, chatId);
  const draft = replyDraftStore.get(openwaSessionId, chatId);
  if (!draft) {
    const err = new Error('No hay borrador pendiente');
    err.status = 404;
    throw err;
  }
  clearSendTimer(key);
  if (!draft.replyText) {
    // Espera generación o genera ya
    await regenerate(key, draft.genId);
  }
  await flushSend(key);
  return { ok: true };
}

/**
 * Cancela borrador (p. ej. Pausar IA o reply manual).
 */
function cancel(openwaSessionId, chatId, reason = 'cancelled') {
  const key = replyDraftStore.draftKey(openwaSessionId, chatId);
  clearSendTimer(key);
  const prev = replyDraftStore.remove(openwaSessionId, chatId);
  if (prev) {
    emit(
      'replyDraftCleared',
      {
        key,
        sessionId: prev.logicalSessionId,
        openwaSessionId,
        chatId,
        reason
      },
      prev
    );
  }
  return Boolean(prev);
}

/**
 * Cancela por predicado de claves relacionadas (mismo patrón que cancelPending).
 * @param {(d: object) => boolean} predicate
 */
function cancelMatching(predicate) {
  if (typeof predicate !== 'function') return 0;
  let n = 0;
  for (const d of [...replyDraftStore.listAll()]) {
    const full = replyDraftStore.get(d.openwaSessionId, d.chatId);
    if (!full) continue;
    let hit = false;
    try {
      hit = Boolean(predicate(full));
    } catch {
      hit = false;
    }
    if (!hit) continue;
    cancel(full.openwaSessionId, full.chatId, 'cancelled_match');
    n += 1;
  }
  return n;
}

function getPublic(openwaSessionId, chatId) {
  return replyDraftStore.toPublic(replyDraftStore.get(openwaSessionId, chatId));
}

function getPublicByLogical(logicalSessionId, chatId) {
  return replyDraftStore.toPublic(
    replyDraftStore.getByLogicalSession(logicalSessionId, chatId)
  );
}

function resetForTests() {
  for (const key of [...sendTimers.keys()]) clearSendTimer(key);
  replyDraftStore.resetForTests();
}

module.exports = {
  setHandlers,
  enqueueInbound,
  pauseSend,
  resumeSend,
  updateText,
  sendNow,
  cancel,
  cancelMatching,
  getPublic,
  getPublicByLogical,
  flushSend,
  resetForTests
};
