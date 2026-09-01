const crypto = require('crypto');
const contactHistory = require('./contactHistoryStore');
const autoReplyStore = require('./autoReplyStore');
const sessionsStore = require('./sessionsStore');
const incomingMessagesStore = require('./incomingMessagesStore');
const { generateReplyMessage, splitSpeechParts } = require('./aiService');
const agendaAvailability = require('./agendaAvailability');
const agendaIntent = require('./agendaIntent');
const agendaOfferStore = require('./agendaOfferStore');
const agendaPendingStore = require('./agendaPendingStore');
const {
  sendTextMessage,
  sendChatState,
  createWebhook,
  deleteWebhook,
  listWebhooks,
  getSessionStatus,
  isConnectedStatus,
  getContact
} = require('./openwaClient');

const IDEMPOTENCY_TTL_MS = 24 * 60 * 60 * 1000;
const processedKeys = new Map();
const chatLocks = new Map();
/** WhatsApp apaga el indicador ~25s; refrescar antes. */
const TYPING_REFRESH_MS = 20000;

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
 * @param {string|Date|null|undefined} lastAiGreetingAt
 * @param {Date} [now]
 */
function shouldAllowGreeting(lastAiGreetingAt, now = new Date()) {
  if (!lastAiGreetingAt) return true;
  const last = new Date(lastAiGreetingAt).getTime();
  if (!Number.isFinite(last)) return true;
  return now.getTime() - last >= getGreetingCooldownMs();
}

function getMinDelayMs() {
  const cfg = autoReplyStore.getConfig();
  if (cfg.minDelayMs != null && Number.isFinite(cfg.minDelayMs) && cfg.minDelayMs >= 0) {
    return cfg.minDelayMs;
  }
  const v = parseInt(process.env.AUTO_REPLY_MIN_DELAY_MS || '3000', 10);
  return Number.isFinite(v) && v >= 0 ? v : 3000;
}

function getMaxDelayMs() {
  const min = getMinDelayMs();
  const cfg = autoReplyStore.getConfig();
  if (cfg.maxDelayMs != null && Number.isFinite(cfg.maxDelayMs) && cfg.maxDelayMs >= min) {
    return cfg.maxDelayMs;
  }
  const v = parseInt(process.env.AUTO_REPLY_MAX_DELAY_MS || '35000', 10);
  return Number.isFinite(v) && v >= min ? v : Math.max(min, 35000);
}

function getTypingMsPerChar() {
  const v = parseFloat(process.env.AUTO_REPLY_TYPING_MS_PER_CHAR || '200');
  return Number.isFinite(v) && v > 0 ? v : 200;
}

function getTypingBaseMs() {
  const v = parseInt(process.env.AUTO_REPLY_TYPING_BASE_MS || '2500', 10);
  return Number.isFinite(v) && v >= 0 ? v : 2500;
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, Math.max(0, ms)));
}

/**
 * Tiempo de "escribiendo…" según longitud del mensaje.
 * ~200ms/char → un párrafo de ~150 caracteres ≈ 30s (+ base).
 * Respeta min/max desde auto-reply-config.json o AUTO_REPLY_MIN/MAX_DELAY_MS.
 * @param {string} text
 * @returns {number}
 */
function typingDurationMsForText(text) {
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
  return 700 + Math.floor(Math.random() * 1100); // 0.7–1.8s entre burbujas
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
  if (total <= 0 || opts.testMode) return;

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
    const remaining = deadline - Date.now();
    if (remaining <= 0) break;
    const chunk = Math.min(TYPING_REFRESH_MS, remaining);
    await sleep(chunk);
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
 */
async function resolveContactIdentity(openwaSessionId, chatId, msg) {
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

  if (openwaSessionId && chatId) {
    try {
      const contact = await getContact(openwaSessionId, chatId);
      const candidates = [
        contact.number,
        contact.phoneNumber,
        contact.phone,
        contact.contact?.number,
        contact.contact?.phoneNumber
      ];
      for (const raw of candidates) {
        const normalized = contactHistory.normalizePhone(raw);
        if (
          normalized &&
          normalized.length >= 10 &&
          normalized !== lidDigits &&
          !normalized.startsWith('2000')
        ) {
          return {
            normalizedPhone: normalized,
            chatId: String(chatId || ''),
            whatsappLid: lidDigits || null,
            resolvedFrom: 'openwa_contact',
            name: contact.name || contact.pushName || null
          };
        }
      }
      console.log(
        `[auto-reply] getContact sin teléfono usable chatId=${chatId} keys=${Object.keys(contact || {}).join(',')}`
      );
    } catch (err) {
      console.warn(`[auto-reply] getContact falló chatId=${chatId}: ${err.message}`);
    }
  }

  if (lidDigits) {
    return {
      normalizedPhone: `lid_${lidDigits}`,
      chatId: String(chatId || ''),
      whatsappLid: lidDigits,
      resolvedFrom: 'lid_key'
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

  const body = String(msg.body || msg.text || '').trim();
  if (!body) return { handled: false, reason: 'no_text_body' };

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
      `msg_${openwaSessionId}_${body.slice(0, 32)}`;
  if (!markIdempotent(dedupeKey)) {
    return { handled: false, reason: 'duplicate' };
  }

  const logicalSession = findLogicalSessionByOpenwaId(openwaSessionId);
  const logicalSessionId = logicalSession ? logicalSession.id : null;

  if (!autoReplyStore.isSessionEnabled(logicalSessionId, cfg)) {
    return { handled: false, reason: 'session_ai_disabled' };
  }

  let contactSession = await contactHistory.getContactSession(normalizedPhone);
  if (contactSession && contactSession.aiPaused) {
    return { handled: false, reason: 'ai_paused_for_contact' };
  }

  if (contactSession && contactSession.openwaSessionId) {
    if (contactSession.openwaSessionId !== openwaSessionId) {
      return { handled: false, reason: 'wrong_session_for_contact' };
    }
  } else if (logicalSessionId) {
    await contactHistory.assignContactSession(normalizedPhone, {
      logicalSessionId,
      openwaSessionId
    });
    contactSession = await contactHistory.getContactSession(normalizedPhone);
  } else {
    return { handled: false, reason: 'session_not_mapped' };
  }

  const lockKey = `${openwaSessionId}:${chatId}`;
  if (chatLocks.has(lockKey)) {
    return { handled: false, reason: 'chat_busy' };
  }
  chatLocks.set(lockKey, true);

  try {
    const matchedRule = autoReplyStore.matchRule(cfg.rules, body);
    const senderName = logicalSessionId
      ? sessionsStore.getSessionSenderName(logicalSessionId)
      : 'Pro Talent';

    let cvContext = null;
    if (getCvContext) {
      cvContext = getCvContext(normalizedPhone);
    }

    const leadCv =
      typeof getLeadCv === 'function' ? getLeadCv(normalizedPhone) : null;
    const cvId =
      (leadCv && leadCv.cvId) ||
      (contactSession && contactSession.cvId) ||
      null;

    // Empieza "escribiendo…" mientras se arma la respuesta (más natural).
    const typingStartedAt = Date.now();
    if (!testMode) {
      try {
        await sendChatState(openwaSessionId, chatId, 'typing');
      } catch (err) {
        console.warn('[auto-reply] typing start:', err.message);
      }
    }

    let replyText = null;
    let agendaPendingId = null;
    let agendaMeta = null;

    // Fase 2: el lead elige un horario previamente ofrecido
    const priorOffer = agendaOfferStore.getOffer(normalizedPhone);
    if (priorOffer && Array.isArray(priorOffer.slots) && priorOffer.slots.length) {
      const chosen = agendaIntent.matchSlotFromMessage(body, priorOffer.slots);
      if (chosen) {
        if (!cvId) {
          replyText = buildNoCvAgendaReply(
            contactSession?.name || 'contacto',
            senderName
          );
          agendaMeta = { reason: 'no_cv_for_pending' };
        } else if (
          agendaPendingStore.isSlotHeld(
            chosen.fecha,
            chosen.horaInicio,
            chosen.horaFin,
            { exceptTelefono: normalizedPhone }
          )
        ) {
          agendaOfferStore.clearOffer(normalizedPhone);
          agendaMeta = { reason: 'slot_taken_reoffer' };
          // cae a Fase 1 para ofrecer otros horarios
        } else {
          try {
            const pending = agendaPendingStore.createPending({
              telefono: normalizedPhone,
              chatId: identity.chatId || chatId,
              contactName: contactSession?.name || contactName,
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
            agendaPendingId = pending.id;
            replyText = buildPendingCreatedReply(
              contactSession?.name || 'contacto',
              chosen,
              senderName
            );
            agendaMeta = { reason: 'pending_created', pendingId: pending.id };
            if (broadcastEvent) {
              broadcastEvent('agendaPending', pending);
            }
            console.log(
              `[auto-reply] agenda pending ${pending.id} phone=${normalizedPhone} ${chosen.fecha} ${chosen.horaInicio}`
            );
          } catch (error) {
            if (error.code === 'slot_held' || error.status === 409) {
              agendaOfferStore.clearOffer(normalizedPhone);
              agendaMeta = { reason: 'slot_taken_reoffer', error: error.message };
            } else {
              throw error;
            }
          }
        }
      }
    }

    // Fase 1: en el playbook casi siempre se cierran con horarios (XXXX → slots reales)
    let agendaContext = null;
    if (!replyText && agendaIntent.shouldOfferSlots(body)) {
      try {
        const today = agendaIntent.todayYmd();
        const range =
          agendaIntent.resolveDateRangeFromMessage(body) || {
            fechaInicio: today,
            fechaFin: agendaIntent.addDaysYmd(today, 2)
          };
        let aggregated = await agendaAvailability.getAggregatedSlotsCached({
          fechaInicio: range.fechaInicio,
          fechaFin: range.fechaFin
        });
        let slots = aggregated.slots || [];
        // Si pidió "hoy"/rango corto y ya no hay huecos futuros, pasar a próximos días
        if (!slots.length) {
          const from =
            range.fechaInicio <= today
              ? agendaIntent.addDaysYmd(today, 1)
              : range.fechaInicio;
          aggregated = await agendaAvailability.getAggregatedSlotsCached({
            fechaInicio: from,
            fechaFin: agendaIntent.addDaysYmd(today, 6)
          });
          slots = aggregated.slots || [];
          agendaMeta = {
            reason: 'slots_wider_range',
            gerentesConsultados: aggregated.gerentesConsultados,
            erroresGerente: aggregated.erroresGerente
          };
        } else {
          agendaMeta = {
            reason: 'slots_offered',
            gerentesConsultados: aggregated.gerentesConsultados,
            erroresGerente: aggregated.erroresGerente
          };
        }

        if (slots.length) {
          agendaOfferStore.rememberOffer(normalizedPhone, slots);
          agendaContext = agendaAvailability.formatSlotsForPrompt(slots, 3);
          // Si el primer día ofrecido es mañana (hoy ya venció), déjalo explícito
          const firstFecha = slots[0] && slots[0].fecha;
          if (firstFecha && firstFecha > today) {
            agendaContext = `Hoy (${today}) ya no hay horarios disponibles. Ofrece a partir de estos días:\n${agendaContext}`;
          }
        } else {
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
      replyText = await generateReplyMessage({
        contactName: contactSession?.name || 'contacto',
        incomingBody: body,
        basePrompt: cfg.basePrompt,
        matchedRule,
        senderName,
        conversationContext: cvContext,
        agendaContext,
        allowGreeting
      });
      if (allowGreeting) {
        await contactHistory.touchLastAiGreeting(normalizedPhone);
      }
    }

    if (!replyText) {
      return { handled: false, reason: 'empty_reply' };
    }

    const messageParts = splitReplyIntoMessages(replyText);
    if (!messageParts.length) {
      return { handled: false, reason: 'empty_reply' };
    }

    const messageIds = [];
    let totalTypingMs = 0;

    for (let i = 0; i < messageParts.length; i++) {
      const part = messageParts[i];
      const targetTypingMs = typingDurationMsForText(part);
      totalTypingMs += targetTypingMs;

      let waitMs = targetTypingMs;
      if (i === 0) {
        waitMs = Math.max(0, targetTypingMs - (Date.now() - typingStartedAt));
      } else if (!testMode) {
        await sleep(interMessageGapMs());
      }

      if (!testMode) {
        console.log(
          `[auto-reply] msg ${i + 1}/${messageParts.length} typing ~${Math.round(waitMs / 1000)}s ` +
            `chars=${part.length} → ${normalizedPhone}`
        );
      }
      await simulateHumanTyping(openwaSessionId, chatId, waitMs, { testMode });

      if (!testMode) {
        const result = await sendTextMessage(openwaSessionId, chatId, part);
        if (result.messageId) messageIds.push(result.messageId);
      }
    }

    const messageId = messageIds.length ? messageIds[messageIds.length - 1] : null;

    const eventData = {
      sessionId: logicalSessionId,
      openwaSessionId,
      contactName: contactSession?.name || normalizedPhone,
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
      timestamp: new Date().toISOString()
    };

    if (broadcastEvent) {
      broadcastEvent('incomingReply', eventData);
    }

    console.log(
      `Auto-reply ${testMode ? '(test) ' : ''}→ ${normalizedPhone} vía ${openwaSessionId}`
    );

    return { handled: true, ...eventData };
  } finally {
    chatLocks.delete(lockKey);
  }
}

function buildPendingCreatedReply(contactName, slot, senderName) {
  const name = String(contactName || 'contacto').split(/\s+/)[0] || 'contacto';
  const when = slot.label || `${slot.fecha} ${slot.horaInicio}`;
  return `Perfecto, ${name}. Quedó anotado el ${when}. En breve te enviamos la liga de la sesión. ☺️`;
}

function buildNoCvAgendaReply(contactName, senderName) {
  const name = String(contactName || 'contacto').split(/\s+/)[0] || 'contacto';
  return `Gracias, ${name}. Para agendar necesito que un asesor valide tu CV primero; te contactamos enseguida. 💙`;
}

/**
 * Mensaje WhatsApp tras confirmar cita en panel.
 */
function buildConfirmedMeetingReply({ contactName, fecha, horaInicio, urlReunion, senderName }) {
  const name = String(contactName || 'contacto').split(/\s+/)[0] || 'contacto';
  const ligaLine = urlReunion
    ? `\nLiga para unirte: ${urlReunion}`
    : '';
  return `Listo, ${name}. Tu sesión quedó el ${fecha} a las ${horaInicio}.${ligaLine}\n\n¡Nos vemos! ☺️`;
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
    canAutoReply: Boolean(canListen && contactHistory.mongoUriConfigured())
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

module.exports = {
  handleIncomingWebhook,
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
  simulateHumanTyping
};
