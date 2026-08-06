const { isDisconnectError } = require('./openwaClient');

function getFailoverConfig() {
  const n = (k, d) => {
    const v = parseInt(process.env[k], 10);
    return Number.isFinite(v) && v >= 0 ? v : d;
  };
  return {
    healthRetries: n('SEND_FAILOVER_HEALTH_RETRIES', 2),
    localRetries: n('SEND_FAILOVER_LOCAL_RETRIES', 2),
    healthWaitMs: n('SEND_FAILOVER_HEALTH_WAIT_MS', 3000)
  };
}

/**
 * @param {unknown} errorOrMessage
 * @returns {'invalid'|'session_dead'|'transient'}
 */
function classifySendError(errorOrMessage) {
  const err =
    errorOrMessage && typeof errorOrMessage === 'object'
      ? errorOrMessage
      : { message: String(errorOrMessage || '') };
  const msg = String(err.message || err || '');
  if (/invalid|inválido|not on whatsapp|no está en whatsapp/i.test(msg)) {
    return 'invalid';
  }
  if (
    isDisconnectError(err) ||
    /banned|bannead|restrict|blocked by whatsapp|UNPAIRED|logged out/i.test(msg)
  ) {
    return 'session_dead';
  }
  return 'transient';
}

/**
 * @param {string[]} sessionOrder
 * @param {Map<string, Array>} queues
 */
function createFailoverContext(sessionOrder, queues) {
  return {
    sessionOrder: [...sessionOrder],
    queues,
    aliveSessionIds: new Set(sessionOrder),
    deadSessionIds: new Set(),
    rrCursor: 0,
    busySessions: new Set(sessionOrder)
  };
}

function markSessionDead(ctx, sessionId) {
  ctx.aliveSessionIds.delete(sessionId);
  ctx.deadSessionIds.add(sessionId);
}

/**
 * @param {object} ctx
 * @param {string[]} [triedSessionIds]
 * @returns {string|null}
 */
function pickNextAliveSession(ctx, triedSessionIds = []) {
  const tried = new Set(triedSessionIds || []);
  const order = ctx.sessionOrder;
  if (!order.length) return null;
  for (let i = 0; i < order.length; i++) {
    const idx = (ctx.rrCursor + i) % order.length;
    const id = order[idx];
    if (!ctx.aliveSessionIds.has(id)) continue;
    if (tried.has(id)) continue;
    ctx.rrCursor = (idx + 1) % order.length;
    return id;
  }
  return null;
}

/**
 * @param {object} ctx
 * @param {{ triedSessionIds?: string[], globalIndex?: number, contact?: object }} item
 * @param {string} fromSessionId
 * @returns {{ ok: true, toSessionId: string } | { ok: false, reason: string }}
 */
function requeueContact(ctx, item, fromSessionId) {
  if (!item.triedSessionIds) item.triedSessionIds = [];
  if (fromSessionId && !item.triedSessionIds.includes(fromSessionId)) {
    item.triedSessionIds.push(fromSessionId);
  }
  if (ctx.aliveSessionIds.size === 0) {
    return { ok: false, reason: 'no_healthy_sessions' };
  }
  const toSessionId = pickNextAliveSession(ctx, item.triedSessionIds);
  if (!toSessionId) {
    return { ok: false, reason: 'exhausted_sessions' };
  }
  const target = ctx.queues.get(toSessionId);
  if (!target) {
    return { ok: false, reason: 'no_healthy_sessions' };
  }
  target.push(item);
  return { ok: true, toSessionId };
}

/**
 * Marca la sesión muerta y reparte su cola pendiente en round-robin.
 * @returns {Array<{ item: object, toSessionId?: string, reason?: string }>}
 */
function drainSessionQueue(ctx, sessionId) {
  markSessionDead(ctx, sessionId);
  const queue = ctx.queues.get(sessionId) || [];
  const pending = queue.splice(0, queue.length);
  const moved = [];
  for (const item of pending) {
    const r = requeueContact(ctx, item, sessionId);
    if (r.ok) moved.push({ item, toSessionId: r.toSessionId });
    else moved.push({ item, reason: r.reason });
  }
  return moved;
}

module.exports = {
  getFailoverConfig,
  classifySendError,
  createFailoverContext,
  markSessionDead,
  pickNextAliveSession,
  requeueContact,
  drainSessionQueue
};
