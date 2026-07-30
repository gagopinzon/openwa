const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const DATA_DIR = path.join(__dirname, 'data');
const CV_FILES_DIR = path.join(DATA_DIR, 'cv-files');
const TOKEN_TTL_SECONDS = 7 * 24 * 60 * 60; // 7 días

function ensureCvFilesDir() {
  if (!fs.existsSync(DATA_DIR)) {
    fs.mkdirSync(DATA_DIR, { recursive: true });
  }
  if (!fs.existsSync(CV_FILES_DIR)) {
    fs.mkdirSync(CV_FILES_DIR, { recursive: true });
  }
}

function signingSecret() {
  return (
    String(process.env.AUTH_SESSION_SECRET || '').trim() ||
    String(process.env.OPENWA_API_KEY || '').trim() ||
    'cv-file-dev-secret'
  );
}

function publicBaseUrl() {
  return String(process.env.WEBHOOK_PUBLIC_URL || '').trim().replace(/\/$/, '');
}

function isPublicUrlConfigured() {
  return Boolean(publicBaseUrl());
}

function sanitizeExtension(originalName) {
  const ext = path.extname(String(originalName || '')).toLowerCase();
  if (['.pdf', '.docx', '.jpg', '.jpeg', '.png'].includes(ext)) return ext;
  return '.pdf';
}

function mimeForExt(ext) {
  switch (String(ext || '').toLowerCase()) {
    case '.pdf':
      return 'application/pdf';
    case '.docx':
      return 'application/vnd.openxmlformats-officedocument.wordprocessingml.document';
    case '.jpg':
    case '.jpeg':
      return 'image/jpeg';
    case '.png':
      return 'image/png';
    default:
      return 'application/octet-stream';
  }
}

/**
 * Guarda el buffer del CV en disco.
 * @param {Buffer} buffer
 * @param {string} originalName
 * @returns {{ cvId: string, cvFileName: string }}
 */
function saveCvFile(buffer, originalName) {
  ensureCvFilesDir();
  const cvId = crypto.randomBytes(12).toString('hex');
  const ext = sanitizeExtension(originalName);
  const cvFileName = `${cvId}${ext}`;
  const filePath = path.join(CV_FILES_DIR, cvFileName);
  fs.writeFileSync(filePath, buffer);
  return { cvId, cvFileName };
}

function resolveFilePath(cvId) {
  const id = String(cvId || '').trim();
  if (!/^[a-f0-9]{16,64}$/i.test(id)) return null;

  ensureCvFilesDir();
  const entries = fs.readdirSync(CV_FILES_DIR);
  const match = entries.find((name) => name.startsWith(id + '.') || name === id);
  if (!match) return null;
  return path.join(CV_FILES_DIR, match);
}

function getCvFileMeta(cvId) {
  const filePath = resolveFilePath(cvId);
  if (!filePath || !fs.existsSync(filePath)) return null;
  const ext = path.extname(filePath);
  return {
    filePath,
    fileName: path.basename(filePath),
    mime: mimeForExt(ext)
  };
}

function signToken(cvId, expiresAt) {
  const payload = `${cvId}:${expiresAt}`;
  const sig = crypto.createHmac('sha256', signingSecret()).update(payload).digest('hex');
  return `${expiresAt}.${sig}`;
}

function buildSignedToken(cvId, ttlSeconds = TOKEN_TTL_SECONDS) {
  const expiresAt = Math.floor(Date.now() / 1000) + ttlSeconds;
  return signToken(String(cvId), expiresAt);
}

function verifySignedToken(cvId, token) {
  const id = String(cvId || '').trim();
  const raw = String(token || '').trim();
  if (!id || !raw) return false;

  const parts = raw.split('.');
  if (parts.length !== 2) return false;
  const [expiresAtStr, sig] = parts;
  const expiresAt = Number(expiresAtStr);
  if (!Number.isFinite(expiresAt)) return false;
  if (expiresAt < Math.floor(Date.now() / 1000)) return false;

  const expected = signToken(id, expiresAt);
  const expectedSig = expected.split('.')[1];
  if (sig.length !== expectedSig.length) return false;
  return crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(expectedSig));
}

/**
 * URL pública que el panel puede descargar.
 * @param {string} cvId
 * @returns {string|null}
 */
function buildCvPublicUrl(cvId) {
  const base = publicBaseUrl();
  if (!base) return null;
  const token = buildSignedToken(cvId);
  return `${base}/api/public/cv/${encodeURIComponent(cvId)}?token=${encodeURIComponent(token)}`;
}

function clearAllCvFiles() {
  ensureCvFilesDir();
  for (const name of fs.readdirSync(CV_FILES_DIR)) {
    try {
      fs.unlinkSync(path.join(CV_FILES_DIR, name));
    } catch (err) {
      console.warn(`[cvFileStore] No se pudo borrar ${name}:`, err.message);
    }
  }
}

function isPanelIntegrationConfigured() {
  return Boolean(
    String(process.env.MSG_INTEGRATION_API_KEY || '').trim() &&
      String(process.env.MSG_GERENTE_EMAIL || '').trim()
  );
}

module.exports = {
  saveCvFile,
  getCvFileMeta,
  buildSignedToken,
  verifySignedToken,
  buildCvPublicUrl,
  clearAllCvFiles,
  isPublicUrlConfigured,
  isPanelIntegrationConfigured,
  publicBaseUrl,
  CV_FILES_DIR
};
