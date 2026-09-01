const fs = require('fs');
const path = require('path');

const DATA_DIR = path.join(__dirname, 'data');
const STORE_FILE = path.join(DATA_DIR, 'agenda-awaiting-cv.json');
const DEFAULT_TTL_MS = 48 * 60 * 60 * 1000;

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
 * Guarda el horario elegido mientras el lead sube su CV.
 * @param {string} phone
 * @param {object} data
 * @param {number} [ttlMs]
 */
function rememberAwaiting(phone, data, ttlMs = DEFAULT_TTL_MS) {
  const key = phoneKey(phone);
  if (!key || !data) return null;
  const store = readStore();
  store.byPhone[key] = {
    ...data,
    createdAt: new Date().toISOString(),
    expiresAt: Date.now() + (Number(ttlMs) || DEFAULT_TTL_MS)
  };
  writeStore(store);
  return store.byPhone[key];
}

/**
 * @param {string} phone
 */
function getAwaiting(phone) {
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

function clearAwaiting(phone) {
  const key = phoneKey(phone);
  if (!key) return;
  const store = readStore();
  if (store.byPhone[key]) {
    delete store.byPhone[key];
    writeStore(store);
  }
}

module.exports = {
  rememberAwaiting,
  getAwaiting,
  clearAwaiting,
  phoneKey
};
