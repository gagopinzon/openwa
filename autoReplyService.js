const crypto = require('crypto');
const contactHistory = require('./contactHistoryStore');
const autoReplyStore = require('./autoReplyStore');
const sessionsStore = require('./sessionsStore');
const incomingMessagesStore = require('./incomingMessagesStore');
const { generateReplyMessage, splitSpeechParts, getReplyProvider, formatConversationHistoryForPrompt } = require('./aiService');
const ollamaService = require('./ollamaService');
const agendaAvailability = require('./agendaAvailability');
const agendaIntent = require('./agendaIntent');
const agendaPreferredTime = require('./agendaPreferredTime');
const agendaOfferStore = require('./agendaOfferStore');
const agendaPendingStore = require('./agendaPendingStore');
const agendaAwaitingCvStore = require('./agendaAwaitingCvStore');
const agendaCvConfirm = require('./agendaCvConfirm');
const agendaConfirmService = require('./agendaConfirmService');
const agendaRescheduleService = require('./agendaRescheduleService');
const agendaMeetDeliveryService = require('./agendaMeetDeliveryService');
const agendaWaitlistService = require('./agendaWaitlistService');
const agendaWaitlistStore = require('./agendaWaitlistStore');
const agendaLeadFields = require('./agendaLeadFields');
const cvIngestService = require('./cvIngestService');
const cvFileStore = require('./cvFileStore');
const { resolveUsableCvId, lookupCvIdFromArchive } = require('./cvLookup');
const { resolveMessageMedia, resolveIncomingDocumentMedia } = require('./conversationMediaService');
const {
  sendTextMessage,
  sendDocumentMessage,
  sendChatState,
  markChatRead,
  createWebhook,
  deleteWebhook,
  listWebhooks,
  getSessionStatus,
  isConnectedStatus,
  getContact,
  getContactPhone,
  extractPhoneFromOpenWaContact,
  getChatHistory,
  downloadMessageMedia
} = require('./openwaClient');
const { buildConfirmedMeetingReply } = require('./agendaMeetMessages');
const { isInboxPollEnabled, getInboxPollStatus } = require('./openwaInboxPoller');
const messageBatcher = require('./messageBatcher');
const replyDraftService = require('./replyDraftService');
const { logAgenda, warnAgenda } = require('./agendaDebug');
const {
  resolveAiContactName,
  preferredFirstName,
  phraseWithName
} = require('./preferredContactName');

const IDEMPOTENCY_TTL_MS = 24 * 60 * 60 * 1000;
const processedKeys = new Map();
const chatLocks = new Map();
/** Tokens de cancelación de envío en curso por chat (`openwaSessionId:chatId`). */
const sendCancelTokens = new Map();
/** Claves canceladas antes de que existiera token (carrera flush vs pausa). */
const cancelledLockKeys = new Set();
/** WhatsApp apaga el indicador ~25s; refrescar antes. */
const TYPING_REFRESH_MS = 20000;

function chatLockKey(openwaSessionId, chatId) {
  return `${String(openwaSessionId || '').trim()}:${String(chatId || '').trim()}`;
}

function isSendCancelled(lockKey) {
  const token = sendCancelTokens.get(lockKey);
  return Boolean(token && token.cancelled);
}

/**
 * Cancela lote pendiente y marca cancelación de un envío en curso para el chat.
 * También cancela claves relacionadas (@lid vs @c.us) y lotes del mismo teléfono.
 * @param {string} openwaSessionId
 * @param {string} chatId
 * @param {{ normalizedPhone?: string, whatsappLid?: string, relatedChatIds?: string[] }} [extra]
 * @returns {{ cancelledBatchItems: number, sendCancelled: boolean }}
 */
function cancelPendingForChat(openwaSessionId, chatId, extra = {}) {
  const sid = String(openwaSessionId || '').trim();
  const cid = String(chatId || '').trim();
  const related = new Set();
  const addId = (id) => {
    const s = String(id || '').trim();
    if (s) related.add(s);
  };
  addId(cid);

  const phone = String(extra.normalizedPhone || '').trim();
  const lid = String(extra.whatsappLid || '').replace(/\D/g, '');
  const digits = extractPhoneFromChatId(cid);

  if (digits) {
    addId(`${digits}@c.us`);
    addId(`${digits}@lid`);
    addId(`${digits}@s.whatsapp.net`);
  }
  if (phone && !phone.startsWith('lid_')) {
    addId(`${phone}@c.us`);
    addId(`${phone}@s.whatsapp.net`);
    const last10 = phone.slice(-10);
    if (last10.length === 10) {
      addId(`${last10}@c.us`);
      addId(`52${last10}@c.us`);
      addId(`521${last10}@c.us`);
    }
  }
  if (phone.startsWith('lid_')) {
    addId(`${phone.slice(4)}@lid`);
  }
  if (lid) addId(`${lid}@lid`);
  if (Array.isArray(extra.relatedChatIds)) {
    extra.relatedChatIds.forEach(addId);
  }

  let cancelledBatchItems = 0;
  let sendCancelled = false;

  const markToken = (lockKey) => {
    cancelledLockKeys.add(lockKey);
    const token = sendCancelTokens.get(lockKey);
    if (token) {
      token.cancelled = true;
      sendCancelled = true;
    }
  };

  for (const relatedId of related) {
    const lockKey = chatLockKey(sid, relatedId);
    cancelledBatchItems += messageBatcher.cancelKey(lockKey);
    replyDraftService.cancel(sid, relatedId, 'cancelled_by_pause');
    markToken(lockKey);
  }

  if (phone || lid) {
    const matched = messageBatcher.cancelMatching((item, key) => {
      if (!String(key).startsWith(`${sid}:`)) return false;
      if (phone && item && contactHistory.phonesMatch(item.normalizedPhone, phone)) {
        return true;
      }
      const itemLid = String(
        (item && item.identity && item.identity.whatsappLid) || ''
      ).replace(/\D/g, '');
      if (lid && itemLid && itemLid === lid) return true;
      return false;
    });
    cancelledBatchItems += matched.count;
    for (const key of matched.keys) {
      markToken(key);
    }
    replyDraftService.cancelMatching((d) => {
      if (String(d.openwaSessionId || '') !== sid) return false;
      if (phone && contactHistory.phonesMatch(d.telefono, phone)) return true;
      return related.has(String(d.chatId || ''));
    });
  }

  for (const lockKey of sendCancelTokens.keys()) {
    if (!lockKey.startsWith(`${sid}:`)) continue;
    const tokenChatId = lockKey.slice(sid.length + 1);
    if (related.has(tokenChatId)) markToken(lockKey);
  }

  if (cancelledBatchItems || sendCancelled) {
    console.log(
      `[auto-reply] cancel chat=${sid}:${cid} batchItems=${cancelledBatchItems} sendInFlight=${sendCancelled}`
    );
  }
  return { cancelledBatchItems, sendCancelled };
}

/**
 * Identidad del chat del panel (teléfono real o lid_*), misma lógica que el auto-reply.
 * @param {string} openwaSessionId
 * @param {string} chatId
 * @returns {Promise<{ normalizedPhone: string, whatsappLid: string|null, chatId: string }|null>}
 */
/**
 * Prefiere teléfono real (no lid_*) entre candidatos de historial.
 * @param {...(string|null|undefined)} phones
 * @returns {string}
 */
function preferRealPhone(...phones) {
  const list = phones.map((p) => String(p || '').trim()).filter(Boolean);
  const real = list.find((p) => !p.startsWith('lid_') && !/^2000\d+$/.test(p));
  return real || list[0] || '';
}

async function resolveConversationContact(openwaSessionId, chatId) {
  const cid = String(chatId || '').trim();
  if (!cid) return null;

  const identity = await resolveContactIdentity(openwaSessionId, cid, {
    from: cid,
    chatId: cid
  });
  const lid =
    (identity && identity.whatsappLid) ||
    (/@lid$/i.test(cid) ? extractPhoneFromChatId(cid) : '');
  let phone = (identity && identity.normalizedPhone) || extractPhoneFromChatId(cid);
  let linkedCvId = null;
  let resolvedName = (identity && identity.name) || null;

  if (lid) {
    const byLid = await contactHistory.findContactByLid(lid);
    if (byLid) {
      phone = preferRealPhone(byLid.normalizedPhone, phone);
      if (byLid.cvId) linkedCvId = byLid.cvId;
      if (!resolvedName && byLid.name) resolvedName = byLid.name;
      if (!resolvedName && byLid.preferredName) resolvedName = byLid.preferredName;
    }
  }
  if (phone && !String(phone).startsWith('lid_') && phone !== lid) {
    const fuzzy = await contactHistory.findContactByPhoneFuzzy(phone);
    if (fuzzy && fuzzy.normalizedPhone) {
      phone = preferRealPhone(fuzzy.normalizedPhone, phone);
      if (!linkedCvId && fuzzy.cvId) linkedCvId = fuzzy.cvId;
      if (!resolvedName && fuzzy.preferredName) resolvedName = fuzzy.preferredName;
      if (!resolvedName && fuzzy.name) resolvedName = fuzzy.name;
    }
  }
  const byChat = await contactHistory.findContactByChatId(cid);
  if (byChat && byChat.normalizedPhone) {
    const chatPhone = String(byChat.normalizedPhone);
    const chatIsLid = chatPhone.startsWith('lid_') || (lid && chatPhone === lid);
    const currentIsReal = Boolean(phone && !String(phone).startsWith('lid_') && phone !== lid);
    if (!currentIsReal || !chatIsLid) {
      phone = preferRealPhone(chatPhone, phone);
    }
    if (!linkedCvId && byChat.cvId) linkedCvId = byChat.cvId;
    if (!resolvedName && byChat.preferredName) resolvedName = byChat.preferredName;
    if (!resolvedName && byChat.name) resolvedName = byChat.name;
  }

  // Si solo tenemos LID, intenta casar por nombre con un CV ya cargado (teléfono del manifesto).
  if (
    lid &&
    (!phone || phone === lid || String(phone).startsWith('lid_') || isLikelyLidPhone(phone, cid)) &&
    resolvedName
  ) {
    const cvIdFromName = lookupCvIdFromArchive('', { name: resolvedName });
    if (cvIdFromName) {
      const archiveHit = (cvFileStore.loadCvsManifest() || []).find(
        (c) => c && c.cvId === cvIdFromName
      );
      const archivePhone = contactHistory.normalizePhone(archiveHit && archiveHit.telefono);
      if (archivePhone && !archivePhone.startsWith('lid_')) {
        phone = archivePhone;
        linkedCvId = linkedCvId || cvIdFromName;
        try {
          await contactHistory.enrollInboundContact({
            normalizedPhone: archivePhone,
            name: resolvedName,
            chatId: cid,
            whatsappLid: lid,
            source: 'lid_name_cv_bridge'
          });
          await contactHistory.linkCvToContact(archivePhone, {
            cvId: cvIdFromName,
            archivoOriginal: archiveHit && archiveHit.archivoOriginal,
            name: resolvedName
          });
          console.log(
            `[auto-reply] puente LID→teléfono por nombre lid=${lid} phone=${archivePhone} cvId=${cvIdFromName}`
          );
        } catch (err) {
          console.warn('[auto-reply] puente LID→teléfono:', err.message);
        }
      } else if (!linkedCvId) {
        linkedCvId = cvIdFromName;
      }
    }
  }

  if (lid && (!phone || phone === lid || isLikelyLidPhone(phone, cid))) {
    phone = `lid_${lid}`;
  }

  return {
    normalizedPhone: phone || '',
    whatsappLid: lid || null,
    chatId: cid,
    name: resolvedName || null,
    linkedCvId: linkedCvId || null
  };
}

async function waitChatLockFree(lockKey, timeoutMs = 60000) {
  const start = Date.now();
  while (chatLocks.has(lockKey)) {
    if (Date.now() - start > timeoutMs) return false;
    await sleep(200);
  }
  return true;
}

function autoEnrollUnknownEnabled() {
  const v = String(process.env.AUTO_REPLY_ENROLL_UNKNOWN || 'true').trim().toLowerCase();
  return v !== 'false' && v !== '0' && v !== 'no';
}

/**
 * Horas antes de volver a permitir un saludo (Hola / gusto saludarte).
 * Default 4. Env: AUTO_REPLY_GREETING_COOLDOWN_HOURS
 */
function getGreetingCooldownMs() {
  const hours = parseFloat(
    String(process.env.AUTO_REPLY_GREETING_COOLDOWN_HOURS || '4').trim()
  );
  const h = Number.isFinite(hours) && hours >= 0 ? hours : 4;
  return h * 60 * 60 * 1000;
}

/**
 * Cuántos mensajes recientes incluir en el prompt de auto-respuesta.
 * Default 6. Env: AUTO_REPLY_HISTORY_LINES (0 = desactivado).
 */
function getReplyHistoryLines() {
  const v = parseInt(process.env.AUTO_REPLY_HISTORY_LINES, 10);
  if (Number.isFinite(v) && v >= 0) return Math.min(v, 12);
  return 6;
}

/**
 * @param {string} openwaSessionId
 * @param {string} chatId
 * @param {number} [maxLines]
 * @returns {Promise<string|null>}
 */
async function fetchRecentConversationMessages(
  openwaSessionId,
  chatId,
  maxLines = getReplyHistoryLines()
) {
  const lines = Math.min(Math.max(parseInt(maxLines, 10) || 0, 0), 12);
  if (!lines || !openwaSessionId || !chatId) return [];
  try {
    const messages = await getChatHistory(openwaSessionId, chatId, {
      limit: lines + 4,
      fresh: true
    });
    return Array.isArray(messages) ? messages : [];
  } catch (err) {
    console.warn('[auto-reply] historial conversación:', err.message);
    return [];
  }
}

async function fetchRecentConversationHistory(openwaSessionId, chatId, maxLines = getReplyHistoryLines()) {
  const lines = Math.min(Math.max(parseInt(maxLines, 10) || 0, 0), 12);
  if (!lines || !openwaSessionId || !chatId) return null;
  const messages = await fetchRecentConversationMessages(openwaSessionId, chatId, maxLines);
  return formatConversationHistoryForPrompt(messages, lines);
}

/**
 * @param {string|Date|null|undefined} lastAiGreetingAt
 * @param {Date} [now]
 */
function shouldAllowGreeting(lastAiGreetingAt, now = new Date()) {
  if (!lastAiGreetingAt) return true;
  const last = new Date(lastAiGreetingAt).getTime();
  if (!Number.isFinite(last)) return true;
  return now.getTime() - last >= getGreetingCooldownMs();
}

function logSystemClock(phone) {
  const parts = agendaIntent.mexicoNowParts();
  const hh = String(Math.floor(parts.minutes / 60)).padStart(2, '0');
  const mm = String(parts.minutes % 60).padStart(2, '0');
  const periodo = agendaIntent.dayPeriodFromMinutes(parts.minutes);
  logAgenda('auto-reply.reloj', {
    phone: phone || null,
    ymd: parts.ymd,
    hora: `${hh}:${mm}`,
    periodo
  });
  return { ...parts, hora: `${hh}:${mm}`, periodo };
}

function applySystemClockToReply(text, phone) {
  const before = String(text || '');
  const after = agendaIntent.rewriteTimeOfDayGreetings(before);
  if (after !== before) {
    logAgenda('auto-reply.reloj.reescrito', {
      phone: phone || null,
      before: before.slice(0, 180),
      after: after.slice(0, 180)
    });
  }
  return after;
}

function replyPromisesMeetLink(text) {
  const t = String(text || '');
  if (!/\bliga\b/i.test(t)) return false;
  return /\b(env[ií]o|enviamos|mando|mandamos|te\s+paso|confirmar|anotad)/i.test(t);
}

function slotLog(slot) {
  if (!slot || typeof slot !== 'object') return null;
  return {
    fecha: slot.fecha || null,
    horaInicio: slot.horaInicio || null,
    horaFin: slot.horaFin || null,
    label: slot.label || null
  };
}

function envFlag(name) {
  const v = String(process.env[name] || '').trim().toLowerCase();
  return v === 'true' || v === '1' || v === 'yes' || v === 'on';
}

/**
 * Pruebas: sin esperas de visto/escribiendo (sigue enviando WhatsApp real).
 * Env: AUTO_REPLY_SKIP_DELAYS=true
 */
function skipAutoReplyDelays() {
  return envFlag('AUTO_REPLY_SKIP_DELAYS');
}

function getMinDelayMs() {
  if (skipAutoReplyDelays()) return 0;
  const cfg = autoReplyStore.getConfig();
  if (cfg.minDelayMs != null && Number.isFinite(cfg.minDelayMs) && cfg.minDelayMs >= 0) {
    return cfg.minDelayMs;
  }
  const v = parseInt(process.env.AUTO_REPLY_MIN_DELAY_MS || '400', 10);
  return Number.isFinite(v) && v >= 0 ? v : 400;
}

function getMaxDelayMs() {
  if (skipAutoReplyDelays()) return 0;
  const min = getMinDelayMs();
  const cfg = autoReplyStore.getConfig();
  if (cfg.maxDelayMs != null && Number.isFinite(cfg.maxDelayMs) && cfg.maxDelayMs >= min) {
    return cfg.maxDelayMs;
  }
  const v = parseInt(process.env.AUTO_REPLY_MAX_DELAY_MS || '3000', 10);
  return Number.isFinite(v) && v >= min ? v : Math.max(min, 3000);
}

function getTypingMsPerChar() {
  const v = parseFloat(process.env.AUTO_REPLY_TYPING_MS_PER_CHAR || '15');
  return Number.isFinite(v) && v > 0 ? v : 15;
}

function getTypingBaseMs() {
  const v = parseInt(process.env.AUTO_REPLY_TYPING_BASE_MS || '400', 10);
  return Number.isFinite(v) && v >= 0 ? v : 400;
}

/** Ms antes de marcar el chat como leído (visto). Default 0.6s. */
function getSeenDelayMs() {
  if (skipAutoReplyDelays()) return 0;
  const v = parseInt(process.env.AUTO_REPLY_SEEN_DELAY_MS, 10);
  return Number.isFinite(v) && v >= 0 ? v : 600;
}

/** Ms adicionales tras el "visto" antes de mostrar "escribiendo…". Default 0.3s. */
function getTypingAfterSeenDelayMs() {
  if (skipAutoReplyDelays()) return 0;
  const v = parseInt(process.env.AUTO_REPLY_TYPING_AFTER_SEEN_MS, 10);
  return Number.isFinite(v) && v >= 0 ? v : 300;
}

function jitterMs(base, spread = 0.25) {
  const b = Math.max(0, Number(base) || 0);
  if (b === 0) return 0;
  const factor = 1 - spread + Math.random() * spread * 2;
  return Math.round(b * factor);
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, Math.max(0, ms)));
}

/**
 * Tiempo de "escribiendo…" según longitud del mensaje.
 * Default: BASE 400ms + ~15ms/char, acotado a 3s (AUTO_REPLY_MAX_DELAY_MS).
 * AUTO_REPLY_SKIP_DELAYS=true → 0.
 * @param {string} text
 * @returns {number}
 */
function typingDurationMsForText(text) {
  if (skipAutoReplyDelays()) return 0;
  const body = String(text || '');
  const chars = body.length;
  const raw = getTypingBaseMs() + chars * getTypingMsPerChar();
  const jitter = 0.85 + Math.random() * 0.3; // ±15%
  const withJitter = Math.round(raw * jitter);
  return Math.min(getMaxDelayMs(), Math.max(getMinDelayMs(), withJitter));
}

/**
 * Parte la respuesta en mensajes (un párrafo = un mensaje).
 * Máximo maxParts; el resto se fusiona en el último.
 * @param {string} text
 * @param {number} [maxParts]
 * @returns {string[]}
 */
function splitReplyIntoMessages(text, maxParts = 5) {
  const limit = Math.min(Math.max(parseInt(maxParts, 10) || 5, 1), 8);
  const parts = splitSpeechParts(text);
  if (!parts.length) return [];
  if (parts.length <= limit) return parts;
  const head = parts.slice(0, limit - 1);
  const tail = parts.slice(limit - 1).join('\n\n');
  return [...head, tail];
}

function interMessageGapMs() {
  if (skipAutoReplyDelays()) return 0;
  return 400 + Math.floor(Math.random() * 500); // 0.4–0.9s entre burbujas
}

/**
 * Mantiene "escribiendo…" activo hasta stop().
 * @param {string} openwaSessionId
 * @param {string} chatId
 */
function createTypingRefresher(openwaSessionId, chatId) {
  let stopped = false;
  let timer = null;

  const tick = async () => {
    if (stopped) return;
    try {
      await sendChatState(openwaSessionId, chatId, 'typing');
    } catch (err) {
      console.warn('[auto-reply] typing refresh:', err.message);
    }
    if (!stopped) {
      timer = setTimeout(tick, TYPING_REFRESH_MS);
    }
  };

  tick();

  return {
    stop() {
      stopped = true;
      if (timer) {
        clearTimeout(timer);
        timer = null;
      }
    }
  };
}

/**
 * Simula lectura humana: espera → visto → espera.
 * El indicador "escribiendo…" no se enciende aquí: se muestra solo al enviar
 * (máx. ~3s), para no dejarlo activo todo el tiempo que tarda la IA.
 * @param {string} openwaSessionId
 * @param {string} chatId
 * @param {{ receivedAt?: number, isCancelled?: () => boolean }} [opts]
 */
async function runPresenceLeadIn(openwaSessionId, chatId, opts = {}) {
  const receivedAt = opts.receivedAt || Date.now();
  const isCancelled = () => Boolean(opts.isCancelled && opts.isCancelled());

  if (skipAutoReplyDelays()) {
    try {
      await markChatRead(openwaSessionId, chatId);
    } catch (err) {
      console.warn('[auto-reply] mark read:', err.message);
    }
    return { typingStartedAt: Date.now(), refresher: null, receivedAt };
  }

  const seenDelay = jitterMs(getSeenDelayMs());
  if (seenDelay > 0) await sleep(seenDelay);
  if (isCancelled()) return { typingStartedAt: Date.now(), refresher: null, cancelled: true };

  try {
    await markChatRead(openwaSessionId, chatId);
    console.log(
      `[auto-reply] visto ~${Math.round((Date.now() - receivedAt) / 1000)}s → ${chatId}`
    );
  } catch (err) {
    console.warn('[auto-reply] mark read:', err.message);
  }
  if (isCancelled()) return { typingStartedAt: Date.now(), refresher: null, cancelled: true };

  const afterSeen = jitterMs(getTypingAfterSeenDelayMs());
  if (afterSeen > 0) await sleep(afterSeen);
  if (isCancelled()) return { typingStartedAt: Date.now(), refresher: null, cancelled: true };

  return { typingStartedAt: Date.now(), refresher: null, receivedAt };
}

/**
 * Mantiene el indicador "escribiendo…" durante durationMs (refresco periódico).
 * Fallos de presencia no abortan el envío.
 * @param {string} openwaSessionId
 * @param {string} chatId
 * @param {number} durationMs
 * @param {{ testMode?: boolean }} [opts]
 */
async function simulateHumanTyping(openwaSessionId, chatId, durationMs, opts = {}) {
  const total = Math.max(0, Number(durationMs) || 0);
  if (total <= 0 || opts.testMode || skipAutoReplyDelays()) return;

  const isCancelled = () => Boolean(opts.isCancelled && opts.isCancelled());
  const sendTyping = async (state) => {
    try {
      await sendChatState(openwaSessionId, chatId, state);
    } catch (err) {
      console.warn(`[auto-reply] typing ${state}:`, err.message);
    }
  };

  const deadline = Date.now() + total;
  await sendTyping('typing');

  while (Date.now() < deadline) {
    if (isCancelled()) break;
    const remaining = deadline - Date.now();
    if (remaining <= 0) break;
    const chunk = Math.min(TYPING_REFRESH_MS, remaining);
    await sleep(chunk);
    if (isCancelled()) break;
    if (Date.now() < deadline) {
      await sendTyping('typing');
    }
  }

  await sendTyping('paused');
}

function cleanupIdempotencyKeys() {
  const now = Date.now();
  for (const [key, ts] of processedKeys.entries()) {
    if (now - ts > IDEMPOTENCY_TTL_MS) processedKeys.delete(key);
  }
}

function markIdempotent(key) {
  if (!key) return false;
  cleanupIdempotencyKeys();
  if (processedKeys.has(key)) return false;
  processedKeys.set(key, Date.now());
  return true;
}

function verifySignature(rawBody, signatureHeader, secret) {
  if (!secret) return true;
  if (!signatureHeader) return false;
  const expected = `sha256=${crypto.createHmac('sha256', secret).update(rawBody).digest('hex')}`;
  try {
    return crypto.timingSafeEqual(Buffer.from(expected), Buffer.from(String(signatureHeader)));
  } catch {
    return false;
  }
}

function extractPhoneFromChatId(chatId) {
  if (!chatId) return '';
  return String(chatId).replace(/@.*$/, '').replace(/\D/g, '');
}

/**
 * Resuelve el teléfono real del mensaje entrante.
 * OpenWA a veces manda `from` como `...@lid` (ID interno); en ese caso usa senderPhone / contact.
 */
function resolveIncomingPhone(msg) {
  const chatId = String(msg?.from || msg?.chatId || msg?.sender || '');
  const isLid = /@lid$/i.test(chatId);

  const candidates = [
    msg?.senderPhone,
    msg?.contact?.phone,
    msg?.contact?.phoneNumber,
    msg?.contact?.number,
    msg?.authorPhone,
    !isLid ? extractPhoneFromChatId(chatId) : ''
  ];

  for (const raw of candidates) {
    const normalized = contactHistory.normalizePhone(raw);
    if (normalized && normalized.length >= 10 && !normalized.startsWith('2000')) {
      // Heurística: LIDs largos tipo 2000… no son teléfonos MX
      return normalized;
    }
    if (normalized && normalized.length >= 10 && !isLid) return normalized;
  }

  return contactHistory.normalizePhone(extractPhoneFromChatId(chatId));
}

function isLikelyLidPhone(phone, chatId) {
  const p = String(phone || '');
  if (/@lid$/i.test(String(chatId || ''))) {
    return p === extractPhoneFromChatId(chatId) || p.startsWith('lid_');
  }
  return false;
}

/**
 * Intenta obtener teléfono real vía OpenWA; si solo hay LID, usa clave lid_*.
 * @param {string} openwaSessionId
 * @param {string} chatId
 * @param {object} [msg]
 * @param {{ getContact?: Function, getContactPhone?: Function }} [deps] - solo tests
 */
async function resolveContactIdentity(openwaSessionId, chatId, msg, deps = {}) {
  const getContactFn = deps.getContact || getContact;
  const getContactPhoneFn = deps.getContactPhone || getContactPhone;
  const lidDigits = /@lid$/i.test(String(chatId || ''))
    ? extractPhoneFromChatId(chatId)
    : '';

  let phone = resolveIncomingPhone(msg);
  if (phone && !isLikelyLidPhone(phone, chatId)) {
    return {
      normalizedPhone: phone,
      chatId: String(chatId || ''),
      whatsappLid: lidDigits || null,
      resolvedFrom: 'payload'
    };
  }

  let contactName = null;
  if (openwaSessionId && chatId) {
    try {
      const contact = await getContactFn(openwaSessionId, chatId);
      contactName = contact.name || contact.pushName || null;
      const candidates = [
        contact.number,
        contact.phoneNumber,
        contact.phone,
        contact.contact?.number,
        contact.contact?.phoneNumber,
        // getContact histórico solo exponía raw; no perder el teléfono ahí.
        contact.raw
      ];
      for (const raw of candidates) {
        const normalized =
          raw && typeof raw === 'object'
            ? extractPhoneFromOpenWaContact(raw)
            : contactHistory.normalizePhone(raw);
        if (
          normalized &&
          normalized.length >= 10 &&
          normalized !== lidDigits &&
          !normalized.startsWith('2000') &&
          !(normalized.length >= 14 && !/^(52|521|1)\d+$/.test(normalized))
        ) {
          return {
            normalizedPhone: normalized,
            chatId: String(chatId || ''),
            whatsappLid: lidDigits || null,
            resolvedFrom: 'openwa_contact',
            name: contactName
          };
        }
      }
      const rawKeys =
        contact.raw && typeof contact.raw === 'object'
          ? Object.keys(contact.raw).join(',')
          : '';
      console.log(
        `[auto-reply] getContact sin teléfono usable chatId=${chatId} keys=${Object.keys(contact || {}).join(',')} rawKeys=${rawKeys || '—'}`
      );
    } catch (err) {
      console.warn(`[auto-reply] getContact falló chatId=${chatId}: ${err.message}`);
    }

    // OpenWA: GET .../contacts/{@lid}/phone — convierte LID → E.164 cuando WhatsApp lo conoce.
    if (lidDigits) {
      try {
        const resolved = contactHistory.normalizePhone(
          await getContactPhoneFn(openwaSessionId, chatId)
        );
        if (
          resolved &&
          resolved.length >= 10 &&
          resolved !== lidDigits &&
          !resolved.startsWith('2000') &&
          !(resolved.length >= 14 && !/^(52|521|1)\d+$/.test(resolved))
        ) {
          console.log(
            `[auto-reply] LID→phone via /phone chatId=${chatId} phone=${resolved}`
          );
          return {
            normalizedPhone: resolved,
            chatId: String(chatId || ''),
            whatsappLid: lidDigits,
            resolvedFrom: 'openwa_lid_phone',
            name: contactName
          };
        }
        console.log(`[auto-reply] /phone sin resolución chatId=${chatId}`);
      } catch (err) {
        console.warn(`[auto-reply] /phone falló chatId=${chatId}: ${err.message}`);
      }
    }
  }

  if (lidDigits) {
    return {
      normalizedPhone: `lid_${lidDigits}`,
      chatId: String(chatId || ''),
      whatsappLid: lidDigits,
      resolvedFrom: 'lid_key',
      name: contactName
    };
  }

  if (phone) {
    return {
      normalizedPhone: phone,
      chatId: String(chatId || ''),
      whatsappLid: null,
      resolvedFrom: 'fallback'
    };
  }

  return null;
}

function findLogicalSessionByOpenwaId(openwaSessionId) {
  const id = String(openwaSessionId || '').trim();
  return sessionsStore.getAllSessions().find((s) => s.openwaSessionId === id) || null;
}

function parseWebhookPayload(body) {
  if (!body || typeof body !== 'object') return null;
  const event = body.event || body.type;
  const sessionId = body.sessionId;
  const data = body.data || body.message || body;
  return { event, sessionId, data };
}

/**
 * Normaliza ids de WhatsApp/OpenWA (string u objeto con `_serialized`).
 * @param {unknown} raw
 * @returns {string|null}
 */
function normalizeWhatsAppMessageId(raw) {
  return incomingMessagesStore.normalizeMessageId(raw);
}

/**
 * Id estable de bandeja = mensaje WhatsApp, no la clave de cada entrega HTTP.
 * @param {object} extracted
 * @returns {string}
 */
function stableInboxId(extracted) {
  const messageId = normalizeWhatsAppMessageId(extracted.messageId);
  if (messageId && extracted.openwaSessionId) {
    return `inbox_${extracted.openwaSessionId}_${messageId}`;
  }
  return `inbox_${extracted.openwaSessionId || 's'}_${extracted.chatId || extracted.telefono || 'x'}_${extracted.timestamp}_${String(extracted.body || '').slice(0, 24)}`;
}

/**
 * Extrae un mensaje entrante del payload de OpenWA (sin auto-respuesta).
 * @param {object} payload
 * @returns {object|null}
 */
function extractIncomingMessage(payload) {
  const parsed = parseWebhookPayload(payload);
  if (!parsed) return null;

  const event = String(parsed.event || '').toLowerCase();
  if (event && event !== 'message.received' && event !== 'message') {
    return null;
  }

  const openwaSessionId = String(parsed.sessionId || '').trim();
  const msg = parsed.data || {};
  const body = String(msg.body || msg.text || msg.caption || '').trim();
  const mediaType = msg.type || msg.mediaType || msg.mimetype || null;
  const typeNorm = String(mediaType || '')
    .trim()
    .toLowerCase();
  // Protocolo/cifrado no interpretable por OpenWA
  if (typeNorm === 'unknown' || body.toLowerCase() === '[unknown]') {
    return null;
  }
  if (!body && !mediaType) return null;

  const chatId = msg.from || msg.chatId || msg.sender || '';
  const normalizedPhone = resolveIncomingPhone(msg);
  const logicalSession = findLogicalSessionByOpenwaId(openwaSessionId);
  const messageId = normalizeWhatsAppMessageId(msg.id || msg.messageId || null);

  return {
    openwaSessionId: openwaSessionId || null,
    sessionId: logicalSession ? logicalSession.id : null,
    telefono: normalizedPhone || extractPhoneFromChatId(chatId) || '',
    contactName: msg.notifyName || msg.senderName || msg.pushName || msg.contact?.pushName || null,
    body: body || (mediaType ? `[${mediaType}]` : ''),
    messageId,
    chatId: chatId || null,
    fromMe: Boolean(msg.fromMe),
    isGroup: Boolean(msg.isGroup || (chatId && String(chatId).includes('@g.us'))),
    mediaType: mediaType || null,
    timestamp: msg.timestamp
      ? new Date(Number(msg.timestamp) * (String(msg.timestamp).length <= 10 ? 1000 : 1)).toISOString()
      : new Date().toISOString()
  };
}

/**
 * Guarda y (opcionalmente) retransmite por SSE cualquier mensaje entrante.
 * @param {{ payload: object, broadcastEvent?: Function|null, idempotencyKey?: string }} params
 */
function captureIncomingMessage({ payload, broadcastEvent = null, idempotencyKey = null }) {
  const extracted = extractIncomingMessage(payload);
  if (!extracted) return null;
  if (extracted.fromMe) return null;

  // idempotencyKey solo sirve para auto-respuesta; la bandeja usa id estable del mensaje WA.
  void idempotencyKey;
  const id = stableInboxId(extracted);
  const before = incomingMessagesStore.list({ limit: incomingMessagesStore.MAX_MESSAGES });
  const already = before.some((m) => m.id === id) ||
    before.some(
      (m) =>
        extracted.messageId &&
        m.openwaSessionId === extracted.openwaSessionId &&
        incomingMessagesStore.normalizeMessageId(m.messageId) === extracted.messageId
    );

  const record = incomingMessagesStore.add({ ...extracted, id });
  if (broadcastEvent && !already) {
    broadcastEvent('incomingMessage', record);
  }
  return record;
}

/**
 * @param {object} params
 * @param {object} params.payload
 * @param {string} [params.idempotencyKey]
 * @param {Function|null} params.broadcastEvent
 * @param {Function|null} params.getCvContext
 * @param {Function|null} params.getLeadCv
 * @param {boolean} [params.testMode]
 */
function isDocumentMessage(msg) {
  const type = String(msg.type || msg.mediaType || '').toLowerCase();
  const mime = String(msg.mimetype || msg.mimeType || '').toLowerCase();
  return (
    type === 'document' ||
    type === 'file' ||
    mime.includes('pdf') ||
    mime.includes('msword') ||
    mime.includes('wordprocessingml')
  );
}

function isPdfMimetype(mimetype) {
  const mime = String(mimetype || '').toLowerCase();
  return mime.includes('pdf');
}

function isCvRelatedConfirmError(error) {
  const msg = String((error && error.message) || '').toLowerCase();
  if (isPanelCvProcessingError(error)) return false;
  return (
    (error && error.status === 404 && msg.includes('archivo del cv')) ||
    msg.includes('cvurl') ||
    msg.includes('falta cv')
  );
}

function isPanelCvProcessingError(error) {
  const msg = String((error && error.message) || '').toLowerCase();
  return (
    msg.includes('procesar el cv') ||
    msg.includes('análisis deepseek') ||
    msg.includes('analisis deepseek') ||
    msg.includes('timeout') ||
    msg.includes('descarga')
  );
}

async function sendCvPreviewDocument({
  cvId,
  openwaSessionId,
  chatId,
  contactName,
  slot,
  testMode
}) {
  const buffer = cvFileStore.readCvFileBuffer(cvId);
  const meta = cvFileStore.getCvFileMeta(cvId);
  if (!buffer || !meta) {
    return { sent: false, reason: 'missing_file' };
  }

  const name = preferredFirstName(contactName);
  const when = slot?.label || (slot ? `${slot.fecha} a las ${slot.horaInicio}` : '');
  const caption = name
    ? `${name}, te comparto el CV que tenemos en el sistema` +
      (when ? ` para tu sesión del ${when}` : '') +
      `. ☺️`
    : `Te comparto el CV que tenemos en el sistema` +
      (when ? ` para tu sesión del ${when}` : '') +
      `. ☺️`;

  if (testMode) {
    console.log(`[auto-reply] test skip CV preview cvId=${cvId}`);
    return { sent: true, testMode: true };
  }

  try {
    const result = await sendDocumentMessage(openwaSessionId, chatId, {
      buffer,
      filename: cvFileStore.getCvDisplayFilename(cvId),
      mimetype: meta.mime,
      caption
    });
    return { sent: true, messageId: result.messageId || null };
  } catch (error) {
    console.warn('[auto-reply] CV preview send:', error.message);
    return { sent: false, reason: error.message };
  }
}

function applyPreferredTimeDecision(decision, { today, normalizedPhone, slotsPrompt, noSlotsThatDay }) {
  // 'confirm' se agenda en el caller (processChosenSlot); aquí no pedimos otro OK.
  if (decision.action === 'confirm' && decision.slot) {
    return {
      replyText: null,
      bookSlot: decision.slot,
      agendaMeta: {
        reason: 'slot_book_direct',
        slot: decision.slot.label || decision.slot.horaInicio
      },
      agendaContext: null
    };
  }
  if (decision.action === 'nearest') {
    return {
      replyText: agendaPreferredTime.formatNearestReply(
        decision.nearby,
        decision.preferredTime,
        today
      ),
      agendaMeta: {
        reason: 'slots_nearest',
        preferredTime: decision.preferredTime
      },
      agendaContext: null
    };
  }
  if (decision.action === 'list' && slotsPrompt) {
    const prefix = noSlotsThatDay
      ? agendaPreferredTime.NO_SLOTS_THAT_DAY_PREFIX
      : agendaPreferredTime.DAY_CHOSEN_PREFIX;
    return {
      replyText: null,
      agendaMeta: {
        reason: noSlotsThatDay ? 'slots_wider_range' : 'slots_offered_for_day'
      },
      agendaContext: `${prefix}${slotsPrompt}`
    };
  }
  return {
    replyText: null,
    agendaMeta: { reason: 'ask_preferred_time' },
    agendaContext: agendaPreferredTime.ASK_PREFERRED_CONTEXT
  };
}

async function processChosenSlot({
  chosen,
  cvId,
  normalizedPhone,
  contactName,
  identity,
  chatId,
  logicalSessionId,
  openwaSessionId,
  broadcastEvent,
  testMode,
  userWillSendCv = false
}) {
  const displayName = contactName || null;
  // Siempre priorizar CV ya ligado (Mongo / archivo permanente por teléfono o nombre).
  // Si hay PDF cargado, se agenda con ese archivo: no se pide otro por WhatsApp.
  let resolvedCvId =
    cvId || lookupCvIdFromArchive(normalizedPhone, { name: displayName });
  if (resolvedCvId && !cvId) {
    console.log(
      `[auto-reply] CV recuperado del archivo permanente phone=${normalizedPhone} name=${displayName || 'null'} cvId=${resolvedCvId}`
    );
  }
  const effectiveCvId = resolvedCvId;
  logAgenda('auto-reply.booking.processChosenSlot', {
    phone: normalizedPhone,
    slot: slotLog(chosen),
    cvIdIn: cvId || null,
    cvIdResolved: effectiveCvId || null,
    userWillSendCv: Boolean(userWillSendCv),
    testMode: Boolean(testMode)
  });
  if (!effectiveCvId) {
    const prevAwaiting = agendaAwaitingCvStore.getAwaiting(normalizedPhone);
    const sameSlotWaiting =
      prevAwaiting &&
      prevAwaiting.stage === 'need_upload' &&
      prevAwaiting.chosen &&
      String(prevAwaiting.chosen.fecha) === String(chosen.fecha) &&
      String(prevAwaiting.chosen.horaInicio) === String(chosen.horaInicio);

    agendaAwaitingCvStore.rememberAwaiting(normalizedPhone, {
      chosen,
      stage: 'need_upload',
      contactName: displayName,
      chatId: identity.chatId || chatId,
      logicalSessionId,
      openwaSessionId
    });
    warnAgenda('auto-reply.booking.sinCv', {
      phone: normalizedPhone,
      slot: slotLog(chosen),
      nota: sameSlotWaiting
        ? 'ya esperábamos CV; no repetir el mismo mensaje de cita'
        : 'no se agenda ni se manda liga; se pide CV'
    });
    // Si ya avisamos de esta cita, no spamear: dejar que la IA conteste la duda del lead.
    if (sameSlotWaiting) {
      return {
        replyText: null,
        agendaMeta: { reason: 'awaiting_cv_already', slot: chosen.label || chosen.horaInicio },
        agendaPendingId: null,
        agendaContext:
          `CITA YA ANOTADA (sin repetir): ${chosen.label || `${chosen.fecha} ${chosen.horaInicio}`}. ` +
          `El lead aún no mandó CV. Responde SU mensaje actual (duda/pregunta/comentario). ` +
          `No vuelvas a decir "quedó anotado" ni prometas la liga otra vez; si encaja, una frase breve al final.`
      };
    }
    return {
      replyText: buildAskCvReply(displayName, chosen, { userWillSendCv }),
      agendaMeta: { reason: 'awaiting_cv', slot: chosen.label || chosen.horaInicio },
      agendaPendingId: null
    };
  }

  if (
    agendaPendingStore.isSlotHeld(chosen.fecha, chosen.horaInicio, chosen.horaFin, {
      exceptTelefono: normalizedPhone
    })
  ) {
    agendaOfferStore.clearOffer(normalizedPhone);
    return {
      replyText: null,
      agendaMeta: { reason: 'slot_taken_reoffer' },
      agendaPendingId: null
    };
  }

  try {
    await contactHistory.linkCvToContact(normalizedPhone, {
      cvId: effectiveCvId,
      name: displayName
    });
  } catch (err) {
    console.warn('[auto-reply] linkCvToContact:', err.message);
  }

  return finalizeAgendaBooking({
    normalizedPhone,
    chosen,
    cvId: effectiveCvId,
    contactName: displayName,
    identity,
    chatId,
    logicalSessionId,
    openwaSessionId,
    broadcastEvent,
    testMode
  });
}

async function gateLeadFieldsBeforeBooking(params) {
  if (params.skipLeadFieldGate) return null;

  const missing = await agendaLeadFields.getMissingLeadFieldsForCv(params.cvId, {
    nombre: params.contactName,
    telefono: params.normalizedPhone
  });
  if (!missing.length) return null;

  agendaAwaitingCvStore.rememberAwaiting(params.normalizedPhone, {
    chosen: params.chosen,
    cvId: params.cvId,
    stage: 'need_lead_data',
    missingFields: missing,
    contactName: params.contactName,
    chatId: params.identity?.chatId || params.chatId,
    logicalSessionId: params.logicalSessionId,
    openwaSessionId: params.openwaSessionId
  });

  return {
    replyText: agendaLeadFields.buildAskMissingLeadFieldsReply(params.contactName, missing),
    agendaMeta: { reason: 'awaiting_lead_data', missingFields: missing, cvId: params.cvId },
    agendaPendingId: null
  };
}

async function finalizeAgendaBooking({
  normalizedPhone,
  chosen,
  cvId,
  contactName,
  identity,
  chatId,
  logicalSessionId,
  openwaSessionId,
  broadcastEvent,
  testMode,
  skipLeadFieldGate = false
}) {
  logAgenda('auto-reply.booking.finalize.start', {
    phone: normalizedPhone,
    slot: slotLog(chosen),
    cvId: cvId || null,
    autoConfirm: agendaConfirmService.autoConfirmEnabled(),
    testMode: Boolean(testMode),
    skipLeadFieldGate: Boolean(skipLeadFieldGate)
  });
  const gated = await gateLeadFieldsBeforeBooking({
    normalizedPhone,
    chosen,
    cvId,
    contactName,
    identity,
    chatId,
    logicalSessionId,
    openwaSessionId,
    skipLeadFieldGate
  });
  if (gated) {
    logAgenda('auto-reply.booking.finalize.gated', {
      phone: normalizedPhone,
      reason: gated.agendaMeta && gated.agendaMeta.reason,
      missingFields: gated.agendaMeta && gated.agendaMeta.missingFields
    });
    return gated;
  }

  const pending = agendaPendingStore.createPending({
    telefono: normalizedPhone,
    chatId: identity.chatId || chatId,
    contactName,
    cvId,
    fecha: chosen.fecha,
    horaInicio: chosen.horaInicio,
    horaFin: chosen.horaFin,
    label: chosen.label,
    logicalSessionId,
    openwaSessionId,
    candidateVendors: chosen.candidates || []
  });
  agendaOfferStore.clearOffer(normalizedPhone);
  agendaAwaitingCvStore.clearAwaiting(normalizedPhone);
  agendaWaitlistStore.cancelByPhone(normalizedPhone, 'booked');

  let replyText = buildPendingCreatedReply(contactName, chosen);
  let agendaMeta = { reason: 'pending_created', pendingId: pending.id };
  const notify = {
    openwaSessionId,
    chatId: (identity && identity.chatId) || chatId,
    logicalSessionId
  };

  if (!agendaConfirmService.autoConfirmEnabled()) {
    warnAgenda('auto-reply.booking.sinAutoConfirm', {
      pendingId: pending.id,
      phone: normalizedPhone,
      nota: 'AUTO_AGENDA_CONFIRM off: se promete la liga pero no se confirma ni se envía Meet'
    });
  } else if (testMode) {
    logAgenda('auto-reply.booking.testMode', {
      pendingId: pending.id,
      phone: normalizedPhone,
      nota: 'testMode: no se confirma en panel ni se envía liga'
    });
  }

  if (agendaConfirmService.autoConfirmEnabled() && !testMode) {
    try {
      logAgenda('auto-reply.booking.confirmandoPanel', {
        pendingId: pending.id,
        phone: normalizedPhone,
        cvId: cvId || null,
        slot: slotLog(chosen)
      });
      const confirmed = await agendaConfirmService.confirmPendingInPanel(pending, {
        buildConfirmedMeetingReply
      });
      logAgenda('auto-reply.booking.confirmResultado', {
        pendingId: pending.id,
        confirmed: Boolean(confirmed && confirmed.confirmed),
        hasUrl: Boolean(confirmed && confirmed.urlReunionLead),
        url: (confirmed && confirmed.urlReunionLead) || null
      });
      if (confirmed.urlReunionLead) {
        replyText = buildConfirmedMeetingReply({
          contactName,
          fecha: pending.fecha,
          horaInicio: pending.horaInicio,
          urlReunion: confirmed.urlReunionLead,
          senderName: logicalSessionId
            ? sessionsStore.getSessionSenderName(logicalSessionId)
            : 'Pro Talent'
        });
        agendaMeta = {
          reason: 'meeting_confirmed',
          pendingId: pending.id,
          urlReunion: confirmed.urlReunionLead
        };
      } else if (confirmed.confirmed) {
        replyText = buildConfirmedMeetingReply({
          contactName,
          fecha: pending.fecha,
          horaInicio: pending.horaInicio,
          urlReunion: null,
          senderName: logicalSessionId
            ? sessionsStore.getSessionSenderName(logicalSessionId)
            : 'Pro Talent'
        });
        agendaMeta = {
          reason: 'meeting_confirmed_no_url',
          pendingId: pending.id
        };
        warnAgenda('auto-reply.booking.confirmadoSinUrl', {
          pendingId: pending.id,
          phone: normalizedPhone,
          nota: 'reunión confirmada sin Meet; se programa reintento de envío de liga'
        });
        agendaMeetDeliveryService.scheduleMeetLinkDelivery(pending, notify);
      }
      if (broadcastEvent) {
        broadcastEvent('agendaPendingConfirmed', confirmed.confirmed);
      }
    } catch (error) {
      console.warn(
        '[auto-reply] auto-confirm falló:',
        error.message,
        error.panelBody ? JSON.stringify(error.panelBody).slice(0, 300) : ''
      );
      warnAgenda('auto-reply.booking.confirmError', {
        pendingId: pending.id,
        phone: normalizedPhone,
        message: error.message,
        status: error.status || null,
        panelBody: error.panelBody || null
      });
      const localCvOk = cvFileStore.getCvFileMeta(cvId);

      if (localCvOk && isPanelCvProcessingError(error)) {
        replyText = buildCvReceivedPendingReply(contactName, chosen);
        agendaMeta = {
          reason: 'pending_panel_cv_processing',
          pendingId: pending.id,
          error: error.message
        };
        logAgenda('auto-reply.booking.cvProcesando', {
          pendingId: pending.id,
          phone: normalizedPhone,
          nota: 'se programa reintento de liga'
        });
        agendaMeetDeliveryService.scheduleMeetLinkDelivery(pending, notify);
      } else {
        try {
          agendaPendingStore.cancelPending(pending.id);
        } catch (cancelErr) {
          console.warn('[auto-reply] cancel pending:', cancelErr.message);
        }

        if (!localCvOk || isCvRelatedConfirmError(error)) {
          agendaAwaitingCvStore.rememberAwaiting(normalizedPhone, {
            chosen,
            contactName,
            chatId: identity.chatId || chatId,
            logicalSessionId,
            openwaSessionId
          });
          replyText = buildAskCvReply(contactName, chosen);
          agendaMeta = { reason: 'awaiting_cv', error: error.message };
          warnAgenda('auto-reply.booking.confirmaPideCv', {
            pendingId: pending.id,
            phone: normalizedPhone,
            localCvOk: Boolean(localCvOk),
            error: error.message
          });
        } else {
          replyText = buildConfirmFailedReply(contactName, chosen, error.message);
          agendaMeta = {
            reason: 'confirm_failed',
            error: error.message
          };
          warnAgenda('auto-reply.booking.confirmFailed', {
            pendingId: pending.id,
            phone: normalizedPhone,
            error: error.message
          });
        }
      }
    }
  }

  if (broadcastEvent) {
    broadcastEvent('agendaPending', pending);
  }
  console.log(
    `[auto-reply] agenda ${agendaMeta.reason} ${pending.id} phone=${normalizedPhone} ${chosen.fecha} ${chosen.horaInicio}`
  );

  return { replyText, agendaMeta, agendaPendingId: pending.id };
}

async function tryIngestCvAndBook(params) {
  const {
    msg,
    openwaSessionId,
    chatId,
    normalizedPhone,
    contactName,
    identity,
    logicalSessionId,
    broadcastEvent,
    testMode
  } = params;

  const awaiting = agendaAwaitingCvStore.getAwaiting(normalizedPhone);
  if (!awaiting || !awaiting.chosen) return null;

  const messageId = normalizeWhatsAppMessageId(msg.id || msg.messageId || null);
  if (!messageId) return null;

  let media;
  try {
    media = await resolveIncomingDocumentMedia(
      openwaSessionId,
      identity.chatId || chatId,
      msg,
      downloadMessageMedia
    );
  } catch (error) {
    console.warn('[auto-reply] CV media download:', error.message);
    return {
      replyText: buildCvDownloadFailedReply(contactName),
      agendaMeta: { reason: 'cv_download_failed', error: error.message }
    };
  }

  if (!media || !media.buffer) {
    return {
      replyText: buildCvDownloadFailedReply(contactName),
      agendaMeta: { reason: 'cv_download_empty' }
    };
  }

  if (media.invalidPdf) {
    console.warn(
      `[auto-reply] PDF no legible (${media.buffer.length} bytes, mime=${media.mimetype || '?'})`
    );
    return {
      replyText: buildCvInvalidPdfReply(contactName),
      agendaMeta: { reason: 'cv_invalid_pdf' }
    };
  }

  const originalName =
    msg.filename ||
    msg.fileName ||
    media.filename ||
    (String(msg.caption || '').trim().endsWith('.pdf') ? msg.caption : null) ||
    'cv.pdf';

  let ingested;
  try {
    ingested = await cvIngestService.ingestLeadCvFromBuffer(
      media.buffer,
      originalName,
      {
        telefono: normalizedPhone,
        contactKey: normalizedPhone,
        nombre: contactName,
        fromConversation: true
      }
    );
  } catch (error) {
    if (error.code === 'invalid_pdf') {
      return {
        replyText: buildCvInvalidPdfReply(contactName),
        agendaMeta: { reason: 'cv_invalid_pdf', error: error.message }
      };
    }
    throw error;
  }

  return finalizeAgendaBooking({
    normalizedPhone,
    chosen: awaiting.chosen,
    cvId: ingested.cvId,
    contactName,
    identity,
    chatId,
    logicalSessionId,
    openwaSessionId,
    broadcastEvent,
    testMode
  });
}

async function handleIncomingWebhook({
  payload,
  idempotencyKey,
  broadcastEvent,
  getCvContext,
  getLeadCv,
  testMode = false
}) {
  const cfg = autoReplyStore.getConfig();
  if (!cfg.enabled) {
    return { handled: false, reason: 'auto_reply_disabled' };
  }

  if (!contactHistory.mongoUriConfigured()) {
    return { handled: false, reason: 'mongodb_not_configured' };
  }

  const parsed = parseWebhookPayload(payload);
  if (!parsed || parsed.event !== 'message.received') {
    return { handled: false, reason: 'ignored_event' };
  }

  const openwaSessionId = String(parsed.sessionId || '').trim();
  if (!openwaSessionId) {
    return { handled: false, reason: 'missing_session_id' };
  }

  const msg = parsed.data || {};
  if (msg.fromMe === true) return { handled: false, reason: 'from_me' };
  if (msg.isGroup === true) return { handled: false, reason: 'is_group' };

  const body = String(msg.body || msg.text || msg.caption || '').trim();
  const incomingDocument = isDocumentMessage(msg);
  if (!body && !incomingDocument) return { handled: false, reason: 'no_text_body' };

  const chatId = msg.from || msg.chatId || msg.sender;
  const identity = await resolveContactIdentity(openwaSessionId, chatId, msg);
  if (!identity || !identity.normalizedPhone) {
    return { handled: false, reason: 'invalid_phone' };
  }

  let normalizedPhone = identity.normalizedPhone;
  const contactName =
    identity.name ||
    msg.notifyName ||
    msg.senderName ||
    msg.pushName ||
    msg.contact?.pushName ||
    null;

  let known = await contactHistory.isKnownContact(normalizedPhone);
  if (!known && identity.whatsappLid) {
    const byLid = await contactHistory.findContactByLid(identity.whatsappLid);
    if (byLid) {
      normalizedPhone = byLid.normalizedPhone;
      known = true;
      console.log(
        `[auto-reply] match por LID ${identity.whatsappLid} → ${normalizedPhone}`
      );
    }
  }
  if (!known) {
    const matched = await contactHistory.findContactByPhoneFuzzy(normalizedPhone);
    if (matched) {
      console.log(
        `[auto-reply] fuzzy match ${normalizedPhone} → ${matched.normalizedPhone}`
      );
      normalizedPhone = matched.normalizedPhone;
      known = true;
    }
  }

  if (!known) {
    if (!autoEnrollUnknownEnabled()) {
      console.log(
        `[auto-reply] unknown_contact phone=${normalizedPhone} chatId=${chatId || '?'} (auto-enrol off)`
      );
      return { handled: false, reason: 'unknown_contact' };
    }

    const logicalPreview = findLogicalSessionByOpenwaId(openwaSessionId);
    await contactHistory.enrollInboundContact({
      normalizedPhone,
      name: contactName,
      logicalSessionId: logicalPreview ? logicalPreview.id : null,
      openwaSessionId,
      chatId: identity.chatId || chatId,
      whatsappLid: identity.whatsappLid,
      source: identity.resolvedFrom === 'lid_key' ? 'inbound_lid' : 'inbound_auto'
    });
    console.log(
      `[auto-reply] auto-enrol phone=${normalizedPhone} via=${identity.resolvedFrom} chatId=${chatId || '?'}`
    );
    known = true;
  }

  const waMessageId = normalizeWhatsAppMessageId(msg.id || msg.messageId || null);
  // Preferir id del mensaje WA: varias entregas/webhooks no deben reabrir auto-respuesta.
  const dedupeKey = waMessageId
    ? `msg_${openwaSessionId}_${waMessageId}`
    : idempotencyKey ||
      payload.idempotencyKey ||
      payload.deliveryId ||
      `msg_${openwaSessionId}_${(body || 'media').slice(0, 32)}`;
  if (!markIdempotent(dedupeKey)) {
    return { handled: false, reason: 'duplicate' };
  }

  const logicalSession = findLogicalSessionByOpenwaId(openwaSessionId);
  const logicalSessionId = logicalSession ? logicalSession.id : null;

  if (!autoReplyStore.isSessionEnabled(logicalSessionId, cfg)) {
    return { handled: false, reason: 'session_ai_disabled' };
  }

  let contactSession = await contactHistory.getContactSession(normalizedPhone, {
    whatsappLid: identity && identity.whatsappLid,
    chatId
  });
  if (contactSession && contactSession.aiPaused) {
    return { handled: false, reason: 'ai_paused_for_contact' };
  }

  if (contactSession && contactSession.openwaSessionId) {
    if (contactSession.openwaSessionId !== openwaSessionId) {
      console.log(
        `[auto-reply] session mismatch ${contactSession.openwaSessionId} → ${openwaSessionId} phone=${normalizedPhone}, reassigning`
      );
      await contactHistory.assignContactSession(normalizedPhone, {
        logicalSessionId,
        openwaSessionId
      });
      contactSession = await contactHistory.getContactSession(normalizedPhone, {
        whatsappLid: identity && identity.whatsappLid,
        chatId
      });
    }
  } else if (logicalSessionId) {
    await contactHistory.assignContactSession(normalizedPhone, {
      logicalSessionId,
      openwaSessionId
    });
    contactSession = await contactHistory.getContactSession(normalizedPhone, {
      whatsappLid: identity && identity.whatsappLid,
      chatId
    });
  } else {
    return { handled: false, reason: 'session_not_mapped' };
  }

  const lockKey = `${openwaSessionId}:${chatId}`;
  const batchItem = {
    msg,
    body,
    incomingDocument,
    openwaSessionId,
    chatId,
    normalizedPhone,
    contactName,
    identity,
    logicalSessionId,
    waMessageId,
    getCvContext,
    getLeadCv,
    broadcastEvent,
    testMode: Boolean(testMode)
  };

  const queued = await replyDraftService.enqueueInbound(batchItem, {
    immediate: Boolean(incomingDocument),
    skipDelay: Boolean(testMode) || skipAutoReplyDelays()
  });

  if (queued && queued.handled !== undefined && queued.reason !== 'draft_pending') {
    return queued;
  }
  if (queued && queued.reason === 'draft_pending') {
    return queued;
  }
  return queued || { handled: false, reason: 'batch_empty' };
}
/**
 * Actualiza la bandeja local para todos los mensajes del lote tras responder.
 * @param {object[]} items
 * @param {object|null} result
 */
function markBatchInbox(items, result) {
  if (!Array.isArray(items) || !items.length || !result) return;
  const handled = Boolean(result.handled);
  const reason = handled ? 'replied' : result.reason || null;
  const replyMessage = result.replyMessage || null;
  const listed = incomingMessagesStore.list({ limit: incomingMessagesStore.MAX_MESSAGES });

  for (const item of items) {
    const mid = incomingMessagesStore.normalizeMessageId(item.waMessageId);
    const sid = item.openwaSessionId || null;
    if (!mid || !sid) continue;
    const found = listed.find(
      (m) =>
        incomingMessagesStore.normalizeMessageId(m.messageId) === mid &&
        m.openwaSessionId === sid
    );
    if (!found) continue;
    incomingMessagesStore.update(found.id, {
      autoReplyHandled: handled,
      autoReplyReason: reason,
      replyMessage
    });
  }
}

/**
 * Procesa un lote de mensajes del mismo chat (texto combinado → una respuesta).
 * @param {object[]} items
 * @param {{ draftOnly?: boolean, preparedReply?: string, genId?: number }} [opts]
 */
async function processBatchedAutoReply(items, opts = {}) {
  if (!Array.isArray(items) || !items.length) {
    return { handled: false, reason: 'batch_empty' };
  }

  const draftOnly = Boolean(opts.draftOnly);
  const preparedReply =
    opts.preparedReply != null ? String(opts.preparedReply || '').trim() : '';

  const last = items[items.length - 1];
  const docItem = items.find((i) => i.incomingDocument) || null;
  const primary = docItem || last;
  const body =
    messageBatcher.combineBatchBodies(items) || String(primary.body || '').trim();
  const incomingDocument = Boolean(docItem);
  const msg = primary.msg;
  const openwaSessionId = primary.openwaSessionId;
  const chatId = primary.chatId;
  const identity = primary.identity;
  const normalizedPhone = primary.normalizedPhone;
  const contactName = primary.contactName;
  const logicalSessionId = primary.logicalSessionId;
  const broadcastEvent = primary.broadcastEvent;
  const getCvContext = primary.getCvContext;
  const getLeadCv = primary.getLeadCv;
  const testMode = Boolean(primary.testMode);
  const forceIgnorePause = Boolean(primary.forceIgnorePause);
  const lockKey = `${openwaSessionId}:${chatId}`;
  const cfg = autoReplyStore.getConfig();

  if (chatLocks.has(lockKey)) {
    if (draftOnly || preparedReply) {
      return { handled: false, reason: 'chat_busy' };
    }
    messageBatcher.requeue(lockKey, items, processBatchedAutoReply, undefined, {
      front: true
    });
    return { handled: false, reason: 'chat_busy_requeued' };
  }
  chatLocks.set(lockKey, true);
  const stickyCancelled = cancelledLockKeys.has(lockKey);
  cancelledLockKeys.delete(lockKey);
  const prevToken = sendCancelTokens.get(lockKey);
  sendCancelTokens.set(lockKey, {
    cancelled: Boolean(stickyCancelled || (prevToken && prevToken.cancelled))
  });

  let presenceRefresher = null;
  let presenceCancelled = false;
  const isTurnCancelled = () => presenceCancelled || isSendCancelled(lockKey);
  let turnResult = { handled: false, reason: 'unknown' };

  try {
    let contactSession = await contactHistory.getContactSession(normalizedPhone, {
      whatsappLid: identity && identity.whatsappLid,
      chatId
    });
    if (contactSession && contactSession.aiPaused && !forceIgnorePause) {
      turnResult = { handled: false, reason: 'ai_paused_for_contact' };
      return turnResult;
    }
    if (isTurnCancelled() && !forceIgnorePause) {
      turnResult = { handled: false, reason: 'cancelled_by_pause' };
      return turnResult;
    }

    const matchedRule = autoReplyStore.matchRule(cfg.rules, body);
    const senderName = logicalSessionId
      ? sessionsStore.getSessionSenderName(logicalSessionId)
      : 'Pro Talent';

    const preliminaryName = resolveAiContactName({
      preferredName: contactSession && contactSession.preferredName,
      sessionName: contactSession && contactSession.name,
      cvId: contactSession && contactSession.cvId,
      lastOutboundAt: contactSession && contactSession.lastOutboundAt
    });
    let cvContext = null;
    const cvHints = {
      cvId: contactSession && contactSession.cvId,
      name: preliminaryName
    };
    if (getCvContext) {
      cvContext = getCvContext(normalizedPhone, cvHints);
    }

    const leadCv =
      typeof getLeadCv === 'function' ? getLeadCv(normalizedPhone, cvHints) : null;
    // Si el CV está ligado por cvId pero el lookup por teléfono falló (chat @lid),
    // aún así toma el nombre del manifesto — nunca el pushName de WhatsApp.
    let leadCvNombre = leadCv && leadCv.nombre;
    if (!leadCvNombre && contactSession && contactSession.cvId) {
      const fromId = (cvFileStore.loadCvsManifest() || []).find(
        (c) => c && c.cvId === contactSession.cvId
      );
      if (fromId && fromId.nombre) leadCvNombre = fromId.nombre;
    }
    const contactDisplayName = resolveAiContactName({
      preferredName: contactSession && contactSession.preferredName,
      sessionName: contactSession && contactSession.name,
      leadCvNombre,
      cvId: (contactSession && contactSession.cvId) || (leadCv && leadCv.cvId),
      lastOutboundAt: contactSession && contactSession.lastOutboundAt
    });
    // Backfill preferredName cuando descubrimos el nombre del CV.
    if (
      contactDisplayName &&
      contactSession &&
      !contactSession.preferredName
    ) {
      const cvIdForBind =
        (contactSession && contactSession.cvId) || (leadCv && leadCv.cvId) || null;
      const bindKey = [normalizedPhone, contactSession.normalizedPhone]
        .map((p) => String(p || '').trim())
        .find((p) => p && !p.startsWith('lid_'));
      if (cvIdForBind && bindKey) {
        contactHistory
          .linkCvToContact(bindKey, {
            cvId: cvIdForBind,
            name: contactDisplayName
          })
          .catch(() => {});
      }
    }
    const cvId = resolveUsableCvId({
      leadCv,
      contactSession,
      phone: normalizedPhone,
      name: contactDisplayName
    });
    console.log(
      `[auto-reply] batch=${items.length} cv lookup phone=${normalizedPhone} sessionCvId=${
        (contactSession && contactSession.cvId) || 'null'
      } leadCvId=${(leadCv && leadCv.cvId) || 'null'} usable=${cvId || 'null'} ` +
        `hasCvContext=${cvContext ? 'yes' : 'no'} preferredName=${contactDisplayName || 'null'}`
    );
    const clock = logSystemClock(normalizedPhone);
    const awaitingAtStart = agendaAwaitingCvStore.getAwaiting(normalizedPhone);
    const offerAtStart = agendaOfferStore.getOffer(normalizedPhone);
    logAgenda('auto-reply.turno.start', {
      phone: normalizedPhone,
      chatId,
      body: String(body || '').slice(0, 180),
      incomingDocument: Boolean(incomingDocument),
      preparedReply: Boolean(preparedReply),
      cvId: cvId || null,
      awaitingStage: awaitingAtStart && awaitingAtStart.stage,
      offerSlots: offerAtStart && Array.isArray(offerAtStart.slots) ? offerAtStart.slots.length : 0,
      proposedSlot: offerAtStart && offerAtStart.proposedSlot
        ? slotLog(offerAtStart.proposedSlot)
        : null,
      clock
    });

    const receivedAt = Date.now();
    presenceRefresher = null;
    presenceCancelled = false;
    const presencePromise =
      !testMode && !draftOnly
        ? runPresenceLeadIn(openwaSessionId, chatId, {
            receivedAt,
            isCancelled: () => isTurnCancelled()
          }).then((presence) => {
            if (presence.refresher) presenceRefresher = presence.refresher;
            return presence;
          })
        : null;

    let replyText = preparedReply || null;
    let agendaPendingId = null;
    let agendaMeta = null;
    let deferredAgendaContext = null;

    if (!preparedReply && incomingDocument) {
      const cvBooked = await tryIngestCvAndBook({
        msg,
        openwaSessionId,
        chatId,
        normalizedPhone,
        contactName: contactDisplayName,
        identity,
        logicalSessionId,
        broadcastEvent,
        testMode
      });
      if (cvBooked) {
        replyText = cvBooked.replyText;
        agendaMeta = cvBooked.agendaMeta;
        agendaPendingId = cvBooked.agendaPendingId || null;
      }
    }

    // Datos faltantes del CV (ciudad, estado, etc.)
    const awaitingCv = agendaAwaitingCvStore.getAwaiting(normalizedPhone);
    if (
      !replyText &&
      awaitingCv &&
      agendaLeadFields.isAwaitingLeadData(awaitingCv.stage) &&
      body &&
      !incomingDocument
    ) {
      const parsed = await agendaLeadFields.parseLeadFieldsReplyAsync(
        body,
        awaitingCv.missingFields || []
      );
      if (awaitingCv.cvId && Object.keys(parsed).length) {
        agendaLeadFields.applyLeadFieldsToCv(awaitingCv.cvId, parsed);
      }
      const missingFromCv = awaitingCv.cvId
        ? await agendaLeadFields.getMissingLeadFieldsForCv(awaitingCv.cvId, {
            nombre: contactDisplayName || awaitingCv.contactName,
            telefono: normalizedPhone
          })
        : awaitingCv.missingFields || [];
      const stillMissing = agendaLeadFields.fieldsStillMissingAfterParse(
        missingFromCv,
        parsed
      );
      if (stillMissing.length) {
        agendaAwaitingCvStore.rememberAwaiting(normalizedPhone, {
          ...awaitingCv,
          stage: 'need_lead_data',
          missingFields: stillMissing
        });
        replyText = agendaLeadFields.buildAskMissingLeadFieldsReply(
          contactDisplayName || awaitingCv.contactName,
          stillMissing
        );
        agendaMeta = {
          reason: 'awaiting_lead_data_reminder',
          missingFields: stillMissing,
          cvId: awaitingCv.cvId
        };
      } else {
        const booked = await finalizeAgendaBooking({
          normalizedPhone,
          chosen: awaitingCv.chosen,
          cvId: awaitingCv.cvId,
          contactName: contactDisplayName || awaitingCv.contactName,
          identity,
          chatId,
          logicalSessionId,
          openwaSessionId,
          broadcastEvent,
          testMode,
          skipLeadFieldGate: true
        });
        replyText = booked.replyText;
        agendaMeta = booked.agendaMeta;
        agendaPendingId = booked.agendaPendingId;
      }
    }

    // Confirmación de CV existente (sí / no / otro PDF)
    if (!replyText && awaitingCv && agendaCvConfirm.isAwaitingCvConfirm(awaitingCv.stage) && body && !incomingDocument) {
      const displayName = contactDisplayName;
      if (agendaCvConfirm.looksLikeCvConfirmYes(body)) {
        const booked = await finalizeAgendaBooking({
          normalizedPhone,
          chosen: awaitingCv.chosen,
          cvId: awaitingCv.cvId,
          contactName: displayName,
          identity,
          chatId,
          logicalSessionId,
          openwaSessionId,
          broadcastEvent,
          testMode
        });
        replyText = booked.replyText;
        agendaMeta = booked.agendaMeta;
        agendaPendingId = booked.agendaPendingId;
      } else if (agendaCvConfirm.looksLikeCvConfirmNo(body)) {
        agendaAwaitingCvStore.rememberAwaiting(normalizedPhone, {
          chosen: awaitingCv.chosen,
          stage: 'need_upload',
          contactName: displayName,
          chatId: identity.chatId || chatId,
          logicalSessionId,
          openwaSessionId
        });
        replyText = buildAskReplaceCvReply(displayName, awaitingCv.chosen);
        agendaMeta = { reason: 'awaiting_cv_replace' };
      } else {
        replyText = buildCvConfirmReminderReply(displayName);
        agendaMeta = { reason: 'awaiting_cv_confirm_reminder' };
      }
    }

    // Fase 2b: esperando CV — solo reintentar agenda si ya hay PDF; si no, NO repetir "quedó anotado"
    const priorOffer = agendaOfferStore.getOffer(normalizedPhone);
    const awaitingCvAfterLeadData = agendaAwaitingCvStore.getAwaiting(normalizedPhone);
    if (
      !replyText &&
      awaitingCvAfterLeadData &&
      body &&
      !incomingDocument &&
      !agendaCvConfirm.isAwaitingCvConfirm(awaitingCvAfterLeadData.stage) &&
      !agendaLeadFields.isAwaitingLeadData(awaitingCvAfterLeadData.stage)
    ) {
      const recoveredCvId =
        awaitingCvAfterLeadData.cvId ||
        cvId ||
        lookupCvIdFromArchive(normalizedPhone, { name: contactDisplayName });
      if (recoveredCvId && awaitingCvAfterLeadData.chosen) {
        const booked = await processChosenSlot({
          chosen: awaitingCvAfterLeadData.chosen,
          cvId: recoveredCvId,
          normalizedPhone,
          contactName: contactDisplayName,
          identity,
          chatId,
          logicalSessionId,
          openwaSessionId,
          broadcastEvent,
          testMode,
          userWillSendCv: false
        });
        replyText = booked.replyText;
        agendaMeta = {
          ...(booked.agendaMeta || {}),
          reason: booked.agendaMeta?.reason || 'awaiting_cv_recovered'
        };
        agendaPendingId = booked.agendaPendingId;
        if (booked.agendaContext) deferredAgendaContext = booked.agendaContext;
      } else if (agendaIntent.userMentionsSendingCv(body)) {
        replyText =
          `${phraseWithName('Va', contactDisplayName)}. Cuando lo tengas, mándame el PDF por aquí y te paso la liga. ☺️`;
        agendaMeta = { reason: 'awaiting_cv_ack_send' };
      } else {
        // Duda / gracias / ¿? → la IA responde; no reenviar el mensaje de cita.
        const when =
          (awaitingCvAfterLeadData.chosen &&
            (awaitingCvAfterLeadData.chosen.label ||
              `${awaitingCvAfterLeadData.chosen.fecha} ${awaitingCvAfterLeadData.chosen.horaInicio}`)) ||
          'el horario acordado';
        deferredAgendaContext =
          `CITA YA ANOTADA: ${when}. Responde el mensaje actual del lead (pregunta o comentario). ` +
          `No digas otra vez "quedó anotado" ni "en breve te confirmamos la liga". ` +
          `Si aplica, aclara que no somos reclutadores de vacante abierta: es orientación de perfil.`;
        agendaMeta = { reason: 'awaiting_cv_defer_to_ai', slot: when };
      }
    }
    const dateRangeFromBody = agendaIntent.resolveDateRangeFromMessage(body);
    const bodyPinsOneDay = Boolean(
      dateRangeFromBody && dateRangeFromBody.fechaInicio === dateRangeFromBody.fechaFin
    );
    const needsBotTimeContext =
      Boolean(body) &&
      !incomingDocument &&
      (agendaIntent.looksLikeTimeConfirmYes(body) ||
        (agendaIntent.hasExplicitTimeChoice(body) && !bodyPinsOneDay));

    let lastBotProposal = '';
    if (needsBotTimeContext && priorOffer) {
      const historyMsgs = await fetchRecentConversationMessages(
        openwaSessionId,
        identity.chatId || chatId
      );
      lastBotProposal = agendaIntent.lastBotProposalText(historyMsgs);
    }

    const slotMatchOpts = {
      lastBotText: lastBotProposal,
      proposedTimes: priorOffer && priorOffer.proposedTimes
    };

    const confirmedMeeting = agendaPendingStore.findConfirmedByPhone(normalizedPhone);

    if (!replyText && confirmedMeeting) {
      const reschedule = await agendaRescheduleService.handleReschedule({
        confirmed: confirmedMeeting,
        body,
        contactName: contactDisplayName,
        broadcastEvent,
        testMode,
        priorOffer,
        slotMatchOpts
      });
      if (reschedule.handled) {
        replyText = reschedule.replyText || null;
        agendaMeta = reschedule.agendaMeta || agendaMeta;
        if (reschedule.agendaContext) {
          deferredAgendaContext =
            (deferredAgendaContext ? `${deferredAgendaContext}\n` : '') +
            reschedule.agendaContext;
        }
      } else {
        const when =
          confirmedMeeting.label ||
          `${confirmedMeeting.fecha} ${confirmedMeeting.horaInicio}`;
        deferredAgendaContext =
          (deferredAgendaContext ? `${deferredAgendaContext}\n` : '') +
          `CITA YA CONFIRMADA: ${when}` +
          (confirmedMeeting.urlReunion ? ` Meet: ${confirmedMeeting.urlReunion}` : '') +
          `. Si el lead quiere OTRO horario, muévela (no crees una cita nueva). ` +
          `Si solo pregunta algo más, responde sin volver a agendar.`;
        agendaMeta = agendaMeta || {
          reason: 'confirmed_exists_defer_to_ai',
          pendingId: confirmedMeeting.id,
          panelReunionId: confirmedMeeting.panelReunionId || null
        };
      }
    }

    if (!replyText && priorOffer && Array.isArray(priorOffer.slots) && priorOffer.slots.length) {
      const confirmingYes = agendaIntent.looksLikeTimeConfirmYes(body);
      const alreadyPending = agendaPendingStore.findPendingByPhone(normalizedPhone);
      const alreadyConfirmed = agendaPendingStore.findConfirmedByPhone(normalizedPhone);
      logAgenda('auto-reply.booking.offerMatch', {
        phone: normalizedPhone,
        confirmingYes,
        hasProposedSlot: Boolean(priorOffer.proposedSlot && priorOffer.proposedSlot.horaInicio),
        proposedSlot: slotLog(priorOffer.proposedSlot),
        slotCount: priorOffer.slots.length,
        alreadyPending: Boolean(alreadyPending),
        alreadyConfirmed: Boolean(alreadyConfirmed),
        body: String(body || '').slice(0, 160)
      });
      if (alreadyConfirmed) {
        deferredAgendaContext =
          (deferredAgendaContext ? `${deferredAgendaContext}\n` : '') +
          `CITA YA CONFIRMADA: ${alreadyConfirmed.label || `${alreadyConfirmed.fecha} ${alreadyConfirmed.horaInicio}`}. ` +
          `No crees otra; si eligió horario nuevo, debió reagendarse arriba.`;
      } else if (alreadyPending) {
        // Cita ya creada: no re-agendar por cada mensaje.
        deferredAgendaContext =
          (deferredAgendaContext ? `${deferredAgendaContext}\n` : '') +
          `CITA YA PENDIENTE: ${alreadyPending.label || `${alreadyPending.fecha} ${alreadyPending.horaInicio}`}. ` +
          `Responde el mensaje actual; no repitas que quedó anotado.`;
      } else if (confirmingYes && priorOffer.proposedSlot && priorOffer.proposedSlot.horaInicio) {
        const booked = await processChosenSlot({
          chosen: priorOffer.proposedSlot,
          cvId,
          normalizedPhone,
          contactName: contactDisplayName,
          identity,
          chatId,
          logicalSessionId,
          openwaSessionId,
          broadcastEvent,
          testMode,
          userWillSendCv: agendaIntent.userMentionsSendingCv(body)
        });
        replyText = booked.replyText;
        agendaMeta = booked.agendaMeta;
        agendaPendingId = booked.agendaPendingId;
        if (booked.agendaContext) deferredAgendaContext = booked.agendaContext;
      } else {
        const chosen = agendaIntent.matchSlotFromMessage(
          body,
          priorOffer.slots,
          slotMatchOpts
        );
        if (chosen) {
          // Ya eligió horario concreto (o confirmó): agendar de una, sin segundo "¿te queda?"
          const booked = await processChosenSlot({
            chosen,
            cvId,
            normalizedPhone,
            contactName: contactDisplayName,
            identity,
            chatId,
            logicalSessionId,
            openwaSessionId,
            broadcastEvent,
            testMode,
            userWillSendCv: agendaIntent.userMentionsSendingCv(body)
          });
          replyText = booked.replyText;
          agendaMeta = booked.agendaMeta;
          agendaPendingId = booked.agendaPendingId;
          if (booked.agendaContext) deferredAgendaContext = booked.agendaContext;
        } else {
          logAgenda('auto-reply.booking.sinMatch', {
            phone: normalizedPhone,
            confirmingYes,
            body: String(body || '').slice(0, 160),
            lastBotProposal: String(lastBotProposal || '').slice(0, 160),
            slotStarts: priorOffer.slots
              .slice(0, 12)
              .map((s) => `${s.fecha} ${s.horaInicio}`)
          });
        }
      }
    }

    const skipReslotOnYes =
      Boolean(priorOffer) &&
      agendaIntent.looksLikeTimeConfirmYes(body) &&
      !agendaIntent.hasExplicitTimeChoice(body);
    if (skipReslotOnYes && !replyText) {
      console.log(
        `[auto-reply] confirmación de hora sin slot matcheado; no se reofrece la semana phone=${normalizedPhone}`
      );
      warnAgenda('auto-reply.booking.siSinSlot', {
        phone: normalizedPhone,
        body: String(body || '').slice(0, 160),
        nota: 'dijo sí pero no hubo slot; la IA puede prometar liga sin agendar'
      });
    }

    // Fase 1: en el playbook casi siempre se cierran con horarios (XXXX → slots reales)
    let agendaContext = deferredAgendaContext || null;
    const existingPending = agendaPendingStore.findPendingByPhone(normalizedPhone);
    const existingConfirmed = agendaPendingStore.findConfirmedByPhone(normalizedPhone);
    if (existingPending && !replyText) {
      const when =
        existingPending.label ||
        `${existingPending.fecha} ${existingPending.horaInicio}`;
      agendaContext =
        (agendaContext ? `${agendaContext}\n` : '') +
        `CITA YA PENDIENTE: ${when}. No vuelvas a agendar ni digas "quedó anotado". Responde la duda o mensaje actual del lead.`;
      agendaMeta = agendaMeta || { reason: 'pending_exists_defer_to_ai', pendingId: existingPending.id };
    }
    if (existingConfirmed && !replyText) {
      const when =
        existingConfirmed.label ||
        `${existingConfirmed.fecha} ${existingConfirmed.horaInicio}`;
      agendaContext =
        (agendaContext ? `${agendaContext}\n` : '') +
        `CITA YA CONFIRMADA: ${when}. No crees una cita nueva; si pide otro horario, confirma el cambio.`;
      agendaMeta = agendaMeta || {
        reason: 'confirmed_exists_defer_to_ai',
        pendingId: existingConfirmed.id
      };
    }
    if (
      !replyText &&
      agendaIntent.shouldOfferSlots(body) &&
      !skipReslotOnYes
    ) {
      try {
        const todayWl = agendaIntent.todayYmd();
        const rangeWl = agendaIntent.resolveDateRangeFromMessage(body);
        if (
          rangeWl &&
          rangeWl.fechaInicio === rangeWl.fechaFin &&
          rangeWl.fechaInicio >= todayWl
        ) {
          const sameDayBooked =
            (existingPending && String(existingPending.fecha) === rangeWl.fechaInicio) ||
            (existingConfirmed && String(existingConfirmed.fecha) === rangeWl.fechaInicio);
          if (!sameDayBooked) {
            const aggregatedWl = await agendaAvailability.getAggregatedSlotsCached({
              fechaInicio: rangeWl.fechaInicio,
              fechaFin: rangeWl.fechaFin
            });
            const wait = agendaWaitlistService.enqueuePinnedDayIfEmpty({
              range: rangeWl,
              today: todayWl,
              slots: aggregatedWl.slots || [],
              telefono: normalizedPhone,
              chatId: (identity && identity.chatId) || chatId,
              openwaSessionId,
              logicalSessionId,
              contactName: contactDisplayName,
              cvId
            });
            if (wait) {
              replyText = wait.replyText;
              agendaMeta = wait.agendaMeta;
              console.log(`[auto-reply] agenda waitlist ${rangeWl.fechaInicio}`);
            }
          }
        }
      } catch (error) {
        console.warn('[auto-reply] agenda waitlist error:', error.message);
      }
    }
    if (
      !replyText &&
      agendaIntent.shouldOfferSlots(body) &&
      !skipReslotOnYes &&
      !existingPending &&
      !existingConfirmed
    ) {
      try {
        const today = agendaIntent.todayYmd();
        const tomorrow = agendaIntent.addDaysYmd(today, 1);
        const range =
          agendaIntent.resolveDateRangeFromMessage(body) || {
            fechaInicio: today,
            fechaFin: tomorrow
          };
        const pinnedOneDay = range.fechaInicio === range.fechaFin;
        let aggregated = await agendaAvailability.getAggregatedSlotsCached({
          fechaInicio: range.fechaInicio,
          fechaFin: range.fechaFin
        });
        let slots = aggregated.slots || [];
        let noSlotsThatDay = false;
        // Día concreto futuro vacío: ya se encoló waitlist; no ofrecer esta semana.
        if (!slots.length) {
          noSlotsThatDay = pinnedOneDay;
          if (!(pinnedOneDay && range.fechaInicio >= today)) {
            const from =
              range.fechaInicio <= today
                ? agendaIntent.addDaysYmd(today, 1)
                : range.fechaInicio;
            aggregated = await agendaAvailability.getAggregatedSlotsCached({
              fechaInicio: from,
              fechaFin: agendaIntent.addDaysYmd(from, 6)
            });
            slots = aggregated.slots || [];
            agendaMeta = {
              reason: 'slots_wider_range',
              gerentesConsultados: aggregated.gerentesConsultados,
              erroresGerente: aggregated.erroresGerente
            };
          }
        } else {
          agendaMeta = {
            reason: 'slots_offered',
            gerentesConsultados: aggregated.gerentesConsultados,
            erroresGerente: aggregated.erroresGerente
          };
        }

        if (slots.length) {
          agendaOfferStore.rememberOffer(normalizedPhone, slots);

          const decision = agendaPreferredTime.resolvePreferredTimeOffer(body, slots, {
            today,
            tomorrow
          });

          if (decision.action === 'confirm' && decision.slot) {
            // Día + hora concretos y hay hueco → agendar ya (sin pedir otro OK).
            const booked = await processChosenSlot({
              chosen: decision.slot,
              cvId,
              normalizedPhone,
              contactName: contactDisplayName,
              identity,
              chatId,
              logicalSessionId,
              openwaSessionId,
              broadcastEvent,
              testMode,
              userWillSendCv: agendaIntent.userMentionsSendingCv(body)
            });
            replyText = booked.replyText;
            agendaMeta = { ...agendaMeta, ...booked.agendaMeta };
            agendaPendingId = booked.agendaPendingId;
            if (!replyText && booked.agendaContext) {
              agendaContext = (agendaContext ? `${agendaContext}\n` : '') + booked.agendaContext;
            }
            console.log(
              `[auto-reply] agenda book-direct (${range.fechaInicio}…${range.fechaFin}) ${decision.slot.horaInicio}`
            );
          } else {
            const listMaxDays =
              decision.action === 'list'
                ? noSlotsThatDay
                  ? 7
                  : 1
                : noSlotsThatDay
                  ? 7
                  : 2;
            const applied = applyPreferredTimeDecision(decision, {
              today,
              normalizedPhone,
              noSlotsThatDay,
              slotsPrompt:
                decision.action === 'list'
                  ? agendaAvailability.formatSlotsForPrompt(slots, listMaxDays, today)
                  : undefined
            });
            if (applied.replyText) {
              replyText = applied.replyText;
              agendaMeta = { ...agendaMeta, ...applied.agendaMeta };
              console.log(
                `[auto-reply] agenda ${decision.action} (${range.fechaInicio}…${range.fechaFin})`
              );
            } else {
              agendaContext = applied.agendaContext;
              agendaMeta = { ...agendaMeta, ...applied.agendaMeta };
              console.log(
                `[auto-reply] agenda ${decision.action} (${range.fechaInicio}…${range.fechaFin})`
              );
            }
          }
        } else {
          const errMsg =
            aggregated.erroresGerente && aggregated.erroresGerente[0]
              ? aggregated.erroresGerente[0].error
              : 'sin slots';
          console.warn(
            `[auto-reply] agenda vacía (${errMsg}). Configura MSG_GERENTE_EMAIL o guarda tu correo en Mi perfil.`
          );
          agendaContext =
            '(Sin horarios libres en los próximos días. No inventes horas; ofrece otro día o paso a humano.)';
        }
        if (agendaMeta && agendaMeta.reason === 'slot_taken_reoffer' && agendaContext) {
          agendaContext = `El horario que eligió el lead ya quedó apartado por otra cita en espera. Ofrécele otras opciones.\n${agendaContext}`;
        }
      } catch (error) {
        console.warn('[auto-reply] agenda slots error:', error.message);
        agendaContext =
          '(No se pudo consultar la agenda. No inventes horarios; ofrece reintentar más tarde.)';
        agendaMeta = { reason: 'slots_error', error: error.message };
      }
    }

    if (!replyText) {
      const allowGreeting = shouldAllowGreeting(contactSession?.lastAiGreetingAt);
      const conversationHistory = await fetchRecentConversationHistory(
        openwaSessionId,
        chatId
      );
      logAgenda('auto-reply.ia.generando', {
        phone: normalizedPhone,
        allowGreeting,
        hasAgendaContext: Boolean(agendaContext),
        agendaContextHead: String(agendaContext || '').slice(0, 180),
        agendaMeta: agendaMeta && agendaMeta.reason,
        matchedRule: matchedRule && matchedRule.id
      });
      replyText = await generateReplyMessage({
        contactName: contactDisplayName,
        incomingBody: body,
        basePrompt: cfg.basePrompt,
        personaSystem: cfg.personaSystem,
        systemInstructions: cfg.systemInstructions,
        cvPolicyWithCv: cfg.cvPolicyWithCv,
        cvPolicyWithoutCv: cfg.cvPolicyWithoutCv,
        matchedRule,
        senderName,
        conversationContext: cvContext,
        conversationHistory,
        agendaContext,
        allowGreeting
      });
      logAgenda('auto-reply.ia.generado', {
        phone: normalizedPhone,
        allowGreeting,
        reply: String(replyText || '').slice(0, 240)
      });
      if (allowGreeting) {
        await contactHistory.touchLastAiGreeting(normalizedPhone);
      }
      if (replyText && agendaContext) {
        const proposed = agendaIntent.extractProposedTimesFromBotText(replyText);
        if (proposed.length) {
          agendaOfferStore.rememberProposedTimes(normalizedPhone, proposed);
        }
      }
    }

    if (!replyText) {
      turnResult = { handled: false, reason: 'empty_reply' };
      return turnResult;
    }

    replyText = applySystemClockToReply(replyText, normalizedPhone);
    logAgenda('auto-reply.turno.reply', {
      phone: normalizedPhone,
      reason: agendaMeta && agendaMeta.reason,
      pendingId: agendaPendingId,
      hasUrl: Boolean(agendaMeta && agendaMeta.urlReunion),
      reply: String(replyText).slice(0, 240)
    });
    if (
      replyPromisesMeetLink(replyText) &&
      !(agendaMeta && agendaMeta.reason === 'meeting_confirmed' && agendaMeta.urlReunion)
    ) {
      warnAgenda('auto-reply.ligaPrometidaSinEnvio', {
        phone: normalizedPhone,
        reason: agendaMeta && agendaMeta.reason,
        pendingId: agendaPendingId,
        url: (agendaMeta && agendaMeta.urlReunion) || null,
        reply: String(replyText).slice(0, 240),
        nota: 'el mensaje habla de la liga pero este turno no adjuntó un Meet'
      });
    }

    if (draftOnly) {
      turnResult = {
        handled: false,
        reason: 'draft_ready',
        replyMessage: replyText,
        sessionId: logicalSessionId,
        openwaSessionId,
        telefono: normalizedPhone,
        batchSize: items.length,
        timestamp: new Date().toISOString()
      };
      return turnResult;
    }

    if (presencePromise) {
      await presencePromise;
      if (presenceRefresher) {
        presenceRefresher.stop();
        presenceRefresher = null;
      }
    }

    if (isTurnCancelled()) {
      turnResult = { handled: false, reason: 'cancelled_by_pause' };
      return turnResult;
    }

    if (!forceIgnorePause) {
      contactSession = await contactHistory.getContactSession(normalizedPhone, {
        whatsappLid: identity && identity.whatsappLid,
        chatId
      });
      if (contactSession && contactSession.aiPaused) {
        turnResult = { handled: false, reason: 'ai_paused_for_contact' };
        return turnResult;
      }
    }

    const messageParts = splitReplyIntoMessages(replyText);
    if (!messageParts.length) {
      turnResult = { handled: false, reason: 'empty_reply' };
      return turnResult;
    }

    const messageIds = [];
    let totalTypingMs = 0;

    for (let i = 0; i < messageParts.length; i++) {
      if (isTurnCancelled()) {
        turnResult = messageIds.length
          ? {
              handled: true,
              reason: 'partial_cancelled_by_pause',
              sessionId: logicalSessionId,
              openwaSessionId,
              telefono: normalizedPhone,
              replyMessage: messageParts.slice(0, messageIds.length).join('\n\n'),
              messageIds,
              messageId: messageIds[messageIds.length - 1],
              batchSize: items.length,
              timestamp: new Date().toISOString()
            }
          : { handled: false, reason: 'cancelled_by_pause' };
        return turnResult;
      }

      const part = messageParts[i];
      const targetTypingMs = typingDurationMsForText(part);
      totalTypingMs += targetTypingMs;

      let waitMs = targetTypingMs;
      if (i > 0 && !testMode) {
        await sleep(interMessageGapMs());
      }

      if (!testMode) {
        console.log(
          `[auto-reply] msg ${i + 1}/${messageParts.length} typing ~${Math.round(waitMs / 1000)}s ` +
            `chars=${part.length} → ${normalizedPhone}`
        );
      }
      await simulateHumanTyping(openwaSessionId, chatId, waitMs, {
        testMode,
        isCancelled: () => isTurnCancelled()
      });

      if (isTurnCancelled()) {
        turnResult = messageIds.length
          ? {
              handled: true,
              reason: 'partial_cancelled_by_pause',
              sessionId: logicalSessionId,
              openwaSessionId,
              telefono: normalizedPhone,
              replyMessage: messageParts.slice(0, messageIds.length).join('\n\n'),
              messageIds,
              messageId: messageIds[messageIds.length - 1],
              batchSize: items.length,
              timestamp: new Date().toISOString()
            }
          : { handled: false, reason: 'cancelled_by_pause' };
        return turnResult;
      }

      if (!testMode) {
        const result = await sendTextMessage(openwaSessionId, chatId, part);
        if (result.messageId) messageIds.push(result.messageId);
      }
    }

    const messageId = messageIds.length ? messageIds[messageIds.length - 1] : null;

    const eventData = {
      sessionId: logicalSessionId,
      openwaSessionId,
      contactName: contactDisplayName || contactSession?.preferredName || normalizedPhone,
      telefono: normalizedPhone,
      incomingMessage: body,
      replyMessage: messageParts.join('\n\n'),
      replyParts: messageParts,
      matchedRuleId: matchedRule ? matchedRule.id : null,
      matchedRuleLabel: matchedRule ? matchedRule.label : null,
      messageId,
      messageIds,
      testMode,
      typingMs: totalTypingMs,
      agendaPendingId,
      agendaMeta,
      batchSize: items.length,
      timestamp: new Date().toISOString()
    };

    if (broadcastEvent) {
      broadcastEvent('incomingReply', eventData);
    }

    console.log(
      `Auto-reply ${testMode ? '(test) ' : ''}batch=${items.length} → ${normalizedPhone} vía ${openwaSessionId}`
    );

    turnResult = { handled: true, ...eventData };
    return turnResult;
  } finally {
    presenceCancelled = true;
    if (presenceRefresher) presenceRefresher.stop();
    chatLocks.delete(lockKey);
    sendCancelTokens.delete(lockKey);
    markBatchInbox(items, turnResult);
  }
}

function buildPendingCreatedReply(contactName, slot, senderName) {
  const when = slot.label || `${slot.fecha} ${slot.horaInicio}`;
  return `${phraseWithName('Perfecto', contactName)}. Quedó anotado el ${when}. En breve te enviamos la liga de la sesión. ☺️`;
}

function buildAskCvReply(contactName, slot, opts = {}) {
  const when = slot.label || `${slot.fecha} a las ${slot.horaInicio}`;
  return `${phraseWithName('Perfecto', contactName)}. Quedó anotado ${when}. En breve te confirmamos la liga. ☺️`;
}

function buildAskCvConfirmReply(contactName, slot) {
  const when = slot.label || `${slot.fecha} a las ${slot.horaInicio}`;
  return (
    `${phraseWithName('Perfecto', contactName)}. Cuando lo revises, dime si es el tuyo para enviarte la liga de ${when}. ☺️`
  );
}

function buildAskCvConfirmFallbackReply(contactName, slot) {
  const when = slot.label || `${slot.fecha} a las ${slot.horaInicio}`;
  return (
    `${phraseWithName('Listo', contactName)}. Para ${when}, revísalo y cuéntame si es el CV correcto. ☺️`
  );
}

function buildAskReplaceCvReply(contactName, slot) {
  const when = slot.label || `${slot.fecha} a las ${slot.horaInicio}`;
  return (
    `${phraseWithName('Sin problema', contactName)}. Cuando tengas el PDF correcto, mándamelo por aquí para ${when}. ☺️`
  );
}

function buildCvConfirmReminderReply(contactName) {
  const name = preferredFirstName(contactName);
  return name
    ? `${name}, cuando tengas chance revísalo y me confirmas si es el tuyo. ☺️`
    : `Cuando tengas chance revísalo y me confirmas si es el tuyo. ☺️`;
}

function buildCvDownloadFailedReply(contactName) {
  return (
    `${phraseWithName('Gracias', contactName)}. No pude abrir el archivo. ¿Puedes reenviar tu CV en PDF? 💙`
  );
}

function buildCvInvalidPdfReply(contactName) {
  return (
    `${phraseWithName('Gracias', contactName)}. El archivo no se abrió como PDF (a veces pasa en WhatsApp). ` +
    `¿Puedes reenviarlo como documento PDF, no como foto? 💙`
  );
}

function buildCvReceivedPendingReply(contactName, slot) {
  const when = slot.label || `${slot.fecha} a las ${slot.horaInicio}`;
  return (
    `${phraseWithName('Listo', contactName)}. Recibí tu CV y quedó anotada tu sesión para ${when}. ` +
    `En unos momentos te envío la liga de Meet por aquí. ☺️`
  );
}

function buildConfirmFailedReply(contactName, slot, errorMessage) {
  const when = slot.label || `${slot.fecha} ${slot.horaInicio}`;
  const detail = String(errorMessage || '').trim();
  const hint = detail
    ? ` (${detail.slice(0, 120)})`
    : '';
  return (
    `${phraseWithName('Gracias', contactName)}. Tu horario ${when} quedó registrado, pero hubo un problema al generar la liga${hint}. ` +
    `Un asesor te contactará en breve para confirmar. 💙`
  );
}

function buildNoCvAgendaReply(contactName, senderName) {
  return `${phraseWithName('Gracias', contactName)}. Para agendar necesito que un asesor valide tu CV primero; te contactamos enseguida. 💙`;
}

/**
 * Mensajes entrantes pendientes al final del hilo (desde el último fromMe).
 * Historial esperado: más viejo → más nuevo.
 * @param {object[]} history
 * @returns {object[]}
 */
function collectPendingInboundTail(history) {
  const list = Array.isArray(history) ? history : [];
  const pending = [];
  for (let i = list.length - 1; i >= 0; i -= 1) {
    const msg = list[i];
    if (!msg || typeof msg !== 'object') continue;
    if (msg.fromMe === true) break;
    if (msg.isGroup === true) continue;
    const body = String(msg.body || msg.text || msg.caption || '').trim();
    const incomingDocument = isDocumentMessage(msg);
    if (!body && !incomingDocument) continue;
    if (body.toLowerCase() === '[unknown]') continue;
    pending.unshift(msg);
  }
  return pending;
}

/**
 * Dispara una respuesta IA para el chat abierto (p. ej. tras reiniciar la PC).
 * Une los mensajes pendientes del contacto en una sola respuesta.
 * @param {object} opts
 * @param {string} opts.openwaSessionId
 * @param {string} opts.chatId
 * @param {Function|null} [opts.broadcastEvent]
 * @param {Function|null} [opts.getCvContext]
 * @param {Function|null} [opts.getLeadCv]
 * @param {boolean} [opts.testMode]
 * @param {boolean} [opts.forceIgnorePause] — contesta aunque el contacto esté pausado
 */
async function triggerManualReply({
  openwaSessionId,
  chatId,
  broadcastEvent = null,
  getCvContext = null,
  getLeadCv = null,
  testMode = false,
  forceIgnorePause = true
}) {
  const cfg = autoReplyStore.getConfig();
  if (!cfg.enabled) {
    return { handled: false, reason: 'auto_reply_disabled' };
  }
  if (!contactHistory.mongoUriConfigured()) {
    return { handled: false, reason: 'mongodb_not_configured' };
  }

  const sid = String(openwaSessionId || '').trim();
  const cid = String(chatId || '').trim();
  if (!sid || !cid) {
    return { handled: false, reason: 'missing_session_or_chat' };
  }
  if (cid.endsWith('@g.us')) {
    return { handled: false, reason: 'is_group' };
  }

  const logicalSession = findLogicalSessionByOpenwaId(sid);
  const logicalSessionId = logicalSession ? logicalSession.id : null;
  if (!autoReplyStore.isSessionEnabled(logicalSessionId, cfg)) {
    return { handled: false, reason: 'session_ai_disabled' };
  }

  const lockKey = chatLockKey(sid, cid);
  cancelPendingForChat(sid, cid);
  const free = await waitChatLockFree(lockKey, 90000);
  if (!free) {
    return { handled: false, reason: 'chat_busy' };
  }

  let history = [];
  try {
    history = await getChatHistory(sid, cid, { limit: 40, fresh: true });
  } catch (err) {
    console.warn('[auto-reply] manual historial:', err.message);
    return { handled: false, reason: 'history_error', error: err.message };
  }

  const pendingMsgs = collectPendingInboundTail(Array.isArray(history) ? history : []);
  if (!pendingMsgs.length) {
    return { handled: false, reason: 'no_pending_inbound' };
  }

  const lastMsg = pendingMsgs[pendingMsgs.length - 1];
  const identity = await resolveContactIdentity(sid, cid, lastMsg);
  if (!identity || !identity.normalizedPhone) {
    return { handled: false, reason: 'invalid_phone' };
  }

  let normalizedPhone = identity.normalizedPhone;
  const contactName =
    identity.name ||
    lastMsg.notifyName ||
    lastMsg.senderName ||
    lastMsg.pushName ||
    lastMsg.contact?.pushName ||
    null;

  let known = await contactHistory.isKnownContact(normalizedPhone);
  if (!known && identity.whatsappLid) {
    const byLid = await contactHistory.findContactByLid(identity.whatsappLid);
    if (byLid) {
      normalizedPhone = byLid.normalizedPhone;
      known = true;
    }
  }
  if (!known) {
    const matched = await contactHistory.findContactByPhoneFuzzy(normalizedPhone);
    if (matched) {
      normalizedPhone = matched.normalizedPhone;
      known = true;
    }
  }
  if (!known) {
    if (!autoEnrollUnknownEnabled()) {
      return { handled: false, reason: 'unknown_contact' };
    }
    await contactHistory.enrollInboundContact({
      normalizedPhone,
      name: contactName,
      logicalSessionId,
      openwaSessionId: sid,
      chatId: identity.chatId || cid,
      whatsappLid: identity.whatsappLid,
      source: 'manual_ai_reply'
    });
    known = true;
  }

  if (logicalSessionId) {
    await contactHistory.assignContactSession(normalizedPhone, {
      logicalSessionId,
      openwaSessionId: sid
    });
  } else {
    return { handled: false, reason: 'session_not_mapped' };
  }

  const items = pendingMsgs.map((msg) => ({
    msg,
    body: String(msg.body || msg.text || msg.caption || '').trim(),
    incomingDocument: isDocumentMessage(msg),
    openwaSessionId: sid,
    chatId: cid,
    normalizedPhone,
    contactName,
    identity,
    logicalSessionId,
    waMessageId: normalizeWhatsAppMessageId(msg.id || msg.messageId || null),
    getCvContext,
    getLeadCv,
    broadcastEvent,
    testMode: Boolean(testMode),
    forceIgnorePause: Boolean(forceIgnorePause),
    manualTrigger: true
  }));

  console.log(
    `[auto-reply] manual trigger phone=${normalizedPhone} pending=${items.length} forcePause=${Boolean(forceIgnorePause)}`
  );

  const result = await processBatchedAutoReply(items);
  return {
    ...result,
    pendingCount: items.length,
    manualTrigger: true
  };
}

function extractWebhookId(created) {
  if (!created || typeof created !== 'object') return null;
  const nested = created.data && typeof created.data === 'object' ? created.data : null;
  const webhook = created.webhook && typeof created.webhook === 'object' ? created.webhook : null;
  const raw =
    created.id ||
    created.webhookId ||
    (nested && (nested.id || nested.webhookId)) ||
    (webhook && (webhook.id || webhook.webhookId)) ||
    null;
  if (raw == null || raw === '') return null;
  return String(raw);
}

/**
 * True si el webhook de OpenWA apunta a nuestra URL pública.
 * @param {object} wh
 * @param {string} targetUrl
 */
function webhookMatchesUrl(wh, targetUrl) {
  if (!wh || !targetUrl) return false;
  const url = String(wh.url || wh.webhookUrl || wh.callbackUrl || '').trim();
  if (!url) return false;
  return url.replace(/\/$/, '') === String(targetUrl).replace(/\/$/, '');
}

/**
 * Borra webhooks previos de esta URL (evita N entregas del mismo mensaje).
 * @param {string} openwaSessionId
 * @param {string} webhookUrl
 * @param {string|null} [knownId]
 */
async function removeExistingWebhooksForUrl(openwaSessionId, webhookUrl, knownId = null) {
  const deleted = new Set();
  if (knownId) {
    try {
      await deleteWebhook(openwaSessionId, knownId);
      deleted.add(String(knownId));
      console.log(`[auto-reply] deleted known webhook ${knownId} for ${openwaSessionId}`);
    } catch (err) {
      console.warn(`[auto-reply] delete known webhook ${knownId} failed: ${err.message}`);
    }
  }

  let listed = [];
  try {
    listed = await listWebhooks(openwaSessionId);
  } catch (err) {
    console.warn(`[auto-reply] listWebhooks ${openwaSessionId}: ${err.message}`);
    return [...deleted];
  }

  for (const wh of listed) {
    const id = wh && (wh.id || wh.webhookId || wh._id);
    if (!id || deleted.has(String(id))) continue;
    if (!webhookMatchesUrl(wh, webhookUrl)) continue;
    try {
      await deleteWebhook(openwaSessionId, id);
      deleted.add(String(id));
      console.log(`[auto-reply] deleted orphan webhook ${id} for ${openwaSessionId}`);
    } catch (err) {
      console.warn(`[auto-reply] delete orphan webhook ${id} failed: ${err.message}`);
    }
  }
  return [...deleted];
}

async function activateWebhooks() {
  const webhookUrl = autoReplyStore.getWebhookUrl();
  if (!webhookUrl) {
    throw new Error(
      'WEBHOOK_PUBLIC_URL no está configurado. OpenWA necesita una URL pública HTTPS.'
    );
  }

  const secret = String(process.env.WEBHOOK_SECRET || '').trim();
  const sessions = sessionsStore.getAllSessions();
  if (sessions.length === 0) {
    throw new Error('No hay sesiones configuradas');
  }

  console.log(
    `[auto-reply] activateWebhooks start url=${webhookUrl} sessions=${sessions.length} secret=${
      secret ? 'yes' : 'no'
    }`
  );
  if (/127\.0\.0\.1|localhost|\[::1\]/i.test(webhookUrl)) {
    console.warn(
      '[auto-reply] WEBHOOK_PUBLIC_URL es loopback. Si OpenWA corre en Docker, 127.0.0.1 es el contenedor, no msg. Usa http://172.17.0.1:3445 y reactiva webhooks.'
    );
  }

  const prevIds = autoReplyStore.getConfig().webhookIdsBySession || {};
  const results = [];
  for (const session of sessions) {
    const openwaSessionId = session.openwaSessionId;
    try {
      const status = await getSessionStatus(openwaSessionId);
      console.log(
        `[auto-reply] session ${session.id} openwa=${openwaSessionId} status=${status.status}`
      );
      if (!isConnectedStatus(status.status)) {
        results.push({
          logicalSessionId: session.id,
          openwaSessionId,
          success: false,
          error: `Sesión no conectada (${status.status})`
        });
        continue;
      }

      await removeExistingWebhooksForUrl(
        openwaSessionId,
        webhookUrl,
        prevIds[session.id] || null
      );

      const created = await createWebhook(openwaSessionId, {
        url: webhookUrl,
        secret: secret || undefined
      });

      const keys =
        created && typeof created === 'object' ? Object.keys(created).join(',') : typeof created;
      console.log(
        `[auto-reply] createWebhook raw keys=[${keys}] preview=${JSON.stringify(created).slice(
          0,
          500
        )}`
      );

      const webhookId = extractWebhookId(created);
      if (!webhookId) {
        console.warn(
          `[auto-reply] OpenWA no devolvió id de webhook para ${session.id}; no se marca como activo`
        );
        results.push({
          logicalSessionId: session.id,
          openwaSessionId,
          success: false,
          error: 'OpenWA no devolvió id de webhook (revisa logs createWebhook raw)',
          rawKeys: keys
        });
        continue;
      }

      autoReplyStore.setWebhookId(session.id, webhookId);
      console.log(`[auto-reply] saved webhookId ${webhookId} → ${session.id}`);

      results.push({
        logicalSessionId: session.id,
        openwaSessionId,
        webhookId,
        success: true
      });
    } catch (err) {
      console.error(
        `[auto-reply] activate failed session=${session.id} openwa=${openwaSessionId}: ${err.message}`
      );
      results.push({
        logicalSessionId: session.id,
        openwaSessionId,
        success: false,
        error: err.message
      });
    }
  }

  const after = autoReplyStore.getConfig().webhookIdsBySession || {};
  const ok = results.filter((r) => r.success).length;
  console.log(
    `[auto-reply] activateWebhooks done ok=${ok}/${results.length} persistedIds=${JSON.stringify(
      after
    )}`
  );

  // Los webhooks alimentan la bandeja; la auto-respuesta se controla con el switch aparte.
  return { webhookUrl, results, webhookIdsBySession: after };
}

async function deactivateWebhooks() {
  const cfg = autoReplyStore.getConfig();
  const webhookIds = cfg.webhookIdsBySession || {};
  const webhookUrl = autoReplyStore.getWebhookUrl();
  const results = [];

  console.log(
    `[auto-reply] deactivateWebhooks start ids=${JSON.stringify(webhookIds)}`
  );

  const sessions = sessionsStore.getAllSessions();
  for (const session of sessions) {
    const openwaSessionId = session.openwaSessionId;
    if (!openwaSessionId) continue;
    const knownId = webhookIds[session.id] || null;
    try {
      const deleted = await removeExistingWebhooksForUrl(
        openwaSessionId,
        webhookUrl,
        knownId
      );
      results.push({
        logicalSessionId: session.id,
        openwaSessionId,
        webhookId: knownId,
        deletedIds: deleted,
        success: true
      });
    } catch (err) {
      console.error(`[auto-reply] deactivate failed ${session.id}: ${err.message}`);
      results.push({
        logicalSessionId: session.id,
        openwaSessionId,
        webhookId: knownId,
        success: false,
        error: err.message
      });
    }
  }

  autoReplyStore.clearAllWebhookIds();
  console.log('[auto-reply] deactivateWebhooks cleared local webhookIdsBySession');
  // No apaga la config de prompts; solo deja de recibir eventos de OpenWA.
  return results;
}

function getStatus() {
  const cfg = autoReplyStore.getPublicConfig();
  const webhookUrl = autoReplyStore.getWebhookUrl();
  const sessions = sessionsStore.getAllSessions();
  const webhookCount = Object.keys(cfg.webhookIdsBySession || {}).length;
  const canListen = Boolean(webhookUrl && sessions.length > 0);
  const enabledSessionIds = cfg.enabledSessionIds;
  const enabledSessionsCount =
    enabledSessionIds === null || enabledSessionIds === undefined
      ? sessions.length
      : enabledSessionIds.filter((id) => sessions.some((s) => s.id === id)).length;

  const status = {
    enabled: cfg.enabled,
    enabledSessionIds,
    enabledSessionsCount,
    webhookUrl,
    webhookConfigured: Boolean(webhookUrl),
    mongodbConfigured: contactHistory.mongoUriConfigured(),
    sessionsConfigured: sessions.length,
    webhooksActive: webhookCount,
    webhookIdsBySession: cfg.webhookIdsBySession,
    canListen,
    /** Alias: activar webhooks solo requiere URL pública + sesiones (para ver mensajes). */
    canActivate: canListen,
    canAutoReply: Boolean(
      (canListen || isInboxPollEnabled()) && contactHistory.mongoUriConfigured()
    ),
    ...getInboxPollStatus(),
    aiProvider: getReplyProvider(),
    ollamaModel: getReplyProvider() === 'ollama' ? ollamaService.getModel() : null
  };

  console.log(
    `[auto-reply] getStatus webhooksActive=${status.webhooksActive} enabled=${status.enabled} mongo=${status.mongodbConfigured} ids=${JSON.stringify(
      status.webhookIdsBySession || {}
    )}`
  );

  return status;
}

/** @returns {boolean} */
function isAutoActivateWebhooksEnabled() {
  const raw = process.env.AUTO_ACTIVATE_WEBHOOKS;
  if (raw != null && String(raw).trim() !== '') {
    const v = String(raw).trim().toLowerCase();
    return v !== 'false' && v !== '0' && v !== 'no';
  }
  return Boolean(autoReplyStore.getWebhookUrl());
}

function getStartupWebhookRetryMs() {
  const v = parseInt(process.env.AUTO_ACTIVATE_WEBHOOKS_RETRY_MS || '30000', 10);
  return Number.isFinite(v) && v >= 5000 ? v : 30000;
}

function getStartupWebhookMaxAttempts() {
  const v = parseInt(process.env.AUTO_ACTIVATE_WEBHOOKS_MAX_ATTEMPTS || '0', 10);
  return Number.isFinite(v) && v >= 0 ? v : 0;
}

function getStartupWebhookDelayMs() {
  const v = parseInt(process.env.AUTO_ACTIVATE_WEBHOOKS_DELAY_MS || '3000', 10);
  return Number.isFinite(v) && v >= 0 ? v : 3000;
}

/** @type {ReturnType<typeof setTimeout>|null} */
let startupWebhookTimer = null;

function isRetryableWebhookError(message) {
  const msg = String(message || '').toLowerCase();
  return (
    msg.includes('no conectada') ||
    msg.includes('not connected') ||
    msg.includes('econnrefused') ||
    msg.includes('etimedout') ||
    msg.includes('no hay sesiones')
  );
}

function isFatalWebhookError(message) {
  const msg = String(message || '').toLowerCase();
  return (
    msg.includes('destination address is not allowed') ||
    msg.includes('webhook_public_url no está configurado') ||
    msg.includes('bad request')
  );
}

/**
 * Registra webhooks OpenWA al arrancar (reintenta si las sesiones aún no están CONNECTED).
 * @param {number} [attempt]
 */
async function tryActivateWebhooksOnStartup(attempt = 1) {
  if (!isAutoActivateWebhooksEnabled()) {
    if (attempt === 1) {
      console.log(
        '[webhooks] auto-activate omitido (AUTO_ACTIVATE_WEBHOOKS=false o sin WEBHOOK_PUBLIC_URL)'
      );
    }
    return;
  }

  const maxAttempts = getStartupWebhookMaxAttempts();
  if (maxAttempts > 0 && attempt > maxAttempts) {
    console.warn(
      `[webhooks] auto-activate: se alcanzó AUTO_ACTIVATE_WEBHOOKS_MAX_ATTEMPTS=${maxAttempts}`
    );
    return;
  }

  try {
    const result = await activateWebhooks();
    const ok = result.results.filter((r) => r.success).length;
    const failed = result.results.filter((r) => !r.success);

    if (failed.length === 0) {
      console.log(
        `[webhooks] auto-activate OK al arranque (${ok}/${result.results.length}) → ${result.webhookUrl}`
      );
      return;
    }

    const errors = failed.map((r) => r.error || 'unknown').join('; ');
    if (failed.some((r) => isFatalWebhookError(r.error))) {
      console.error(`[webhooks] auto-activate falló (sin reintento): ${errors}`);
      return;
    }

    if (failed.some((r) => isRetryableWebhookError(r.error))) {
      const retryMs = getStartupWebhookRetryMs();
      console.warn(
        `[webhooks] auto-activate parcial ${ok}/${result.results.length}; reintento ${attempt + 1} en ${retryMs}ms (${errors})`
      );
      startupWebhookTimer = setTimeout(
        () => tryActivateWebhooksOnStartup(attempt + 1),
        retryMs
      );
      return;
    }

    console.warn(`[webhooks] auto-activate parcial ${ok}/${result.results.length}: ${errors}`);
  } catch (err) {
    if (isFatalWebhookError(err.message)) {
      console.error(`[webhooks] auto-activate falló (sin reintento): ${err.message}`);
      return;
    }
    const retryMs = getStartupWebhookRetryMs();
    console.warn(
      `[webhooks] auto-activate intento ${attempt} error: ${err.message}; reintento en ${retryMs}ms`
    );
    startupWebhookTimer = setTimeout(
      () => tryActivateWebhooksOnStartup(attempt + 1),
      retryMs
    );
  }
}

function scheduleStartupWebhookActivation() {
  if (!isAutoActivateWebhooksEnabled()) return;
  if (startupWebhookTimer) clearTimeout(startupWebhookTimer);
  const delayMs = getStartupWebhookDelayMs();
  console.log(`[webhooks] auto-activate programado en ${delayMs}ms`);
  startupWebhookTimer = setTimeout(() => tryActivateWebhooksOnStartup(1), delayMs);
}

function bindReplyDraftHandlers() {
  replyDraftService.setHandlers({
    processBatched: processBatchedAutoReply
  });
}

module.exports = {
  handleIncomingWebhook,
  triggerManualReply,
  cancelPendingForChat,
  resolveConversationContact,
  resolveContactIdentity,
  collectPendingInboundTail,
  captureIncomingMessage,
  extractIncomingMessage,
  normalizeWhatsAppMessageId,
  activateWebhooks,
  deactivateWebhooks,
  scheduleStartupWebhookActivation,
  tryActivateWebhooksOnStartup,
  isAutoActivateWebhooksEnabled,
  getStatus,
  verifySignature,
  findLogicalSessionByOpenwaId,
  buildConfirmedMeetingReply,
  typingDurationMsForText,
  splitReplyIntoMessages,
  simulateHumanTyping,
  skipAutoReplyDelays,
  replyDraftService,
  bindReplyDraftHandlers
};

bindReplyDraftHandlers();
