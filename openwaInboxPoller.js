/**
 * Replica el poll de Capataz (chats no leídos → historial)
 * y lo convierte en payloads `message.received` para el pipeline de webhooks.
 *
 * OpenWA no puede POST a 127.0.0.1 (SSRF). Esta app tira de OpenWA
 * y entrega el mismo evento que `/api/webhooks/openwa`.
 */
const incomingMessagesStore = require('./incomingMessagesStore');
const sessionsStore = require('./sessionsStore');
const { listChats, getChatHistory } = require('./openwaClient');

function envFlag(name) {
  const raw = process.env[name];
  if (raw == null || String(raw).trim() === '') return null;
  const v = String(raw).trim().toLowerCase();
  if (v === 'false' || v === '0' || v === 'no') return false;
  return true;
}

function isLoopbackWebhookUrl(url) {
  const u = String(url || '').trim().toLowerCase();
  if (!u) return false;
  return (
    u.includes('127.0.0.1') ||
    u.includes('localhost') ||
    u.includes('[::1]') ||
    u.includes('0.0.0.0')
  );
}

/**
 * Default: activo si WEBHOOK_PUBLIC_URL es local (OpenWA no puede entregar).
 * OPENWA_INBOX_POLL=true|false fuerza el valor.
 */
function isInboxPollEnabled() {
  const forced = envFlag('OPENWA_INBOX_POLL');
  if (forced != null) return forced;
  return isLoopbackWebhookUrl(process.env.WEBHOOK_PUBLIC_URL);
}

function getPollIntervalMs() {
  const ms = parseInt(process.env.OPENWA_INBOX_POLL_MS || '', 10);
  if (Number.isFinite(ms) && ms >= 1000) return ms;
  const sec = parseInt(process.env.POLLING_INTERVAL_SEC || '', 10);
  if (Number.isFinite(sec) && sec >= 1) return sec * 1000;
  return 3000;
}

function normalizeMessageId(raw) {
  return incomingMessagesStore.normalizeMessageId(raw);
}

function messageBody(msg) {
  return String((msg && (msg.body || msg.text || msg.caption)) || '').trim();
}

function isGroupChat(chat) {
  if (!chat) return true;
  if (chat.isGroup === true) return true;
  return String(chat.id || chat.chatId || '').includes('@g.us');
}

function unreadCount(chat) {
  const n = Number(chat && chat.unreadCount);
  return Number.isFinite(n) ? n : 0;
}

/**
 * Recorre el historial de más nuevo a más viejo (como Capataz)
 * y devuelve el primer inbound aún no visto en la bandeja.
 */
function pickLatestUnprocessedInbound(history, { openwaSessionId, isSeen } = {}) {
  const list = Array.isArray(history) ? history : [];
  const seenFn =
    typeof isSeen === 'function'
      ? isSeen
      : (sid, mid) => defaultIsSeen(sid, mid);

  for (let i = list.length - 1; i >= 0; i -= 1) {
    const msg = list[i];
    if (!msg || typeof msg !== 'object') continue;
    if (msg.fromMe === true) continue;
    if (msg.isGroup === true) continue;
    const body = messageBody(msg);
    if (!body || body.toLowerCase() === '[unknown]') continue;
    const messageId = normalizeMessageId(msg.id || msg.messageId || msg.waMessageId);
    if (messageId && seenFn(openwaSessionId, messageId)) continue;
    return msg;
  }
  return null;
}

function defaultIsSeen(openwaSessionId, messageId) {
  const id = normalizeMessageId(messageId);
  if (!id || !openwaSessionId) return false;
  const rows = incomingMessagesStore.list({ limit: incomingMessagesStore.MAX_MESSAGES });
  return rows.some(
    (m) =>
      m.openwaSessionId === openwaSessionId &&
      incomingMessagesStore.normalizeMessageId(m.messageId) === id
  );
}

/**
 * Payload idéntico al que OpenWA enviaría a POST /api/webhooks/openwa.
 */
function toWebhookPayload({ openwaSessionId, chat, message }) {
  const chatId = String((chat && (chat.id || chat.chatId)) || message.from || message.chatId || '');
  const body = messageBody(message);
  return {
    event: 'message.received',
    sessionId: String(openwaSessionId || ''),
    data: {
      id: message.id || message.messageId || message.waMessageId || null,
      from: chatId,
      chatId,
      body,
      text: body,
      fromMe: false,
      isGroup: false,
      timestamp: message.timestamp != null ? message.timestamp : Date.now() / 1000,
      pushName: (chat && chat.name) || message.contactName || message.pushName || null,
      notifyName: (chat && chat.name) || message.contactName || null
    }
  };
}

/**
 * @param {{
 *   sessions: Array<{ id?: string, openwaSessionId?: string }>,
 *   listChats: Function,
 *   getChatHistory: Function,
 *   isSeen?: Function
 * }} opts
 */
async function collectWebhookPayloads(opts) {
  const sessions = Array.isArray(opts.sessions) ? opts.sessions : [];
  const listChatsFn = opts.listChats;
  const getHistoryFn = opts.getChatHistory;
  const isSeen = opts.isSeen;
  const payloads = [];

  for (const session of sessions) {
    const openwaSessionId = session && session.openwaSessionId;
    if (!openwaSessionId) continue;
    let chats = [];
    try {
      chats = await listChatsFn(openwaSessionId, { limit: 40, fresh: true });
    } catch (err) {
      console.warn(
        `[inbox-poll] listChats ${String(openwaSessionId).slice(0, 8)}…: ${err.message}`
      );
      continue;
    }
    if (!Array.isArray(chats)) chats = [];

    for (const chat of chats) {
      if (!chat || isGroupChat(chat)) continue;
      if (unreadCount(chat) <= 0) continue;
      const chatId = chat.id || chat.chatId;
      if (!chatId) continue;

      let history = [];
      try {
        history = await getHistoryFn(openwaSessionId, chatId, { limit: 8, fresh: true });
      } catch (err) {
        console.warn(`[inbox-poll] history ${chatId}: ${err.message}`);
        continue;
      }

      const inbound = pickLatestUnprocessedInbound(history, { openwaSessionId, isSeen });
      if (!inbound) continue;
      payloads.push(toWebhookPayload({ openwaSessionId, chat, message: inbound }));
    }
  }

  return payloads;
}

/** @type {ReturnType<typeof setInterval>|null} */
let timer = null;
let inFlight = false;

function stopInboxPoller() {
  if (timer) {
    clearInterval(timer);
    timer = null;
  }
  inFlight = false;
}

/**
 * @param {{
 *   deliver: (payload: object) => Promise<unknown>,
 *   getSessions?: () => Array,
 *   listChats?: Function,
 *   getChatHistory?: Function,
 *   isSeen?: Function
 * }} options
 */
function startInboxPoller(options = {}) {
  if (typeof options.deliver !== 'function') {
    throw new Error('startInboxPoller requiere deliver(payload)');
  }
  if (!isInboxPollEnabled()) {
    console.log(
      '[inbox-poll] omitido (OPENWA_INBOX_POLL=false o WEBHOOK_PUBLIC_URL no es localhost)'
    );
    return { started: false, intervalMs: getPollIntervalMs() };
  }

  stopInboxPoller();
  const intervalMs = getPollIntervalMs();
  const getSessions = options.getSessions || (() => sessionsStore.getAllSessions());
  const listChatsFn = options.listChats || listChats;
  const getHistoryFn = options.getChatHistory || getChatHistory;

  const tick = async () => {
    if (inFlight) return;
    inFlight = true;
    try {
      const payloads = await collectWebhookPayloads({
        sessions: getSessions() || [],
        listChats: listChatsFn,
        getChatHistory: getHistoryFn,
        isSeen: options.isSeen
      });
      for (const payload of payloads) {
        await options.deliver(payload);
      }
      if (payloads.length) {
        console.log(`[inbox-poll] ${payloads.length} mensaje(s) entregados al pipeline de webhooks`);
      }
    } catch (err) {
      console.warn(`[inbox-poll] ${err.message}`);
    } finally {
      inFlight = false;
    }
  };

  timer = setInterval(tick, intervalMs);
  console.log(`[inbox-poll] activo cada ${intervalMs}ms → /api/webhooks/openwa (interno)`);
  tick();
  return { started: true, intervalMs };
}

function getInboxPollStatus() {
  return {
    inboxPollEnabled: isInboxPollEnabled(),
    inboxPollRunning: Boolean(timer),
    inboxPollIntervalMs: getPollIntervalMs()
  };
}

module.exports = {
  toWebhookPayload,
  pickLatestUnprocessedInbound,
  collectWebhookPayloads,
  isInboxPollEnabled,
  getPollIntervalMs,
  startInboxPoller,
  stopInboxPoller,
  getInboxPollStatus
};
