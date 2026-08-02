const crypto = require('crypto');
const contactHistory = require('./contactHistoryStore');
const autoReplyStore = require('./autoReplyStore');
const sessionsStore = require('./sessionsStore');
const incomingMessagesStore = require('./incomingMessagesStore');
const { generateReplyMessage } = require('./aiService');
const agendaAvailability = require('./agendaAvailability');
const agendaIntent = require('./agendaIntent');
const agendaOfferStore = require('./agendaOfferStore');
const agendaPendingStore = require('./agendaPendingStore');
const {
  sendTextMessage,
  createWebhook,
  deleteWebhook,
  getSessionStatus,
  isConnectedStatus,
  getContact
} = require('./openwaClient');

const IDEMPOTENCY_TTL_MS = 24 * 60 * 60 * 1000;
const processedKeys = new Map();
const chatLocks = new Map();

function autoEnrollUnknownEnabled() {
  const v = String(process.env.AUTO_REPLY_ENROLL_UNKNOWN || 'true').trim().toLowerCase();
  return v !== 'false' && v !== '0' && v !== 'no';
}

function getMinDelayMs() {
  const v = parseInt(process.env.AUTO_REPLY_MIN_DELAY_MS || '3000', 10);
  return Number.isFinite(v) && v >= 0 ? v : 3000;
}

function getMaxDelayMs() {
  const v = parseInt(process.env.AUTO_REPLY_MAX_DELAY_MS || '8000', 10);
  const min = getMinDelayMs();
  return Number.isFinite(v) && v >= min ? v : Math.max(min, 8000);
}

function randomDelayMs() {
  const min = getMinDelayMs();
  const max = getMaxDelayMs();
  return min + Math.floor(Math.random() * (max - min + 1));
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
  if (!body && !mediaType) return null;

  const chatId = msg.from || msg.chatId || msg.sender || '';
  const normalizedPhone = resolveIncomingPhone(msg);
  const logicalSession = findLogicalSessionByOpenwaId(openwaSessionId);
  const messageId = msg.id || msg.messageId || null;

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

  const id =
    idempotencyKey ||
    payload.idempotencyKey ||
    payload.deliveryId ||
    `inbox_${extracted.openwaSessionId || 's'}_${extracted.messageId || extracted.body.slice(0, 24)}_${extracted.timestamp}`;

  const record = incomingMessagesStore.add({ ...extracted, id });
  if (broadcastEvent) {
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

  const dedupeKey =
    idempotencyKey ||
    payload.idempotencyKey ||
    payload.deliveryId ||
    `msg_${openwaSessionId}_${msg.id || msg.messageId || body.slice(0, 32)}`;
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

    await new Promise((resolve) => setTimeout(resolve, randomDelayMs()));

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
        } else {
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
        }
      }
    }

    // Fase 1: ofrecer horarios
    let agendaContext = null;
    if (!replyText && agendaIntent.looksLikeScheduleIntent(body)) {
      try {
        const range =
          agendaIntent.resolveDateRangeFromMessage(body) || {
            fechaInicio: agendaIntent.todayYmd(),
            fechaFin: agendaIntent.addDaysYmd(agendaIntent.todayYmd(), 2)
          };
        const aggregated = await agendaAvailability.getAggregatedSlots({
          fechaInicio: range.fechaInicio,
          fechaFin: range.fechaFin
        });
        let slots = aggregated.slots || [];
        if (!slots.length) {
          const wider = await agendaAvailability.getAggregatedSlots({
            fechaInicio: agendaIntent.todayYmd(),
            fechaFin: agendaIntent.addDaysYmd(agendaIntent.todayYmd(), 6)
          });
          slots = wider.slots || [];
          agendaMeta = {
            reason: 'slots_wider_range',
            gerentesConsultados: wider.gerentesConsultados,
            erroresGerente: wider.erroresGerente
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
          const pub = agendaAvailability.publicSlots(slots, 8);
          agendaContext = pub
            .map((s, i) => `${i + 1}. ${s.label} (${s.fecha} ${s.horaInicio}–${s.horaFin})`)
            .join('\n');
        } else {
          agendaContext =
            'No hay horarios libres en los próximos días según la agenda del equipo. Pide al contacto otro día o que un humano le ayude.';
        }
      } catch (error) {
        console.warn('[auto-reply] agenda slots error:', error.message);
        agendaContext =
          'No se pudo consultar la agenda ahora. No inventes horarios; ofrece reintentar más tarde o paso a un asesor.';
        agendaMeta = { reason: 'slots_error', error: error.message };
      }
    }

    if (!replyText) {
      replyText = await generateReplyMessage({
        contactName: contactSession?.name || 'contacto',
        incomingBody: body,
        basePrompt: cfg.basePrompt,
        matchedRule,
        senderName,
        conversationContext: cvContext,
        agendaContext
      });
    }

    let messageId = null;
    if (!testMode) {
      const result = await sendTextMessage(openwaSessionId, chatId, replyText);
      messageId = result.messageId;
    }

    const eventData = {
      sessionId: logicalSessionId,
      openwaSessionId,
      contactName: contactSession?.name || normalizedPhone,
      telefono: normalizedPhone,
      incomingMessage: body,
      replyMessage: replyText,
      matchedRuleId: matchedRule ? matchedRule.id : null,
      matchedRuleLabel: matchedRule ? matchedRule.label : null,
      messageId,
      testMode,
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
  return `Perfecto, ${name}. Quedó anotado el ${when}. En breve te enviamos la liga de la sesión.\n\nAtte:\n${senderName || 'Pro Talent'}`;
}

function buildNoCvAgendaReply(contactName, senderName) {
  const name = String(contactName || 'contacto').split(/\s+/)[0] || 'contacto';
  return `Gracias, ${name}. Para agendar necesito que un asesor valide tu CV primero; te contactamos enseguida.\n\nAtte:\n${senderName || 'Pro Talent'}`;
}

/**
 * Mensaje WhatsApp tras confirmar cita en panel.
 */
function buildConfirmedMeetingReply({ contactName, fecha, horaInicio, urlReunion, senderName }) {
  const name = String(contactName || 'contacto').split(/\s+/)[0] || 'contacto';
  return `Listo, ${name}. Tu sesión quedó el ${fecha} a las ${horaInicio}. Liga: ${urlReunion}\n\n¡Nos vemos!\n\nAtte:\n${senderName || 'Pro Talent'}`;
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
  const results = [];

  console.log(
    `[auto-reply] deactivateWebhooks start ids=${JSON.stringify(webhookIds)}`
  );

  for (const [logicalSessionId, webhookId] of Object.entries(webhookIds)) {
    const session = sessionsStore.getSession(logicalSessionId);
    if (!session || !webhookId) continue;
    try {
      await deleteWebhook(session.openwaSessionId, webhookId);
      console.log(`[auto-reply] deleted webhook ${webhookId} for ${logicalSessionId}`);
      results.push({ logicalSessionId, webhookId, success: true });
    } catch (err) {
      console.error(
        `[auto-reply] delete webhook failed ${logicalSessionId}/${webhookId}: ${err.message}`
      );
      results.push({ logicalSessionId, webhookId, success: false, error: err.message });
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

module.exports = {
  handleIncomingWebhook,
  captureIncomingMessage,
  extractIncomingMessage,
  activateWebhooks,
  deactivateWebhooks,
  getStatus,
  verifySignature,
  findLogicalSessionByOpenwaId,
  buildConfirmedMeetingReply
};
