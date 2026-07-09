const crypto = require('crypto');

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

function createSessionToken() {
  const payload = JSON.stringify({ exp: Date.now() + SESSION_MS });
  const signature = crypto.createHmac('sha256', getSessionSecret()).update(payload).digest('hex');
  return `${Buffer.from(payload).toString('base64url')}.${signature}`;
}

function verifySessionToken(token) {
  if (!token || typeof token !== 'string') return false;

  const dot = token.lastIndexOf('.');
  if (dot <= 0) return false;

  const payloadB64 = token.slice(0, dot);
  const signature = token.slice(dot + 1);

  let payload;
  try {
    payload = Buffer.from(payloadB64, 'base64url').toString('utf8');
  } catch {
    return false;
  }

  const expected = crypto.createHmac('sha256', getSessionSecret()).update(payload).digest('hex');
  if (signature.length !== expected.length) return false;
  if (!crypto.timingSafeEqual(Buffer.from(signature), Buffer.from(expected))) {
    return false;
  }

  try {
    const data = JSON.parse(payload);
    return typeof data.exp === 'number' && data.exp > Date.now();
  } catch {
    return false;
  }
}

function isAuthenticated(req) {
  if (!isAuthEnabled()) return true;
  const cookies = parseCookies(req);
  return verifySessionToken(cookies[COOKIE_NAME]);
}

function validateCredentials(username, password) {
  if (!isAuthEnabled()) return false;

  const expectedUser = String(process.env.AUTH_USERNAME || '');
  const expectedPass = String(process.env.AUTH_PASSWORD || '');

  const userOk =
    username.length === expectedUser.length &&
    crypto.timingSafeEqual(Buffer.from(username), Buffer.from(expectedUser));
  const passOk =
    password.length === expectedPass.length &&
    crypto.timingSafeEqual(Buffer.from(password), Buffer.from(expectedPass));

  return userOk && passOk;
}

function isPublicPath(pathname) {
  if (pathname === '/login') return true;
  if (pathname === '/api/auth/login') return true;
  if (pathname === '/api/webhooks/openwa') return true;
  return false;
}

function authMiddleware(req, res, next) {
  if (!isAuthEnabled()) return next();
  if (isPublicPath(req.path)) return next();
  if (isAuthenticated(req)) return next();

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
  setAuthCookie,
  clearAuthCookie
};
