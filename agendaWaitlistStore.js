const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const DATA_DIR = path.join(__dirname, 'data');
const STORE_FILE_DEFAULT = path.join(DATA_DIR, 'agenda-waitlist.json');
let storeFileOverride = null;

function setStoreFileForTests(filePath) {
  storeFileOverride = filePath ? String(filePath) : null;
}

function storeFile() {
  return storeFileOverride || STORE_FILE_DEFAULT;
}

const STATUS = Object.freeze({
  WAITING: 'waiting',
  NOTIFIED_SLOTS: 'notified_slots',
  CANCELLED: 'cancelled',
  EXPIRED: 'expired',
  BOOKED: 'booked'
});

const ACTIVE = new Set([STATUS.WAITING]);

function ensureDataDir() {
  if (!fs.existsSync(DATA_DIR)) {
    fs.mkdirSync(DATA_DIR, { recursive: true });
  }
}

function readStore() {
  ensureDataDir();
  if (!fs.existsSync(storeFile())) {
    return { version: 1, items: [] };
  }
  try {
    const parsed = JSON.parse(fs.readFileSync(storeFile(), 'utf8'));
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
  fs.writeFileSync(storeFile(), JSON.stringify(data, null, 2), 'utf8');
}

function newId() {
  return crypto.randomBytes(12).toString('hex');
}

function phoneKey(phone) {
  return String(phone || '').replace(/\D/g, '') || String(phone || '').trim();
}

function isActive(item) {
  return item && ACTIVE.has(item.status);
}

function listWaiting() {
  return readStore().items.filter(isActive);
}

function findWaitingByPhone(telefono) {
  const key = phoneKey(telefono);
  if (!key) return null;
  return (
    listWaiting().find((item) => phoneKey(item.telefono) === key) || null
  );
}

/**
 * Un activo por teléfono. Si ya espera, actualiza fecha y datos de envío.
 */
function upsertWaiting(data = {}) {
  const telefono = phoneKey(data.telefono);
  const fecha = String(data.fecha || '').trim();
  if (!telefono || !fecha) return null;

  const store = readStore();
  const now = new Date().toISOString();
  const existing = store.items.find(
    (item) => isActive(item) && phoneKey(item.telefono) === telefono
  );

  if (existing) {
    if (fecha !== existing.fecha) {
      existing.notifiedEmptyAt = null;
      existing.notifiedSlotsAt = null;
    }
    existing.fecha = fecha;
    existing.updatedAt = now;
    existing.status = STATUS.WAITING;
    if (data.chatId) existing.chatId = String(data.chatId);
    if (data.openwaSessionId) existing.openwaSessionId = String(data.openwaSessionId);
    if (data.logicalSessionId) existing.logicalSessionId = String(data.logicalSessionId);
    if (data.contactName != null) existing.contactName = data.contactName;
    if (data.cvId != null) existing.cvId = data.cvId;
    if (data.label != null) existing.label = data.label;
    if (data.createdYmd && !existing.createdYmd) {
      existing.createdYmd = String(data.createdYmd).trim();
    }
    writeStore(store);
    return existing;
  }

  const item = {
    id: newId(),
    telefono,
    fecha,
    label: data.label || '',
    chatId: String(data.chatId || ''),
    openwaSessionId: String(data.openwaSessionId || ''),
    logicalSessionId: String(data.logicalSessionId || ''),
    contactName: data.contactName || '',
    cvId: data.cvId || '',
    status: STATUS.WAITING,
    createdAt: now,
    createdYmd: String(data.createdYmd || '').trim() || null,
    updatedAt: now,
    notifiedSlotsAt: null,
    notifiedEmptyAt: null
  };
  store.items.push(item);
  writeStore(store);
  return item;
}

function getById(id) {
  const want = String(id || '');
  if (!want) return null;
  return readStore().items.find((item) => item.id === want) || null;
}

function patchItem(id, patch) {
  const store = readStore();
  const item = store.items.find((x) => x.id === String(id || ''));
  if (!item) return null;
  Object.assign(item, patch, { updatedAt: new Date().toISOString() });
  writeStore(store);
  return item;
}

function markNotifiedSlots(id) {
  return patchItem(id, {
    status: STATUS.NOTIFIED_SLOTS,
    notifiedSlotsAt: new Date().toISOString()
  });
}

function markNotifiedEmpty(id) {
  return patchItem(id, {
    status: STATUS.WAITING,
    notifiedEmptyAt: new Date().toISOString()
  });
}

function cancelByPhone(telefono, reason = 'cancelled') {
  const key = phoneKey(telefono);
  if (!key) return 0;
  const status =
    reason === 'booked'
      ? STATUS.BOOKED
      : reason === 'expired'
        ? STATUS.EXPIRED
        : STATUS.CANCELLED;
  const store = readStore();
  let n = 0;
  for (const item of store.items) {
    if (!isActive(item) || phoneKey(item.telefono) !== key) continue;
    item.status = status;
    item.updatedAt = new Date().toISOString();
    n += 1;
  }
  if (n) writeStore(store);
  return n;
}

function expirePast(todayYmd) {
  const today = String(todayYmd || '').trim();
  if (!today) return 0;
  const store = readStore();
  let n = 0;
  for (const item of store.items) {
    if (!isActive(item)) continue;
    if (String(item.fecha || '') >= today) continue;
    item.status = STATUS.EXPIRED;
    item.updatedAt = new Date().toISOString();
    n += 1;
  }
  if (n) writeStore(store);
  return n;
}

module.exports = {
  STATUS,
  upsertWaiting,
  listWaiting,
  findWaitingByPhone,
  getById,
  markNotifiedSlots,
  markNotifiedEmpty,
  cancelByPhone,
  expirePast,
  setStoreFileForTests
};
