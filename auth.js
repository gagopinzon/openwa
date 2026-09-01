const crypto = require('crypto');
const usersStore = require('./usersStore');

const COOKIE_NAME = 'auth_session';
const SESSION_MS = 24 * 60 * 60 * 1000;

function isAuthEnabled() {
  return Boolean(
    String(process.env.AUTH_USERNAME || '').trim() &&
    String(process.env.AUTH_PASSWORD || '').trim()
  );
}

function getSessionSecret() {
  const secret = String(process.env.AUTH_SESSION_SECRET || '').trim();
  if (secret) return secret;
  return String(process.env.OPENWA_API_KEY || 'whatsapp-bulk-dev-secret');
}

function getSuperUsername() {
  return String(process.env.AUTH_USERNAME || '').trim();
}

function parseCookies(req) {
  const header = req.headers.cookie || '';
  return Object.fromEntries(
    header
      .split(';')
      .map((part) => part.trim())
      .filter(Boolean)
      .map((part) => {
        const eq = part.indexOf('=');
        if (eq === -1) return [part, ''];
        const key = part.slice(0, eq);
        const value = part.slice(eq + 1);
        try {
          return [key, decodeURIComponent(value)];
        } catch {
          return [key, value];
        }
      })
  );
}

/**
 * @param {{ username: string, role: 'super'|'user' }} user
 */
function createSessionToken(user) {
  const payload = JSON.stringify({
    exp: Date.now() + SESSION_MS,
    u: String(user.username || '').trim(),
    r: user.role === 'super' ? 'super' : 'user'
  });
  const signature = crypto.createHmac('sha256', getSessionSecret()).update(payload).digest('hex');
  return `${Buffer.from(payload).toString('base64url')}.${signature}`;
}

/**
 * @returns {{ exp: number, username: string, role: 'super'|'user' }|null}
 */
function decodeSessionToken(token) {
  if (!token || typeof token !== 'string') return null;

  const dot = token.lastIndexOf('.');
  if (dot <= 0) return null;

  const payloadB64 = token.slice(0, dot);
  const signature = token.slice(dot + 1);

  let payload;
  try {
    payload = Buffer.from(payloadB64, 'base64url').toString('utf8');
  } catch {
    return null;
  }

  const expected = crypto.createHmac('sha256', getSessionSecret()).update(payload).digest('hex');
  if (signature.length !== expected.length) return null;
  if (!crypto.timingSafeEqual(Buffer.from(signature), Buffer.from(expected))) {
    return null;
  }

  try {
    const data = JSON.parse(payload);
    if (typeof data.exp !== 'number' || data.exp <= Date.now()) return null;
    const username = String(data.u || '').trim();
    if (!username) return null;
    const role = data.r === 'super' ? 'super' : 'user';
    return { exp: data.exp, username, role };
  } catch {
    return null;
  }
}

function verifySessionToken(token) {
  return Boolean(decodeSessionToken(token));
}

/**
 * Usuario efectivo para la request (super del .env o usuario almacenado).
 * Si auth está desactivada, se trata como super anónimo.
 * @returns {{
 *   username: string,
 *   role: 'super'|'user',
 *   isSuper: boolean,
 *   permissions: Record<string, 'view'|'control'>,
 *   id?: string
 * }|null}
 */
function getRequestUser(req) {
  if (!isAuthEnabled()) {
    return {
      username: 'local',
      role: 'super',
      isSuper: true,
      permissions: {},
      gerenteEmail:
        usersStore.getSuperGerenteEmail() ||
        String(process.env.MSG_GERENTE_EMAIL || '').trim()
    };
  }

  const cookies = parseCookies(req);
  const decoded = decodeSessionToken(cookies[COOKIE_NAME]);
  if (!decoded) return null;

  if (decoded.role === 'super') {
    const superName = getSuperUsername();
    if (decoded.username.toLowerCase() !== superName.toLowerCase()) {
      return null;
    }
    return {
      username: superName,
      role: 'super',
      isSuper: true,
      permissions: {},
      gerenteEmail:
        usersStore.getSuperGerenteEmail() ||
        String(process.env.MSG_GERENTE_EMAIL || '').trim()
    };
  }

  const stored = usersStore.findUserByUsername(decoded.username);
  if (!stored) return null;

  return {
    id: stored.id,
    username: stored.username,
    role: 'user',
    isSuper: false,
    permissions: { ...(stored.permissions || {}) },
    gerenteEmail: String(stored.gerenteEmail || '').trim()
  };
}

function isAuthenticated(req) {
  if (!isAuthEnabled()) return true;
  return Boolean(getRequestUser(req));
}

/**
 * @returns {{ ok: true, user: object }|{ ok: false }}
 */
function validateCredentials(username, password) {
  if (!isAuthEnabled()) return { ok: false };

  const inputUser = String(username || '').trim();
  const inputPass = String(password || '');
  const expectedUser = getSuperUsername();
  const expectedPass = String(process.env.AUTH_PASSWORD || '');

  const superUserOk =
    inputUser.length === expectedUser.length &&
    inputUser.length > 0 &&
    crypto.timingSafeEqual(Buffer.from(inputUser), Buffer.from(expectedUser));
  const superPassOk =
    inputPass.length === expectedPass.length &&
    inputPass.length > 0 &&
    crypto.timingSafeEqual(Buffer.from(inputPass), Buffer.from(expectedPass));

  if (superUserOk && superPassOk) {
    return {
      ok: true,
      user: {
        username: expectedUser,
        role: 'super',
        isSuper: true,
        permissions: {},
        gerenteEmail:
          usersStore.getSuperGerenteEmail() ||
          String(process.env.MSG_GERENTE_EMAIL || '').trim()
      }
    };
  }

  const stored = usersStore.authenticateStoredUser(inputUser, inputPass);
  if (stored) {
    return {
      ok: true,
      user: {
        id: stored.id,
        username: stored.username,
        role: 'user',
        isSuper: false,
        permissions: { ...(stored.permissions || {}) },
        gerenteEmail: String(stored.gerenteEmail || '').trim()
      }
    };
  }

  return { ok: false };
}

function getSessionAccess(user, sessionId) {
  if (!user) return null;
  if (user.isSuper || user.role === 'super') return usersStore.ACCESS_LEVELS.CONTROL;
  const id = String(sessionId || '').trim();
  if (!id) return null;
  const level = user.permissions && user.permissions[id];
  if (level === usersStore.ACCESS_LEVELS.VIEW || level === usersStore.ACCESS_LEVELS.CONTROL) {
    return level;
  }
  return null;
}

function canViewSession(user, sessionId) {
  return Boolean(getSessionAccess(user, sessionId));
}

function canControlSession(user, sessionId) {
  return getSessionAccess(user, sessionId) === usersStore.ACCESS_LEVELS.CONTROL;
}

function filterSessionsForUser(user, sessions, minAccess = 'view') {
  const list = Array.isArray(sessions) ? sessions : [];
  if (!user || user.isSuper || user.role === 'super') {
    return list.map((s) => ({
      ...s,
      access: usersStore.ACCESS_LEVELS.CONTROL
    }));
  }

  return list
    .map((s) => {
      const access = getSessionAccess(user, s.id);
      return access ? { ...s, access } : null;
    })
    .filter(Boolean)
    .filter((s) => {
      if (minAccess === 'control') return s.access === usersStore.ACCESS_LEVELS.CONTROL;
      return true;
    });
}

function isPublicPath(pathname) {
  const pathOnly = String(pathname || '').split('?')[0].replace(/\/+$/, '') || '/';
  if (pathOnly === '/login') return true;
  if (pathOnly === '/api/auth/login') return true;
  if (pathOnly === '/api/webhooks/openwa') return true;
  // Panel descarga CVs con token firmado (sin cookie de sesión Msg)
  if (pathOnly.startsWith('/api/public/cv/')) return true;
  // Agente Android (auth por ANDROID_GATEWAY_TOKEN en la ruta)
  if (pathOnly === '/api/android/devices/register') return true;
  if (pathOnly === '/api/android/jobs/next') return true;
  if (/^\/api\/android\/devices\/[^/]+\/heartbeat$/.test(pathOnly)) return true;
  if (/^\/api\/android\/jobs\/[^/]+\/result$/.test(pathOnly)) return true;
  // Hermes Agent (Windows) — auth por HERMES_BRIDGE_TOKEN en la ruta
  if (pathOnly === '/api/hermes/health') return true;
  if (pathOnly === '/api/hermes/inbox') return true;
  if (pathOnly === '/api/hermes/ack') return true;
  return false;
}

function isAndroidAgentRequest(req) {
  const pathOnly = String(req.path || '').split('?')[0].replace(/\/+$/, '') || '/';
  const original = String(req.originalUrl || '').split('?')[0].replace(/\/+$/, '') || '/';
  if (isPublicPath(pathOnly) || isPublicPath(original)) return true;
  // Solo rutas de agente (no el listado del panel)
  const token = String(req.headers['x-android-token'] || '').trim();
  if (!token) return false;
  const agentPaths = [
    '/api/android/devices/register',
    '/api/android/jobs/next'
  ];
  if (agentPaths.includes(pathOnly) || agentPaths.some((p) => original.endsWith(p))) return true;
  if (/^\/api\/android\/devices\/[^/]+\/heartbeat$/.test(pathOnly)) return true;
  if (/^\/api\/android\/jobs\/[^/]+\/result$/.test(pathOnly)) return true;
  return false;
}

function authMiddleware(req, res, next) {
  if (!isAuthEnabled()) {
    req.user = getRequestUser(req);
    return next();
  }
  if (isPublicPath(req.path) || isPublicPath(req.originalUrl) || isAndroidAgentRequest(req)) {
    return next();
  }

  const user = getRequestUser(req);
  if (user) {
    req.user = user;
    return next();
  }

  const wantsJson =
    req.path.startsWith('/api/') ||
    req.path.startsWith('/upload-') ||
    req.path.startsWith('/generate-') ||
    req.path.startsWith('/send-') ||
    req.path.startsWith('/open-') ||
    req.path.startsWith('/close-') ||
    req.path.startsWith('/clear-') ||
    req.path.startsWith('/pause-') ||
    req.path.startsWith('/resume-') ||
    req.path.startsWith('/abort-') ||
    req.path.startsWith('/skip-') ||
    req.path.startsWith('/events') ||
    req.path.startsWith('/cvs-') ||
    req.path.startsWith('/generation-') ||
    req.path.startsWith('/sending-') ||
    req.path.startsWith('/config') ||
    req.headers.accept?.includes('application/json');

  if (wantsJson) {
    return res.status(401).json({ success: false, error: 'No autenticado' });
  }

  return res.redirect('/login');
}

function requireSuper(req, res, next) {
  const user = req.user || getRequestUser(req);
  if (!user || !user.isSuper) {
    return res.status(403).json({
      success: false,
      error: 'Solo el superusuario puede realizar esta acción'
    });
  }
  return next();
}

function forbidUnlessControlSessions(sessionIds, req, res) {
  const user = req.user || getRequestUser(req);
  if (!user) {
    res.status(401).json({ success: false, error: 'No autenticado' });
    return false;
  }
  if (user.isSuper) return true;

  const ids = Array.isArray(sessionIds) ? sessionIds : [sessionIds];
  for (const id of ids) {
    if (!canControlSession(user, id)) {
      res.status(403).json({
        success: false,
        error: `No tienes permiso de control sobre la sesión "${id}"`
      });
      return false;
    }
  }
  return true;
}

function forbidUnlessViewSession(sessionId, req, res) {
  const user = req.user || getRequestUser(req);
  if (!user) {
    res.status(401).json({ success: false, error: 'No autenticado' });
    return false;
  }
  if (user.isSuper) return true;
  if (!canViewSession(user, sessionId)) {
    res.status(403).json({
      success: false,
      error: `No tienes acceso a la sesión "${sessionId}"`
    });
    return false;
  }
  return true;
}

function setAuthCookie(res, token) {
  const maxAgeSec = Math.floor(SESSION_MS / 1000);
  res.setHeader(
    'Set-Cookie',
    `${COOKIE_NAME}=${encodeURIComponent(token)}; HttpOnly; Path=/; SameSite=Strict; Max-Age=${maxAgeSec}`
  );
}

function clearAuthCookie(res) {
  res.setHeader(
    'Set-Cookie',
    `${COOKIE_NAME}=; HttpOnly; Path=/; SameSite=Strict; Max-Age=0`
  );
}

module.exports = {
  COOKIE_NAME,
  SESSION_MS,
  isAuthEnabled,
  authMiddleware,
  validateCredentials,
  createSessionToken,
  isAuthenticated,
  getRequestUser,
  getSessionAccess,
  canViewSession,
  canControlSession,
  filterSessionsForUser,
  requireSuper,
  forbidUnlessControlSessions,
  forbidUnlessViewSession,
  setAuthCookie,
  clearAuthCookie
};
