const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const {
  slotKey,
  intervalsOverlap,
  timeToMinutes
} = require('./agendaAvailability');

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

function clearAvailabilityCache() {
  try {
    const agendaAvailability = require('./agendaAvailability');
    if (typeof agendaAvailability.clearSlotsCache === 'function') {
      agendaAvailability.clearSlotsCache();
    }
  } catch {
    /* ignore */
  }
}

/**
 * Keys de slots apartados por citas en espera de liga (pending_link).
 * @returns {Set<string>}
 */
function getHeldSlotKeys() {
  const keys = new Set();
  for (const item of listPending({ status: STATUS.PENDING_LINK })) {
    const key = slotKey(item.fecha, item.horaInicio, item.horaFin);
    if (key && key !== '||') keys.add(key);
  }
  return keys;
}

/**
 * Intervalos apartados (pending_link) para filtrar por solape.
 * @returns {Array<{ fecha: string, horaInicio: string, horaFin: string, id: string }>}
 */
function getHeldIntervals() {
  return listPending({ status: STATUS.PENDING_LINK })
    .map((item) => ({
      id: item.id,
      fecha: String(item.fecha || '').trim(),
      horaInicio: String(item.horaInicio || '').trim(),
      horaFin: String(item.horaFin || '').trim()
    }))
    .filter(
      (h) =>
        h.fecha &&
        h.horaInicio &&
        h.horaFin &&
        Number.isFinite(timeToMinutes(h.horaInicio)) &&
        Number.isFinite(timeToMinutes(h.horaFin))
    );
}

/**
 * @param {string} fecha
 * @param {string} horaInicio
 * @param {string} horaFin
 * @param {{ exceptId?: string, exceptTelefono?: string }} [opts]
 */
function findHoldOnSlot(fecha, horaInicio, horaFin, opts = {}) {
  return (
    listPending({ status: STATUS.PENDING_LINK }).find((item) => {
      if (opts.exceptId && item.id === opts.exceptId) return false;
      if (
        opts.exceptTelefono &&
        String(item.telefono || '').replace(/\D/g, '') ===
          String(opts.exceptTelefono || '').replace(/\D/g, '')
      ) {
        return false;
      }
      return intervalsOverlap(
        fecha,
        horaInicio,
        horaFin,
        item.fecha,
        item.horaInicio,
        item.horaFin
      );
    }) || null
  );
}

function isSlotHeld(fecha, horaInicio, horaFin, opts = {}) {
  return Boolean(findHoldOnSlot(fecha, horaInicio, horaFin, opts));
}

/**
 * @param {object} input
 */
function createPending(input) {
  const fecha = String(input.fecha || '').trim();
  const horaInicio = String(input.horaInicio || '').trim();
  const horaFin = String(input.horaFin || '').trim();
  const telefono = String(input.telefono || '').trim();

  const heldByOther = findHoldOnSlot(fecha, horaInicio, horaFin, {
    exceptTelefono: telefono
  });
  if (heldByOther) {
    const err = new Error(
      `Ese horario ya está apartado (cita pendiente ${heldByOther.id})`
    );
    err.status = 409;
    err.code = 'slot_held';
    err.heldBy = heldByOther.id;
    throw err;
  }

  const samePhoneSameSlot = listPending({ status: STATUS.PENDING_LINK }).find(
    (item) =>
      String(item.telefono || '').replace(/\D/g, '') ===
        telefono.replace(/\D/g, '') &&
      slotKey(item.fecha, item.horaInicio, item.horaFin) ===
        slotKey(fecha, horaInicio, horaFin)
  );
  if (samePhoneSameSlot) {
    return samePhoneSameSlot;
  }

  const store = readStore();
  const now = new Date().toISOString();
  const item = {
    id: newId(),
    telefono,
    chatId: input.chatId || null,
    contactName: input.contactName || null,
    cvId: input.cvId || null,
    cvUrl: input.cvUrl || null,
    fecha,
    horaInicio,
    horaFin,
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
  clearAvailabilityCache();
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

/**
 * Cita pendiente activa del lead (PENDING_LINK), si existe.
 * @param {string} telefono
 * @returns {object|null}
 */
function findPendingByPhone(telefono) {
  const key = String(telefono || '').replace(/\D/g, '');
  if (!key) return null;
  return (
    listPending({ status: STATUS.PENDING_LINK }).find(
      (item) => String(item.telefono || '').replace(/\D/g, '') === key
    ) || null
  );
}

/**
 * Cita confirmada del lead (CONFIRMED), la más reciente si hay varias.
 * @param {string} telefono
 * @returns {object|null}
 */
function findConfirmedByPhone(telefono) {
  const key = String(telefono || '').replace(/\D/g, '');
  if (!key) return null;
  const items = listPending({ status: STATUS.CONFIRMED }).filter(
    (item) => String(item.telefono || '').replace(/\D/g, '') === key
  );
  if (!items.length) return null;
  items.sort((a, b) => {
    const ta = Date.parse(a.confirmedAt || a.createdAt || 0) || 0;
    const tb = Date.parse(b.confirmedAt || b.createdAt || 0) || 0;
    return tb - ta;
  });
  return items[0];
}

/**
 * Actualiza horario/vendedor de una cita ya confirmada (reagendar).
 * @param {string} id
 * @param {{
 *   fecha: string,
 *   horaInicio: string,
 *   horaFin: string,
 *   label?: string|null,
 *   vendedorId?: string|null,
 *   gerenteEmail?: string|null,
 *   urlReunion?: string|null,
 *   candidateVendors?: object[]
 * }} patch
 */
function rescheduleConfirmed(id, patch = {}) {
  const current = getById(id);
  if (!current) {
    const err = new Error('Cita confirmada no encontrada');
    err.status = 404;
    throw err;
  }
  if (current.status !== STATUS.CONFIRMED) {
    const err = new Error('La cita no está confirmada');
    err.status = 409;
    throw err;
  }
  const next = {
    fecha: String(patch.fecha || current.fecha || '').trim(),
    horaInicio: String(patch.horaInicio || current.horaInicio || '').trim(),
    horaFin: String(patch.horaFin || current.horaFin || '').trim(),
    label:
      patch.label != null
        ? String(patch.label || '').trim() || null
        : current.label,
    vendedorId:
      patch.vendedorId != null
        ? String(patch.vendedorId || '').trim() || null
        : current.vendedorId,
    gerenteEmail:
      patch.gerenteEmail != null
        ? String(patch.gerenteEmail || '').trim().toLowerCase() || null
        : current.gerenteEmail,
    urlReunion:
      patch.urlReunion != null
        ? String(patch.urlReunion || '').trim()
        : current.urlReunion,
    rescheduledAt: new Date().toISOString()
  };
  if (Array.isArray(patch.candidateVendors)) {
    next.candidateVendors = patch.candidateVendors;
  }
  return updatePending(id, next);
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
  clearAvailabilityCache();
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
  findPendingByPhone,
  findConfirmedByPhone,
  updatePending,
  confirmPending,
  rescheduleConfirmed,
  cancelPending,
  getHeldSlotKeys,
  getHeldIntervals,
  findHoldOnSlot,
  isSlotHeld
};
