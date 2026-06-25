const fs = require('fs');
const path = require('path');

const DATA_DIR = path.join(__dirname, 'data');
const STORE_FILE = path.join(DATA_DIR, 'sessions.json');

/** @typedef {{ id: string, label: string, openwaSessionId: string, createdAt?: string }} StoredSession */

function ensureDataDir() {
  if (!fs.existsSync(DATA_DIR)) {
    fs.mkdirSync(DATA_DIR, { recursive: true });
  }
}

function readStore() {
  ensureDataDir();
  if (!fs.existsSync(STORE_FILE)) {
    return { version: 1, sessions: [] };
  }
  try {
    const raw = fs.readFileSync(STORE_FILE, 'utf8');
    const parsed = JSON.parse(raw);
    if (!parsed || !Array.isArray(parsed.sessions)) {
      return { version: 1, sessions: [] };
    }
    return parsed;
  } catch {
    return { version: 1, sessions: [] };
  }
}

function writeStore(data) {
  ensureDataDir();
  fs.writeFileSync(STORE_FILE, JSON.stringify(data, null, 2), 'utf8');
}

function nextLogicalId(sessions) {
  const used = new Set(sessions.map((s) => s.id));
  let n = 1;
  while (used.has(`session${n}`)) n += 1;
  return `session${n}`;
}

/**
 * Importa sesiones desde variables OPENWA_SESSION_* si el archivo está vacío.
 */
function migrateFromEnvIfEmpty() {
  const store = readStore();
  if (store.sessions.length > 0) return store.sessions;

  /** @type {StoredSession[]} */
  const imported = [];
  const envPairs = [
    ['session1', 'OPENWA_SESSION_SESSION1'],
    ['session2', 'OPENWA_SESSION_SESSION2'],
    ['session3', 'OPENWA_SESSION_SESSION3']
  ];

  for (const [logicalId, envKey] of envPairs) {
    const val = process.env[envKey];
    if (val && String(val).trim()) {
      imported.push({
        id: logicalId,
        label: `Sesión ${logicalId.replace('session', '')}`,
        openwaSessionId: String(val).trim(),
        createdAt: new Date().toISOString()
      });
    }
  }

  if (imported.length === 0) {
    const fallback = process.env.OPENWA_SESSION_ID;
    if (fallback && String(fallback).trim()) {
      imported.push({
        id: 'session1',
        label: 'Sesión 1',
        openwaSessionId: String(fallback).trim(),
        createdAt: new Date().toISOString()
      });
    }
  }

  if (imported.length > 0) {
    writeStore({ version: 1, sessions: imported });
    console.log(`Sesiones importadas desde .env → ${STORE_FILE} (${imported.length})`);
  }

  return imported;
}

function getAllSessions() {
  migrateFromEnvIfEmpty();
  return readStore().sessions;
}

function getLogicalSessionIds() {
  return getAllSessions().map((s) => s.id);
}

function getSession(logicalId) {
  return getAllSessions().find((s) => s.id === logicalId) || null;
}

function resolveOpenWASessionId(logicalId = 'default') {
  const id = String(logicalId || 'default');
  const session = getSession(id);
  if (session && session.openwaSessionId) {
    return String(session.openwaSessionId).trim();
  }

  // Respaldo legacy por .env (sin guardar en archivo)
  const key = id.toUpperCase().replace(/[^A-Z0-9]/g, '_');
  const envKey = `OPENWA_SESSION_${key}`;
  const mapped = process.env[envKey];
  if (mapped && String(mapped).trim()) {
    return String(mapped).trim();
  }
  const fallback = process.env.OPENWA_SESSION_ID;
  if (fallback && String(fallback).trim()) {
    return String(fallback).trim();
  }

  throw new Error(
    `No hay sesión configurada para "${id}". ` +
      'Agrega la sesión en la sección "Sesiones WhatsApp" de la interfaz.'
  );
}

/**
 * @param {{ openwaSessionId: string, label?: string, id?: string }} input
 */
function addSession(input) {
  const openwaSessionId = String(input.openwaSessionId || '').trim();
  if (!openwaSessionId) {
    throw new Error('openwaSessionId es obligatorio');
  }

  const store = readStore();
  const duplicate = store.sessions.find(
    (s) => s.openwaSessionId.toLowerCase() === openwaSessionId.toLowerCase()
  );
  if (duplicate) {
    throw new Error(`La sesión OpenWA "${openwaSessionId}" ya está registrada como "${duplicate.label}"`);
  }

  const logicalId = input.id ? String(input.id).trim() : nextLogicalId(store.sessions);
  if (store.sessions.some((s) => s.id === logicalId)) {
    throw new Error(`El id lógico "${logicalId}" ya existe`);
  }

  const session = {
    id: logicalId,
    label: String(input.label || `Sesión ${store.sessions.length + 1}`).trim(),
    openwaSessionId,
    createdAt: new Date().toISOString()
  };

  store.sessions.push(session);
  writeStore(store);
  return session;
}

/**
 * @param {string} logicalId
 * @param {{ label?: string, openwaSessionId?: string }} patch
 */
function updateSession(logicalId, patch) {
  const store = readStore();
  const idx = store.sessions.findIndex((s) => s.id === logicalId);
  if (idx === -1) {
    throw new Error(`Sesión "${logicalId}" no encontrada`);
  }

  if (patch.openwaSessionId != null) {
    const openwaSessionId = String(patch.openwaSessionId).trim();
    if (!openwaSessionId) throw new Error('openwaSessionId no puede estar vacío');
    const dup = store.sessions.find(
      (s, i) =>
        i !== idx && s.openwaSessionId.toLowerCase() === openwaSessionId.toLowerCase()
    );
    if (dup) {
      throw new Error(`La sesión OpenWA "${openwaSessionId}" ya está en uso`);
    }
    store.sessions[idx].openwaSessionId = openwaSessionId;
  }

  if (patch.label != null) {
    const label = String(patch.label).trim();
    if (!label) throw new Error('label no puede estar vacío');
    store.sessions[idx].label = label;
  }

  writeStore(store);
  return store.sessions[idx];
}

function removeSession(logicalId) {
  const store = readStore();
  const before = store.sessions.length;
  store.sessions = store.sessions.filter((s) => s.id !== logicalId);
  if (store.sessions.length === before) {
    throw new Error(`Sesión "${logicalId}" no encontrada`);
  }
  writeStore(store);
  return true;
}

/**
 * Agrega varias sesiones OpenWA que aún no estén registradas.
 * @param {Array<{ id: string, name?: string, label?: string, status?: string }>} openwaSessions
 */
function importOpenWASessions(openwaSessions) {
  const existing = new Set(
    getAllSessions().map((s) => s.openwaSessionId.toLowerCase())
  );
  /** @type {StoredSession[]} */
  const added = [];

  for (const row of openwaSessions) {
    const openwaSessionId = String(row.id || '').trim();
    if (!openwaSessionId || existing.has(openwaSessionId.toLowerCase())) continue;

    const label =
      String(row.label || row.name || row.profileName || openwaSessionId).trim() ||
      openwaSessionId;

    const session = addSession({ openwaSessionId, label });
    existing.add(openwaSessionId.toLowerCase());
    added.push(session);
  }

  return added;
}

module.exports = {
  getAllSessions,
  getLogicalSessionIds,
  getSession,
  resolveOpenWASessionId,
  addSession,
  updateSession,
  removeSession,
  importOpenWASessions,
  migrateFromEnvIfEmpty
};
