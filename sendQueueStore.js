const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const DATA_DIR = path.join(__dirname, 'data');
const STORE_FILE = path.join(DATA_DIR, 'send-queue.json');

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
    batches
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
  fs.writeFileSync(STORE_FILE, JSON.stringify(normalized, null, 2), 'utf8');
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

/** Marca sending huérfanos como sent. Devuelve cuántos recuperó. */
function recoverOrphanSending() {
  const store = readStore();
  const now = new Date().toISOString();
  let count = 0;
  for (const b of store.batches) {
    if (b.status === STATUS.SENDING) {
      b.status = STATUS.SENT;
      b.sentAt = now;
      b.recoveredOrphan = true;
      count += 1;
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
  clearBatch,
  clearTerminalBatches,
  recoverOrphanSending,
  beginDirectSend
};
