const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

// SEND_QUEUE_STORE_FILE solo para tests (aislar del archivo real).
const STORE_FILE = process.env.SEND_QUEUE_STORE_FILE || path.join(__dirname, 'data', 'send-queue.json');
const DATA_DIR = path.dirname(STORE_FILE);

const STATUS = Object.freeze({
  QUEUED: 'queued',
  SCHEDULED: 'scheduled',
  SENDING: 'sending',
  SENT: 'sent',
  CANCELLED: 'cancelled'
});

const ACTIVE_STATUSES = Object.freeze(['queued', 'scheduled', 'sending']);
const DEFAULT_SCHEDULE = Object.freeze({ morning: '10:30', afternoon: '16:00' });
const MAX_BATCHES_KEPT = 50;

function ensureDataDir() {
  if (!fs.existsSync(DATA_DIR)) {
    fs.mkdirSync(DATA_DIR, { recursive: true });
  }
}

function normalizeStore(raw) {
  const scheduleDefaults = {
    morning: String(raw?.scheduleDefaults?.morning || DEFAULT_SCHEDULE.morning),
    afternoon: String(raw?.scheduleDefaults?.afternoon || DEFAULT_SCHEDULE.afternoon)
  };

  let batches = [];
  if (Array.isArray(raw?.batches)) {
    batches = raw.batches.filter(Boolean);
  } else if (raw?.batch) {
    batches = [raw.batch];
  }

  return {
    version: 2,
    scheduleDefaults,
    batches,
    lastFinished: raw?.lastFinished && typeof raw.lastFinished === 'object' ? raw.lastFinished : null
  };
}

function readStore() {
  ensureDataDir();
  if (!fs.existsSync(STORE_FILE)) {
    return normalizeStore(null);
  }
  try {
    const parsed = JSON.parse(fs.readFileSync(STORE_FILE, 'utf8'));
    if (!parsed || typeof parsed !== 'object') {
      return normalizeStore(null);
    }
    return normalizeStore(parsed);
  } catch {
    return normalizeStore(null);
  }
}

function writeStore(data) {
  ensureDataDir();
  const normalized = normalizeStore(data);
  if (normalized.batches.length > MAX_BATCHES_KEPT) {
    const active = normalized.batches.filter((b) => ACTIVE_STATUSES.includes(b.status));
    const terminal = normalized.batches
      .filter((b) => !ACTIVE_STATUSES.includes(b.status))
      .slice(-(MAX_BATCHES_KEPT - active.length));
    normalized.batches = [...active, ...terminal];
  }
  // Escritura atómica: si el proceso muere a medias no se corrompe la cola (se perderían los lotes).
  const tmp = `${STORE_FILE}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(normalized, null, 2), 'utf8');
  fs.renameSync(tmp, STORE_FILE);
}

function newId() {
  return crypto.randomBytes(12).toString('hex');
}

function getScheduleDefaults() {
  return { ...readStore().scheduleDefaults };
}

function setScheduleDefaults({ morning, afternoon } = {}) {
  const store = readStore();
  if (morning != null) store.scheduleDefaults.morning = String(morning).trim();
  if (afternoon != null) store.scheduleDefaults.afternoon = String(afternoon).trim();
  writeStore(store);
  return { ...store.scheduleDefaults };
}

/** Parse "HH:mm" → { hours, minutes } or null */
function parseHm(value) {
  const m = String(value || '').trim().match(/^(\d{1,2}):(\d{2})$/);
  if (!m) return null;
  const hours = Number(m[1]);
  const minutes = Number(m[2]);
  if (hours < 0 || hours > 23 || minutes < 0 || minutes > 59) return null;
  return { hours, minutes };
}

/**
 * Next calendar day (local) at scheduleDefaults morning/afternoon.
 * @param {'morning'|'afternoon'} slot
 * @param {number} [dayOffset=1] 1 = tomorrow
 */
function resolveSlotScheduledAt(slot, dayOffset = 1) {
  const defaults = getScheduleDefaults();
  const hm = parseHm(slot === 'afternoon' ? defaults.afternoon : defaults.morning);
  if (!hm) {
    const err = new Error('Horario de slot inválido');
    err.status = 400;
    throw err;
  }
  const d = new Date();
  d.setDate(d.getDate() + Number(dayOffset || 1));
  d.setHours(hm.hours, hm.minutes, 0, 0);
  return d.toISOString();
}

function getBatches() {
  return readStore().batches;
}

function findBatch(store, id) {
  if (id == null) return null;
  return store.batches.find((b) => b && String(b.id) === String(id)) || null;
}

function getBatchById(id) {
  return findBatch(readStore(), id);
}

function getSendingBatch() {
  return getBatches().find((b) => b.status === STATUS.SENDING) || null;
}

function getDispatchableBatches() {
  return getBatches().filter(
    (b) => b.status === STATUS.QUEUED || b.status === STATUS.SCHEDULED
  );
}

/** Primary batch for backward-compat: sending → next due/queued → latest */
function getBatch() {
  const batches = getBatches();
  if (batches.length === 0) return null;
  const sending = batches.find((b) => b.status === STATUS.SENDING);
  if (sending) return sending;
  const next = pickNextDispatchBatch(batches);
  if (next) return next;
  return batches[batches.length - 1];
}

function isActive(batch) {
  if (!batch) return false;
  return ACTIVE_STATUSES.includes(batch.status);
}

function hasActiveBatches() {
  return getBatches().some(isActive);
}

function canEnqueue() {
  // Multi-lote: siempre se puede append (salvo tope interno en writeStore).
  return true;
}

function canDispatch() {
  if (getSendingBatch()) return false;
  return getDispatchableBatches().length > 0;
}

function buttonBurned() {
  return Boolean(getSendingBatch());
}

function getPublicState() {
  const batches = getBatches();
  return {
    batch: getBatch(),
    batches,
    scheduleDefaults: getScheduleDefaults(),
    canEnqueue: canEnqueue(),
    canDispatch: canDispatch(),
    buttonBurned: buttonBurned()
  };
}

function sanitizeCv(cv) {
  return {
    archivoOriginal: String(cv.archivoOriginal || '').trim(),
    nombre: String(cv.nombre || '').trim(),
    telefono: String(cv.telefono || '').trim(),
    mensajeIA: String(cv.mensajeIA || '').trim(),
    saludo: String(cv.saludo || '').trim(),
    cvId: String(cv.cvId || '').trim()
  };
}

function pickNextDispatchBatch(batches) {
  const list = batches || getBatches();
  const now = Date.now();
  const dueScheduled = list
    .filter(
      (b) =>
        b.status === STATUS.SCHEDULED &&
        b.scheduledAt &&
        Number.isFinite(Date.parse(b.scheduledAt)) &&
        Date.parse(b.scheduledAt) <= now
    )
    .sort((a, b) => Date.parse(a.scheduledAt) - Date.parse(b.scheduledAt));
  if (dueScheduled.length) return dueScheduled[0];

  const queued = list
    .filter((b) => b.status === STATUS.QUEUED)
    .sort((a, b) => String(a.createdAt).localeCompare(String(b.createdAt)));
  if (queued.length) return queued[0];

  const futureScheduled = list
    .filter((b) => b.status === STATUS.SCHEDULED && b.scheduledAt)
    .sort((a, b) => Date.parse(a.scheduledAt) - Date.parse(b.scheduledAt));
  return futureScheduled[0] || null;
}

/** Earliest future (or due) scheduled batch for timer arming */
function getNextScheduledBatch() {
  const scheduled = getBatches()
    .filter((b) => b.status === STATUS.SCHEDULED && b.scheduledAt)
    .sort((a, b) => Date.parse(a.scheduledAt) - Date.parse(b.scheduledAt));
  return scheduled[0] || null;
}

function enqueue({ cvs, selectedSessions, sessionWeights, scheduledAt, slot, label, channel }) {
  if (!canEnqueue()) {
    const err = new Error('No se puede encolar');
    err.status = 409;
    throw err;
  }

  if (!Array.isArray(cvs) || cvs.length === 0) {
    const err = new Error('Se requiere al menos un CV');
    err.status = 400;
    throw err;
  }

  let scheduledAtValue =
    scheduledAt != null && String(scheduledAt).trim() !== ''
      ? String(scheduledAt).trim()
      : null;

  let slotLabel = label || null;
  if (slot === 'morning' || slot === 'afternoon') {
    scheduledAtValue = resolveSlotScheduledAt(slot, 1);
    const defaults = getScheduleDefaults();
    const hm = slot === 'afternoon' ? defaults.afternoon : defaults.morning;
    slotLabel = slotLabel || (slot === 'afternoon' ? `Tarde ${hm}` : `Mañana ${hm}`);
  }

  if (scheduledAtValue) {
    const parsed = Date.parse(scheduledAtValue);
    if (!Number.isFinite(parsed)) {
      const err = new Error('scheduledAt inválido');
      err.status = 400;
      throw err;
    }
    if (parsed <= Date.now()) {
      const err = new Error('scheduledAt debe ser una fecha futura');
      err.status = 400;
      throw err;
    }
  }

  const now = new Date().toISOString();
  const rawChannel = String(channel || 'auto').trim().toLowerCase();
  const sendChannel =
    rawChannel === 'android' || rawChannel === 'openwa' ? rawChannel : 'auto';
  const batch = {
    id: newId(),
    status: scheduledAtValue ? STATUS.SCHEDULED : STATUS.QUEUED,
    cvs: cvs.map(sanitizeCv),
    selectedSessions: Array.isArray(selectedSessions)
      ? selectedSessions.map((s) => String(s))
      : [],
    sessionWeights:
      sessionWeights && typeof sessionWeights === 'object'
        ? { ...sessionWeights }
        : null,
    channel: sendChannel,
    scheduledAt: scheduledAtValue,
    slot: slot === 'morning' || slot === 'afternoon' ? slot : null,
    label: slotLabel,
    createdAt: now,
    total: cvs.length,
    sendingAt: null,
    sentAt: null,
    cancelledAt: null
  };

  const store = readStore();
  store.batches.push(batch);
  writeStore(store);
  return batch;
}

function markSending(id) {
  const store = readStore();
  if (getSendingBatch()) {
    const err = new Error('Ya hay un lote en sending');
    err.status = 409;
    throw err;
  }

  let batch = id != null ? findBatch(store, id) : pickNextDispatchBatch(store.batches);

  if (!batch) {
    const err = new Error('No hay lote pendiente para enviar');
    err.status = 409;
    throw err;
  }

  if (batch.status !== STATUS.QUEUED && batch.status !== STATUS.SCHEDULED) {
    const err = new Error('El lote no puede pasar a sending');
    err.status = 409;
    throw err;
  }

  batch.status = STATUS.SENDING;
  batch.sendingAt = new Date().toISOString();
  writeStore(store);
  return batch;
}

function markSent(id) {
  const store = readStore();
  const batch = id != null ? findBatch(store, id) : store.batches.find((b) => b.status === STATUS.SENDING);

  if (!batch) {
    const err = new Error('No hay lote en la cola');
    err.status = 409;
    throw err;
  }

  if (batch.status !== STATUS.SENDING) {
    const err = new Error('El lote no está en sending');
    err.status = 409;
    throw err;
  }

  batch.status = STATUS.SENT;
  batch.sentAt = new Date().toISOString();
  writeStore(store);
  return batch;
}

function cancel(id) {
  const store = readStore();
  let batch;
  if (id != null) {
    batch = findBatch(store, id);
  } else {
    const dispatchable = store.batches.filter(
      (b) => b.status === STATUS.QUEUED || b.status === STATUS.SCHEDULED
    );
    if (dispatchable.length === 1) batch = dispatchable[0];
    else if (dispatchable.length === 0) batch = null;
    else {
      const err = new Error('Indica batchId para cancelar');
      err.status = 400;
      throw err;
    }
  }

  if (!batch) {
    const err = new Error('No hay lote en la cola');
    err.status = 409;
    throw err;
  }

  if (batch.status !== STATUS.QUEUED && batch.status !== STATUS.SCHEDULED) {
    const err = new Error('Solo se puede cancelar un lote queued o scheduled');
    err.status = 409;
    throw err;
  }

  batch.status = STATUS.CANCELLED;
  batch.cancelledAt = new Date().toISOString();
  writeStore(store);
  return batch;
}

/** Quita sent/cancelled; conserva queued/scheduled/sending. */
function clearTerminalBatches() {
  const store = readStore();
  store.batches = store.batches.filter((b) => ACTIVE_STATUSES.includes(b.status));
  writeStore(store);
}

/**
 * Para toda la cola: cancela queued/scheduled/sending y deja el store vacío
 * para poder encolar de nuevo. El caller debe abortar el job vivo.
 */
function finishAll() {
  const store = readStore();
  const now = new Date().toISOString();
  const finished = [];
  for (const b of store.batches) {
    if (!ACTIVE_STATUSES.includes(b.status)) continue;
    b.status = STATUS.CANCELLED;
    b.cancelledAt = now;
    b.finishedByUser = true;
    finished.push({ ...b });
  }
  store.batches = [];
  writeStore(store);
  return { finished };
}

/**
 * Vacía la cola. Con force=true cierra sending huérfanos (caller valida que no hay job vivo).
 */
function clearBatch({ force = false } = {}) {
  const store = readStore();
  const hasSending = store.batches.some((b) => b.status === STATUS.SENDING);

  if (hasSending && !force) {
    const err = new Error('No se puede limpiar la cola durante un envío');
    err.status = 409;
    throw err;
  }

  if (force) {
    const now = new Date().toISOString();
    for (const b of store.batches) {
      if (b.status === STATUS.SENDING) {
        b.status = STATUS.SENT;
        b.sentAt = now;
        b.recoveredOrphan = true;
      }
    }
  }

  store.batches = [];
  writeStore(store);
}

// ---------------------------------------------------------------------------
// Progreso durable por lote: sobrevive reinicios y permite reanudar solo lo pendiente.
// ---------------------------------------------------------------------------

function phoneKey(telefono) {
  const digits = String(telefono || '').replace(/\D/g, '');
  return digits.length >= 10 ? digits.slice(-10) : digits;
}

function ensureProgress(batch) {
  if (!batch.progress || typeof batch.progress !== 'object') {
    batch.progress = {
      total: Array.isArray(batch.cvs) ? batch.cvs.length : 0,
      sent: 0,
      failed: 0,
      done: {},
      startedAt: null,
      lastResultAt: null,
      resumeCount: 0
    };
  }
  if (!batch.progress.done || typeof batch.progress.done !== 'object') batch.progress.done = {};
  return batch.progress;
}

/**
 * Inicia (o continúa) el progreso de un lote al empezar a enviarlo.
 * @param {string} id
 * @param {{ total?: number, skipped?: number }} [info]
 */
function startProgress(id, info = {}) {
  const store = readStore();
  const batch = findBatch(store, id);
  if (!batch) return null;
  const p = ensureProgress(batch);
  if (!p.startedAt) {
    p.startedAt = new Date().toISOString();
    if (Number.isFinite(info.total)) p.total = info.total;
  }
  p.lastError = null;
  writeStore(store);
  return p;
}

/**
 * Registra el resultado de un contacto (éxito o fallo). Idempotente por teléfono.
 * @param {string} id
 * @param {{ telefono?: string, success?: boolean, skipped?: boolean, error?: string, sessionId?: string, nombre?: string }} row
 */
function recordResult(id, row) {
  if (!id || !row) return null;
  const store = readStore();
  const batch = findBatch(store, id);
  if (!batch) return null;
  const p = ensureProgress(batch);
  const key = phoneKey(row.telefono) || `idx_${Object.keys(p.done).length}`;
  const prev = p.done[key];
  if (prev && (prev.ok || prev.skipped || prev.final)) return p; // ya resuelto
  const now = new Date().toISOString();
  const skipped = Boolean(row.skipped);
  const error = row.success ? undefined : String(row.error || 'error').slice(0, 160);
  p.lastResultAt = now;

  if (!row.success && !skipped && !isPermanentFailure(error)) {
    // Fallo temporal (línea caída, timeout, rate-limit): queda pendiente para el siguiente intento.
    p.retry = p.retry && typeof p.retry === 'object' ? p.retry : {};
    const attempts = (p.retry[key] && p.retry[key].attempts) || 0;
    if (attempts + 1 < MAX_TRANSIENT_ATTEMPTS) {
      p.retry[key] = { attempts: attempts + 1, lastError: error, at: now };
      writeStore(store);
      return p;
    }
    // Agotó intentos → fallo definitivo
  }

  p.done[key] = {
    ok: Boolean(row.success),
    skipped: skipped || undefined,
    final: true,
    at: now,
    sessionId: row.sessionId || null,
    error
  };
  if (p.retry) delete p.retry[key];
  if (skipped) p.skipped = (p.skipped || 0) + 1;
  else if (row.success) p.sent += 1;
  else p.failed += 1;
  writeStore(store);
  return p;
}

/** Intentos máximos por contacto ante fallos temporales (entre reanudaciones). */
const MAX_TRANSIENT_ATTEMPTS = 3;

/** Número inválido / sin WhatsApp: no tiene caso reintentar. */
function isPermanentFailure(error) {
  return /invalid_number|no.*whatsapp|not.*registered|n[uú]mero inv[aá]lido|ya_contactado/i.test(
    String(error || '')
  );
}

/** CVs del lote que aún no tienen resultado (ni enviado ni fallido). */
function getPendingCvs(batch) {
  if (!batch) return [];
  const done = (batch.progress && batch.progress.done) || {};
  return (Array.isArray(batch.cvs) ? batch.cvs : []).filter((cv) => !done[phoneKey(cv.telefono)]);
}

/**
 * Regresa un lote en sending a la cola para continuar solo con lo pendiente.
 * @param {string} id
 * @param {{ delayMs?: number, reason?: string, error?: string }} [opts]
 * @returns {{ batch: object, pending: number }|null}
 */
function requeueForResume(id, opts = {}) {
  const store = readStore();
  const batch = findBatch(store, id);
  if (!batch) return null;
  const p = ensureProgress(batch);
  const pending = getPendingCvs(batch).length;
  if (pending === 0) {
    batch.status = STATUS.SENT;
    batch.sentAt = new Date().toISOString();
    writeStore(store);
    return { batch, pending: 0 };
  }
  const delayMs = Math.max(0, Number(opts.delayMs) || 0);
  p.resumeCount = (p.resumeCount || 0) + 1;
  p.lastResumeReason = opts.reason || null;
  p.lastError = opts.error ? String(opts.error).slice(0, 300) : null;
  batch.status = STATUS.SCHEDULED;
  batch.scheduledAt = new Date(Date.now() + delayMs).toISOString();
  batch.resumePending = true;
  writeStore(store);
  return { batch, pending };
}

// ---------------------------------------------------------------------------
// Lote "en streaming": se envía mientras se le siguen agregando CVs (subida + IA).
// ---------------------------------------------------------------------------

/**
 * Crea un lote ya en sending, vacío y abierto a recibir CVs.
 * @param {{ selectedSessions: string[], sessionWeights?: object|null, channel?: string, label?: string }} opts
 */
function beginStreamingSend({ selectedSessions, sessionWeights = null, channel = 'auto', label = null } = {}) {
  if (getSendingBatch()) {
    const err = new Error('Ya hay un lote en sending');
    err.status = 409;
    throw err;
  }
  const now = new Date().toISOString();
  const rawChannel = String(channel || 'auto').trim().toLowerCase();
  const batch = {
    id: newId(),
    status: STATUS.SENDING,
    cvs: [],
    selectedSessions: Array.isArray(selectedSessions) ? selectedSessions.map(String) : [],
    sessionWeights: sessionWeights && typeof sessionWeights === 'object' ? { ...sessionWeights } : null,
    channel: rawChannel === 'android' || rawChannel === 'openwa' ? rawChannel : 'auto',
    scheduledAt: null,
    slot: null,
    label: label || 'Envío al instante',
    createdAt: now,
    total: 0,
    sendingAt: now,
    sentAt: null,
    cancelledAt: null,
    streaming: true,
    streamOpen: true
  };
  ensureProgress(batch).startedAt = now;
  const store = readStore();
  store.batches.push(batch);
  writeStore(store);
  return batch;
}

/**
 * Agrega CVs a un lote (sin repetir teléfono). Devuelve los que sí se agregaron.
 * @param {string} id
 * @param {Array} cvs
 * @returns {Array}
 */
function appendCvs(id, cvs) {
  const store = readStore();
  const batch = findBatch(store, id);
  if (!batch) return [];
  const seen = new Set((batch.cvs || []).map((c) => phoneKey(c.telefono)));
  const added = [];
  for (const cv of Array.isArray(cvs) ? cvs : []) {
    const clean = sanitizeCv(cv);
    const key = phoneKey(clean.telefono);
    if (!key || seen.has(key)) continue;
    seen.add(key);
    batch.cvs.push(clean);
    added.push(clean);
  }
  if (added.length) {
    batch.total = batch.cvs.length;
    ensureProgress(batch).total = batch.cvs.length;
    writeStore(store);
  }
  return added;
}

/** Ya no llegarán más CVs a este lote (terminó la subida). */
function closeStream(id) {
  const store = readStore();
  const batch = findBatch(store, id);
  if (!batch || !batch.streamOpen) return null;
  batch.streamOpen = false;
  batch.streamClosedAt = new Date().toISOString();
  writeStore(store);
  return batch;
}

/** Guarda el resumen del último lote terminado (los lotes terminados se limpian de la cola). */
function setLastFinished(summary) {
  const store = readStore();
  store.lastFinished = summary ? { ...summary, finishedAt: new Date().toISOString() } : null;
  writeStore(store);
}

function getLastFinished() {
  return readStore().lastFinished || null;
}

/**
 * Al arrancar: un lote en sending sin job vivo (reinicio/caída a medio envío).
 * Con resume=true se reprograma con lo pendiente; si no queda nada, se marca sent.
 * @param {{ resume?: boolean, delayMs?: number }} [opts]
 * @returns {number} lotes recuperados
 */
function recoverOrphanSending(opts = {}) {
  const store = readStore();
  const now = new Date().toISOString();
  let count = 0;
  for (const b of store.batches) {
    if (b.status !== STATUS.SENDING) continue;
    count += 1;
    if (b.streamOpen) b.streamOpen = false; // la subida que lo alimentaba murió con el proceso
    const pending = getPendingCvs(b).length;
    if (opts.resume && pending > 0) {
      const p = ensureProgress(b);
      p.resumeCount = (p.resumeCount || 0) + 1;
      p.lastResumeReason = 'restart';
      b.status = STATUS.SCHEDULED;
      b.scheduledAt = new Date(Date.now() + Math.max(0, Number(opts.delayMs) || 0)).toISOString();
      b.resumePending = true;
    } else {
      b.status = STATUS.SENT;
      b.sentAt = now;
      b.recoveredOrphan = true;
    }
  }
  if (count) writeStore(store);
  return count;
}

function beginDirectSend(payload) {
  if (getSendingBatch()) {
    const err = new Error('Ya hay un lote en sending');
    err.status = 409;
    throw err;
  }
  const batch = enqueue({ ...payload, scheduledAt: null, slot: null });
  return markSending(batch.id);
}

module.exports = {
  STATUS,
  ACTIVE_STATUSES,
  DEFAULT_SCHEDULE,
  getBatches,
  getBatch,
  getBatchById,
  getSendingBatch,
  getNextScheduledBatch,
  pickNextDispatchBatch,
  isActive,
  hasActiveBatches,
  canEnqueue,
  canDispatch,
  buttonBurned,
  getPublicState,
  getScheduleDefaults,
  setScheduleDefaults,
  resolveSlotScheduledAt,
  enqueue,
  markSending,
  markSent,
  cancel,
  finishAll,
  clearBatch,
  clearTerminalBatches,
  recoverOrphanSending,
  beginDirectSend,
  phoneKey,
  startProgress,
  recordResult,
  getPendingCvs,
  requeueForResume,
  setLastFinished,
  getLastFinished,
  beginStreamingSend,
  appendCvs,
  closeStream
};
