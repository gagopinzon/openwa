const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const DATA_DIR = path.join(__dirname, 'data');
const STORE_FILE = path.join(DATA_DIR, 'users.json');

const ACCESS_LEVELS = Object.freeze({
  VIEW: 'view',
  CONTROL: 'control'
});

/**
 * @typedef {'view'|'control'} SessionAccess
 * @typedef {{
 *   id: string,
 *   username: string,
 *   passwordHash: string,
 *   role: 'user',
 *   permissions: Record<string, SessionAccess>,
 *   gerenteEmail?: string,
 *   createdAt: string,
 *   updatedAt: string
 * }} StoredUser
 */

const SUPER_PROFILE_FILE = path.join(DATA_DIR, 'super-profile.json');
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

function ensureDataDir() {
  if (!fs.existsSync(DATA_DIR)) {
    fs.mkdirSync(DATA_DIR, { recursive: true });
  }
}

function readStore() {
  ensureDataDir();
  if (!fs.existsSync(STORE_FILE)) {
    return { version: 1, users: [] };
  }
  try {
    const raw = fs.readFileSync(STORE_FILE, 'utf8');
    const parsed = JSON.parse(raw);
    if (!parsed || !Array.isArray(parsed.users)) {
      return { version: 1, users: [] };
    }
    return parsed;
  } catch {
    return { version: 1, users: [] };
  }
}

function writeStore(data) {
  ensureDataDir();
  fs.writeFileSync(STORE_FILE, JSON.stringify(data, null, 2), 'utf8');
}

function hashPassword(password) {
  const salt = crypto.randomBytes(16).toString('hex');
  const hash = crypto.scryptSync(String(password), salt, 64).toString('hex');
  return `${salt}:${hash}`;
}

function verifyPassword(password, stored) {
  if (!stored || typeof stored !== 'string' || !stored.includes(':')) return false;
  const [salt, expected] = stored.split(':');
  if (!salt || !expected) return false;
  const hash = crypto.scryptSync(String(password), salt, 64).toString('hex');
  if (hash.length !== expected.length) return false;
  return crypto.timingSafeEqual(Buffer.from(hash), Buffer.from(expected));
}

function normalizeUsername(username) {
  return String(username || '').trim().toLowerCase();
}

function sanitizePermissions(permissions) {
  /** @type {Record<string, SessionAccess>} */
  const out = {};
  if (!permissions || typeof permissions !== 'object') return out;

  for (const [sessionId, level] of Object.entries(permissions)) {
    const id = String(sessionId || '').trim();
    if (!id) continue;
    const access = String(level || '').trim().toLowerCase();
    if (access === ACCESS_LEVELS.VIEW || access === ACCESS_LEVELS.CONTROL) {
      out[id] = /** @type {SessionAccess} */ (access);
    }
  }
  return out;
}

/**
 * Normaliza y valida correo de gerente (panel). Vacío permitido.
 * @param {unknown} value
 * @returns {string}
 */
function sanitizeGerenteEmail(value) {
  const email = String(value == null ? '' : value).trim().toLowerCase();
  if (!email) return '';
  if (!EMAIL_RE.test(email)) {
    throw new Error('El correo del gerente no es válido');
  }
  return email;
}

function readSuperProfile() {
  ensureDataDir();
  if (!fs.existsSync(SUPER_PROFILE_FILE)) {
    return { gerenteEmail: '' };
  }
  try {
    const raw = fs.readFileSync(SUPER_PROFILE_FILE, 'utf8');
    const parsed = JSON.parse(raw);
    return {
      gerenteEmail: String(parsed?.gerenteEmail || '').trim().toLowerCase()
    };
  } catch {
    return { gerenteEmail: '' };
  }
}

function writeSuperProfile(profile) {
  ensureDataDir();
  fs.writeFileSync(
    SUPER_PROFILE_FILE,
    JSON.stringify(
      {
        gerenteEmail: String(profile?.gerenteEmail || '').trim().toLowerCase()
      },
      null,
      2
    ),
    'utf8'
  );
}

function getSuperGerenteEmail() {
  return readSuperProfile().gerenteEmail || '';
}

function setSuperGerenteEmail(email) {
  const gerenteEmail = sanitizeGerenteEmail(email);
  writeSuperProfile({ gerenteEmail });
  return gerenteEmail;
}

function publicUser(user) {
  if (!user) return null;
  return {
    id: user.id,
    username: user.username,
    role: user.role,
    permissions: { ...(user.permissions || {}) },
    gerenteEmail: String(user.gerenteEmail || '').trim(),
    createdAt: user.createdAt,
    updatedAt: user.updatedAt
  };
}

function getAllUsers() {
  return readStore().users.map(publicUser);
}

function findUserByUsername(username) {
  const key = normalizeUsername(username);
  if (!key) return null;
  return readStore().users.find((u) => normalizeUsername(u.username) === key) || null;
}

function findUserById(id) {
  const key = String(id || '').trim();
  if (!key) return null;
  return readStore().users.find((u) => u.id === key) || null;
}

/**
 * @param {{ username: string, password: string, permissions?: Record<string, SessionAccess>, gerenteEmail?: string }} input
 */
function createUser(input) {
  const username = String(input.username || '').trim();
  const password = String(input.password || '');
  if (!username) throw new Error('El usuario es obligatorio');
  if (username.length < 3) throw new Error('El usuario debe tener al menos 3 caracteres');
  if (!/^[a-zA-Z0-9._-]+$/.test(username)) {
    throw new Error('El usuario solo puede contener letras, números, punto, guion y guion bajo');
  }
  if (password.length < 6) throw new Error('La contraseña debe tener al menos 6 caracteres');

  const superName = normalizeUsername(process.env.AUTH_USERNAME);
  if (superName && normalizeUsername(username) === superName) {
    throw new Error('Ese nombre está reservado para el superusuario del .env');
  }

  const gerenteEmail = sanitizeGerenteEmail(input.gerenteEmail);

  const store = readStore();
  if (store.users.some((u) => normalizeUsername(u.username) === normalizeUsername(username))) {
    throw new Error(`El usuario "${username}" ya existe`);
  }

  const now = new Date().toISOString();
  /** @type {StoredUser} */
  const user = {
    id: crypto.randomUUID(),
    username,
    passwordHash: hashPassword(password),
    role: 'user',
    permissions: sanitizePermissions(input.permissions),
    gerenteEmail,
    createdAt: now,
    updatedAt: now
  };

  store.users.push(user);
  writeStore(store);
  return publicUser(user);
}

/**
 * @param {string} id
 * @param {{ password?: string, permissions?: Record<string, SessionAccess>, gerenteEmail?: string }} patch
 */
function updateUser(id, patch) {
  const store = readStore();
  const idx = store.users.findIndex((u) => u.id === id);
  if (idx === -1) throw new Error('Usuario no encontrado');

  if (patch.password != null && String(patch.password).length > 0) {
    if (String(patch.password).length < 6) {
      throw new Error('La contraseña debe tener al menos 6 caracteres');
    }
    store.users[idx].passwordHash = hashPassword(patch.password);
  }

  if (patch.permissions != null) {
    store.users[idx].permissions = sanitizePermissions(patch.permissions);
  }

  if (Object.prototype.hasOwnProperty.call(patch, 'gerenteEmail')) {
    store.users[idx].gerenteEmail = sanitizeGerenteEmail(patch.gerenteEmail);
  }

  store.users[idx].updatedAt = new Date().toISOString();
  writeStore(store);
  return publicUser(store.users[idx]);
}

function deleteUser(id) {
  const store = readStore();
  const before = store.users.length;
  store.users = store.users.filter((u) => u.id !== id);
  if (store.users.length === before) {
    throw new Error('Usuario no encontrado');
  }
  writeStore(store);
  return true;
}

/**
 * Quita permisos de sesiones eliminadas.
 * @param {string} sessionId
 */
function removeSessionFromAllUsers(sessionId) {
  const id = String(sessionId || '').trim();
  if (!id) return;
  const store = readStore();
  let changed = false;
  for (const user of store.users) {
    if (user.permissions && Object.prototype.hasOwnProperty.call(user.permissions, id)) {
      delete user.permissions[id];
      user.updatedAt = new Date().toISOString();
      changed = true;
    }
  }
  if (changed) writeStore(store);
}

function authenticateStoredUser(username, password) {
  const user = findUserByUsername(username);
  if (!user) return null;
  if (!verifyPassword(password, user.passwordHash)) return null;
  return publicUser(user);
}

module.exports = {
  ACCESS_LEVELS,
  getAllUsers,
  findUserByUsername,
  findUserById,
  createUser,
  updateUser,
  deleteUser,
  removeSessionFromAllUsers,
  authenticateStoredUser,
  publicUser,
  sanitizePermissions,
  sanitizeGerenteEmail,
  getSuperGerenteEmail,
  setSuperGerenteEmail
};
