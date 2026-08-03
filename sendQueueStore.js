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

function ensureDataDir() {
  if (!fs.existsSync(DATA_DIR)) {
    fs.mkdirSync(DATA_DIR, { recursive: true });
  }
}

function readStore() {
  ensureDataDir();
  if (!fs.existsSync(STORE_FILE)) {
    return { version: 1, batch: null };
  }
  try {
    const parsed = JSON.parse(fs.readFileSync(STORE_FILE, 'utf8'));
    if (!parsed || typeof parsed !== 'object') {
      return { version: 1, batch: null };
    }
    return { version: 1, batch: parsed.batch ?? null };
  } catch {
    return { version: 1, batch: null };
  }
}

function writeStore(data) {
  ensureDataDir();
  fs.writeFileSync(STORE_FILE, JSON.stringify(data, null, 2), 'utf8');
}

function newId() {
  return crypto.randomBytes(12).toString('hex');
}

function getBatch() {
  return readStore().batch;
}

function isActive(batch) {
  if (!batch) return false;
  return ACTIVE_STATUSES.includes(batch.status);
}

function canEnqueue() {
  const batch = getBatch();
  if (!batch) return true;
  return batch.status === STATUS.SENT || batch.status === STATUS.CANCELLED;
}

function canDispatch() {
  const batch = getBatch();
  if (!batch) return false;
  return batch.status === STATUS.QUEUED || batch.status === STATUS.SCHEDULED;
}

function buttonBurned() {
  const batch = getBatch();
  if (!batch) return false;
  return batch.status === STATUS.SENDING || batch.status === STATUS.SENT;
}

function getPublicState() {
  return {
    batch: getBatch(),
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

function enqueue({ cvs, selectedSessions, sessionWeights, scheduledAt }) {
  if (!canEnqueue()) {
    const err = new Error('Ya hay un lote activo en la cola');
    err.status = 409;
    throw err;
  }

  if (!Array.isArray(cvs) || cvs.length === 0) {
    const err = new Error('Se requiere al menos un CV');
    err.status = 400;
    throw err;
  }

  const scheduledAtValue =
    scheduledAt != null && String(scheduledAt).trim() !== ''
      ? String(scheduledAt).trim()
      : null;

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
    scheduledAt: scheduledAtValue,
    createdAt: now,
    total: cvs.length,
    sendingAt: null,
    sentAt: null,
    cancelledAt: null
  };

  writeStore({ version: 1, batch });
  return batch;
}

function markSending(id) {
  const store = readStore();
  const batch = store.batch;

  if (!batch) {
    const err = new Error('No hay lote en la cola');
    err.status = 409;
    throw err;
  }

  if (id != null && String(id) !== batch.id) {
    const err = new Error('Lote no encontrado');
    err.status = 404;
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
  const batch = store.batch;

  if (!batch) {
    const err = new Error('No hay lote en la cola');
    err.status = 409;
    throw err;
  }

  if (id != null && String(id) !== batch.id) {
    const err = new Error('Lote no encontrado');
    err.status = 404;
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

function cancel() {
  const store = readStore();
  const batch = store.batch;

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

function clearBatch() {
  const batch = getBatch();
  if (batch?.status === STATUS.SENDING) {
    const err = new Error('No se puede limpiar la cola durante un envío');
    err.status = 409;
    throw err;
  }
  writeStore({ version: 1, batch: null });
}

function beginDirectSend(payload) {
  const batch = enqueue(payload);
  return markSending(batch.id);
}

module.exports = {
  STATUS,
  ACTIVE_STATUSES,
  getBatch,
  isActive,
  canEnqueue,
  canDispatch,
  buttonBurned,
  getPublicState,
  enqueue,
  markSending,
  markSent,
  cancel,
  clearBatch,
  beginDirectSend
};
