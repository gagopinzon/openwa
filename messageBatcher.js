/**
 * Agrupa mensajes entrantes del mismo chat antes de enviarlos a la IA.
 * - 1.er mensaje del lote → espera FIRST_MS (default 30s)
 * - Cada mensaje adicional reinicia NEXT_MS (default 20s), sin tope
 * - immediate=true (p. ej. documento/CV) → flush al instante
 */

/** @typedef {{ items: object[], timer: NodeJS.Timeout|null, onFlush: (items: object[]) => Promise<*> }} BatchEntry */

/** @type {Map<string, BatchEntry>} */
const batches = new Map();

function envFlag(name) {
  const v = String(process.env[name] || '').trim().toLowerCase();
  return v === 'true' || v === '1' || v === 'yes' || v === 'on';
}

function skipBatchDelays() {
  return envFlag('AUTO_REPLY_SKIP_DELAYS');
}

function getFirstDelayMs() {
  if (skipBatchDelays()) return 0;
  const v = parseInt(process.env.AUTO_REPLY_BATCH_FIRST_MS, 10);
  return Number.isFinite(v) && v >= 0 ? v : 30000;
}

function getNextDelayMs() {
  if (skipBatchDelays()) return 0;
  const v = parseInt(process.env.AUTO_REPLY_BATCH_NEXT_MS, 10);
  return Number.isFinite(v) && v >= 0 ? v : 20000;
}

function getBusyRetryMs() {
  const v = parseInt(process.env.AUTO_REPLY_BATCH_BUSY_RETRY_MS, 10);
  return Number.isFinite(v) && v >= 0 ? v : 1000;
}

/**
 * Une cuerpos de texto del lote (uno por línea).
 * @param {Array<{ body?: string }>} items
 * @returns {string}
 */
function combineBatchBodies(items) {
  return (items || [])
    .map((i) => String((i && i.body) || '').trim())
    .filter(Boolean)
    .join('\n');
}

/**
 * @param {string} key
 */
function clearTimer(key) {
  const entry = batches.get(key);
  if (!entry || !entry.timer) return;
  clearTimeout(entry.timer);
  entry.timer = null;
}

/**
 * @param {string} key
 * @param {number} delayMs
 */
function scheduleFlush(key, delayMs) {
  const entry = batches.get(key);
  if (!entry) return;
  clearTimer(key);
  const wait = Math.max(0, delayMs);
  if (wait === 0) {
    void flushKey(key);
    return;
  }
  entry.timer = setTimeout(() => {
    entry.timer = null;
    void flushKey(key);
  }, wait);
}

/**
 * @param {string} key
 * @returns {Promise<*>}
 */
async function flushKey(key) {
  const entry = batches.get(key);
  if (!entry || !entry.items.length) {
    if (entry) batches.delete(key);
    return null;
  }
  clearTimer(key);
  const items = entry.items.splice(0, entry.items.length);
  const onFlush = entry.onFlush;
  batches.delete(key);

  if (typeof onFlush !== 'function') {
    console.warn(`[message-batcher] flush sin onFlush key=${key}`);
    return null;
  }

  try {
    return await onFlush(items);
  } catch (err) {
    console.error(
      `[message-batcher] flush error key=${key}:`,
      err && err.message ? err.message : err
    );
    return { handled: false, reason: 'batch_flush_error', error: String(err && err.message) };
  }
}

/**
 * Encola un mensaje para el chat `key`.
 * @param {object} opts
 * @param {string} opts.key
 * @param {object} opts.item
 * @param {(items: object[]) => Promise<*>} opts.onFlush
 * @param {boolean} [opts.immediate] — flush ya (documento/CV)
 * @param {boolean} [opts.skipDelay] — sin espera (testMode / skip delays)
 * @returns {Promise<{ queued: boolean, flushed: boolean, count: number, delayMs: number, result?: * }>}
 */
async function enqueue({ key, item, onFlush, immediate = false, skipDelay = false }) {
  const batchKey = String(key || '').trim();
  if (!batchKey) {
    throw new Error('messageBatcher.enqueue: key requerida');
  }
  if (typeof onFlush !== 'function') {
    throw new Error('messageBatcher.enqueue: onFlush requerida');
  }

  let entry = batches.get(batchKey);
  if (!entry) {
    entry = { items: [], timer: null, onFlush };
    batches.set(batchKey, entry);
  }
  entry.onFlush = onFlush;
  entry.items.push(item);
  const count = entry.items.length;

  const shouldFlushNow = Boolean(immediate) || Boolean(skipDelay) || skipBatchDelays();
  if (shouldFlushNow) {
    const result = await flushKey(batchKey);
    return { queued: true, flushed: true, count, delayMs: 0, result };
  }

  const delayMs = count === 1 ? getFirstDelayMs() : getNextDelayMs();
  scheduleFlush(batchKey, delayMs);
  console.log(
    `[message-batcher] queued key=${batchKey} count=${count} delayMs=${delayMs}` +
      (immediate ? ' immediate' : '')
  );
  return { queued: true, flushed: false, count, delayMs };
}

/**
 * Vuelve a encolar items (p. ej. chat ocupado) y reintenta pronto.
 * @param {string} key
 * @param {object[]} items
 * @param {(items: object[]) => Promise<*>} onFlush
 * @param {number} [delayMs]
 * @param {{ front?: boolean }} [opts] — front=true preserva orden si ya hay mensajes nuevos
 */
function requeue(key, items, onFlush, delayMs = getBusyRetryMs(), opts = {}) {
  const batchKey = String(key || '').trim();
  if (!batchKey || !Array.isArray(items) || !items.length) return;

  let entry = batches.get(batchKey);
  if (!entry) {
    entry = { items: [], timer: null, onFlush };
    batches.set(batchKey, entry);
  }
  if (typeof onFlush === 'function') entry.onFlush = onFlush;
  if (opts.front) entry.items.unshift(...items);
  else entry.items.push(...items);
  scheduleFlush(batchKey, delayMs);
  console.log(
    `[message-batcher] requeue key=${batchKey} count=${entry.items.length} delayMs=${delayMs}`
  );
}

/** @returns {number} */
function pendingCount(key) {
  const entry = batches.get(String(key || ''));
  return entry ? entry.items.length : 0;
}

/**
 * Cancela el lote pendiente de un chat (timer + items). No afecta un flush ya en curso.
 * @param {string} key
 * @returns {number} cantidad de items descartados
 */
function cancelKey(key) {
  const batchKey = String(key || '').trim();
  if (!batchKey) return 0;
  const entry = batches.get(batchKey);
  if (!entry) return 0;
  clearTimer(batchKey);
  const count = entry.items.length;
  entry.items.length = 0;
  batches.delete(batchKey);
  if (count > 0) {
    console.log(`[message-batcher] cancelled key=${batchKey} discarded=${count}`);
  }
  return count;
}

function resetForTests() {
  for (const key of [...batches.keys()]) {
    clearTimer(key);
    batches.delete(key);
  }
}

module.exports = {
  enqueue,
  requeue,
  flushKey,
  cancelKey,
  combineBatchBodies,
  getFirstDelayMs,
  getNextDelayMs,
  getBusyRetryMs,
  skipBatchDelays,
  pendingCount,
  resetForTests
};
