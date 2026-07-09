const crypto = require('crypto');
const contactHistory = require('./contactHistoryStore');
const autoReplyStore = require('./autoReplyStore');
const sessionsStore = require('./sessionsStore');
const { generateReplyMessage } = require('./aiService');
const {
  sendTextMessage,
  createWebhook,
  deleteWebhook,
  getSessionStatus,
  isConnectedStatus
} = require('./openwaClient');

const IDEMPOTENCY_TTL_MS = 24 * 60 * 60 * 1000;
const processedKeys = new Map();
const chatLocks = new Map();

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
 * @param {object} params
 * @param {object} params.payload
 * @param {string} [params.idempotencyKey]
 * @param {Function|null} params.broadcastEvent
 * @param {Function|null} params.getCvContext
 * @param {boolean} [params.testMode]
 */
async function handleIncomingWebhook({
  payload,
  idempotencyKey,
  broadcastEvent,
  getCvContext,
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
  const normalizedPhone = contactHistory.normalizePhone(extractPhoneFromChatId(chatId));
  if (!normalizedPhone) return { handled: false, reason: 'invalid_phone' };

  const known = await contactHistory.isKnownContact(normalizedPhone);
  if (!known) return { handled: false, reason: 'unknown_contact' };

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

  let contactSession = await contactHistory.getContactSession(normalizedPhone);
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

    await new Promise((resolve) => setTimeout(resolve, randomDelayMs()));

    const replyText = await generateReplyMessage({
      contactName: contactSession?.name || 'contacto',
      incomingBody: body,
      basePrompt: cfg.basePrompt,
      matchedRule,
      senderName,
      conversationContext: cvContext
    });

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

  const results = [];
  for (const session of sessions) {
    const openwaSessionId = session.openwaSessionId;
    try {
      const status = await getSessionStatus(openwaSessionId);
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

      const webhookId = created.id || created.webhookId;
      autoReplyStore.setWebhookId(session.id, webhookId);

      results.push({
        logicalSessionId: session.id,
        openwaSessionId,
        webhookId,
        success: true
      });
    } catch (err) {
      results.push({
        logicalSessionId: session.id,
        openwaSessionId,
        success: false,
        error: err.message
      });
    }
  }

  const cfg = autoReplyStore.getConfig();
  cfg.enabled = true;
  autoReplyStore.updateConfig({ enabled: true, rules: cfg.rules, basePrompt: cfg.basePrompt });

  return { webhookUrl, results };
}

async function deactivateWebhooks() {
  const cfg = autoReplyStore.getConfig();
  const webhookIds = cfg.webhookIdsBySession || {};
  const results = [];

  for (const [logicalSessionId, webhookId] of Object.entries(webhookIds)) {
    const session = sessionsStore.getSession(logicalSessionId);
    if (!session || !webhookId) continue;
    try {
      await deleteWebhook(session.openwaSessionId, webhookId);
      results.push({ logicalSessionId, webhookId, success: true });
    } catch (err) {
      results.push({ logicalSessionId, webhookId, success: false, error: err.message });
    }
  }

  autoReplyStore.clearAllWebhookIds();
  autoReplyStore.updateConfig({
    enabled: false,
    rules: cfg.rules,
    basePrompt: cfg.basePrompt
  });

  return results;
}

function getStatus() {
  const cfg = autoReplyStore.getPublicConfig();
  const webhookUrl = autoReplyStore.getWebhookUrl();
  const sessions = sessionsStore.getAllSessions();
  const webhookCount = Object.keys(cfg.webhookIdsBySession || {}).length;

  return {
    enabled: cfg.enabled,
    webhookUrl,
    webhookConfigured: Boolean(webhookUrl),
    mongodbConfigured: contactHistory.mongoUriConfigured(),
    sessionsConfigured: sessions.length,
    webhooksActive: webhookCount,
    webhookIdsBySession: cfg.webhookIdsBySession,
    canActivate: Boolean(webhookUrl && contactHistory.mongoUriConfigured() && sessions.length > 0)
  };
}

module.exports = {
  handleIncomingWebhook,
  activateWebhooks,
  deactivateWebhooks,
  getStatus,
  verifySignature,
  findLogicalSessionByOpenwaId
};
