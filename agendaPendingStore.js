const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const DATA_DIR = path.join(__dirname, 'data');
const STORE_FILE = path.join(DATA_DIR, 'agenda-pending.json');

const STATUS = Object.freeze({
  PENDING_LINK: 'pending_link',
  CONFIRMED: 'confirmed',
  CANCELLED: 'cancelled'
});

function ensureDataDir() {
  if (!fs.existsSync(DATA_DIR)) {
    fs.mkdirSync(DATA_DIR, { recursive: true });
  }
}

function readStore() {
  ensureDataDir();
  if (!fs.existsSync(STORE_FILE)) {
    return { version: 1, items: [] };
  }
  try {
    const parsed = JSON.parse(fs.readFileSync(STORE_FILE, 'utf8'));
    if (!parsed || !Array.isArray(parsed.items)) {
      return { version: 1, items: [] };
    }
    return parsed;
  } catch {
    return { version: 1, items: [] };
  }
}

function writeStore(data) {
  ensureDataDir();
  fs.writeFileSync(STORE_FILE, JSON.stringify(data, null, 2), 'utf8');
}

function newId() {
  return crypto.randomBytes(12).toString('hex');
}

/**
 * @param {object} input
 */
function createPending(input) {
  const store = readStore();
  const now = new Date().toISOString();
  const item = {
    id: newId(),
    telefono: String(input.telefono || '').trim(),
    chatId: input.chatId || null,
    contactName: input.contactName || null,
    cvId: input.cvId || null,
    cvUrl: input.cvUrl || null,
    fecha: String(input.fecha || '').trim(),
    horaInicio: String(input.horaInicio || '').trim(),
    horaFin: String(input.horaFin || '').trim(),
    label: input.label || null,
    logicalSessionId: input.logicalSessionId || null,
    openwaSessionId: input.openwaSessionId || null,
    candidateVendors: Array.isArray(input.candidateVendors)
      ? input.candidateVendors
      : [],
    vendedorId: null,
    gerenteEmail: null,
    urlReunion: null,
    status: STATUS.PENDING_LINK,
    createdAt: now,
    confirmedAt: null,
    cancelledAt: null,
    panelReunionId: null
  };
  store.items.unshift(item);
  writeStore(store);
  return item;
}

/**
 * @param {{ status?: string|string[] }} [filter]
 */
function listPending(filter = {}) {
  const store = readStore();
  let items = store.items.slice();
  if (filter.status) {
    const wanted = new Set(
      Array.isArray(filter.status) ? filter.status : [filter.status]
    );
    items = items.filter((i) => wanted.has(i.status));
  }
  return items;
}

function getById(id) {
  const sid = String(id || '').trim();
  if (!sid) return null;
  return readStore().items.find((i) => i.id === sid) || null;
}

/**
 * @param {string} id
 * @param {object} patch
 */
function updatePending(id, patch) {
  const store = readStore();
  const idx = store.items.findIndex((i) => i.id === String(id));
  if (idx < 0) {
    const err = new Error('Cita pendiente no encontrada');
    err.status = 404;
    throw err;
  }
  store.items[idx] = { ...store.items[idx], ...patch };
  writeStore(store);
  return store.items[idx];
}

function confirmPending(id, { vendedorId, urlReunion, gerenteEmail, panelReunionId }) {
  return updatePending(id, {
    status: STATUS.CONFIRMED,
    vendedorId: String(vendedorId || '').trim(),
    urlReunion: String(urlReunion || '').trim(),
    gerenteEmail: String(gerenteEmail || '').trim().toLowerCase() || null,
    panelReunionId: panelReunionId || null,
    confirmedAt: new Date().toISOString()
  });
}

function cancelPending(id) {
  return updatePending(id, {
    status: STATUS.CANCELLED,
    cancelledAt: new Date().toISOString()
  });
}

module.exports = {
  STATUS,
  createPending,
  listPending,
  getById,
  updatePending,
  confirmPending,
  cancelPending
};
