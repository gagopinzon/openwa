const fs = require('fs');
const path = require('path');

const DATA_DIR = path.join(__dirname, 'data');
const STORE_FILE = path.join(DATA_DIR, 'agenda-offers.json');
const DEFAULT_TTL_MS = 24 * 60 * 60 * 1000;

function ensureDataDir() {
  if (!fs.existsSync(DATA_DIR)) {
    fs.mkdirSync(DATA_DIR, { recursive: true });
  }
}

function readStore() {
  ensureDataDir();
  if (!fs.existsSync(STORE_FILE)) return { version: 1, byPhone: {} };
  try {
    const parsed = JSON.parse(fs.readFileSync(STORE_FILE, 'utf8'));
    if (!parsed || typeof parsed.byPhone !== 'object') {
      return { version: 1, byPhone: {} };
    }
    return parsed;
  } catch {
    return { version: 1, byPhone: {} };
  }
}

function writeStore(data) {
  ensureDataDir();
  fs.writeFileSync(STORE_FILE, JSON.stringify(data, null, 2), 'utf8');
}

function phoneKey(phone) {
  return String(phone || '').replace(/\D/g, '') || String(phone || '').trim();
}

/**
 * @param {string} phone
 * @param {Array<object>} slots full slots with candidates
 * @param {number} [ttlMs]
 */
function rememberOffer(phone, slots, ttlMs = DEFAULT_TTL_MS) {
  const key = phoneKey(phone);
  if (!key) return null;
  const store = readStore();
  const expiresAt = Date.now() + (Number(ttlMs) || DEFAULT_TTL_MS);
  store.byPhone[key] = {
    slots: Array.isArray(slots) ? slots : [],
    proposedTimes: [],
    proposedSlot: null,
    createdAt: new Date().toISOString(),
    expiresAt
  };
  writeStore(store);
  return store.byPhone[key];
}

/**
 * Recuerda la hora que el bot acaba de proponer ("¿te funciona a las 17:00?").
 * @param {string} phone
 * @param {string[]} times
 */
function rememberProposedTimes(phone, times) {
  const key = phoneKey(phone);
  if (!key) return null;
  const store = readStore();
  const entry = store.byPhone[key];
  if (!entry) return null;
  entry.proposedTimes = (Array.isArray(times) ? times : [])
    .map((t) => String(t || '').trim())
    .filter((t) => /^\d{2}:\d{2}$/.test(t));
  writeStore(store);
  return entry;
}

/**
 * Slot que el bot acaba de confirmar ("Perfecto, te agendo a las 17:00 hoy, ¿te queda?").
 * El "sí" posterior debe usar este slot, no otro del mismo horario en otro día.
 * @param {string} phone
 * @param {object} slot
 */
function rememberProposedSlot(phone, slot) {
  const key = phoneKey(phone);
  if (!key || !slot) return null;
  const store = readStore();
  const entry = store.byPhone[key];
  if (!entry) return null;
  const hora = String(slot.horaInicio || '').trim();
  entry.proposedSlot = {
    fecha: slot.fecha,
    horaInicio: slot.horaInicio,
    horaFin: slot.horaFin,
    label: slot.label || null,
    candidates: slot.candidates
  };
  entry.proposedTimes = /^\d{2}:\d{2}$/.test(hora) ? [hora] : [];
  writeStore(store);
  return entry;
}

/**
 * @param {string} phone
 * @returns {{ slots: object[], expiresAt: number } | null}
 */
function getOffer(phone) {
  const key = phoneKey(phone);
  if (!key) return null;
  const store = readStore();
  const entry = store.byPhone[key];
  if (!entry) return null;
  if (Number(entry.expiresAt) <= Date.now()) {
    delete store.byPhone[key];
    writeStore(store);
    return null;
  }
  return entry;
}

function clearOffer(phone) {
  const key = phoneKey(phone);
  if (!key) return;
  const store = readStore();
  if (store.byPhone[key]) {
    delete store.byPhone[key];
    writeStore(store);
  }
}

module.exports = {
  rememberOffer,
  rememberProposedTimes,
  rememberProposedSlot,
  getOffer,
  clearOffer,
  phoneKey
};
