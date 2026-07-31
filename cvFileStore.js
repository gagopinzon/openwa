const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const DATA_DIR = path.join(__dirname, 'data');
const CV_FILES_DIR = path.join(DATA_DIR, 'cv-files');
const MANIFEST_FILE = path.join(DATA_DIR, 'cvs-manifest.json');
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

/**
 * Campos que se persisten (sin textoCompleto para no inflar el JSON).
 * @param {object} cv
 */
function sanitizeCvForPersist(cv) {
  if (!cv || typeof cv !== 'object') return null;
  return {
    nombre: cv.nombre || '',
    telefono: cv.telefono || '',
    experiencia: cv.experiencia || '',
    archivoOriginal: cv.archivoOriginal || '',
    cvId: cv.cvId || null,
    cvFileName: cv.cvFileName || null,
    saludo: cv.saludo || '',
    mensajeIA: cv.mensajeIA || '',
    procesado: Boolean(cv.procesado),
    error: cv.error || undefined,
    fromConversation: Boolean(cv.fromConversation) || undefined,
    savedAt: cv.savedAt || new Date().toISOString()
  };
}

/**
 * Guarda el listado de leads/CVs en disco.
 * @param {Array} cvs
 */
function saveCvsManifest(cvs) {
  ensureCvFilesDir();
  const list = Array.isArray(cvs)
    ? cvs.map(sanitizeCvForPersist).filter((c) => c && c.cvId)
    : [];
  const payload = {
    version: 1,
    updatedAt: new Date().toISOString(),
    cvs: list
  };
  const tmp = `${MANIFEST_FILE}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(payload, null, 2), 'utf8');
  fs.renameSync(tmp, MANIFEST_FILE);
  return list.length;
}

/**
 * Carga leads persistidos. Omite entradas cuyo PDF ya no está en disco.
 * @returns {Array}
 */
function loadCvsManifest() {
  ensureCvFilesDir();
  if (!fs.existsSync(MANIFEST_FILE)) return [];

  try {
    const raw = fs.readFileSync(MANIFEST_FILE, 'utf8');
    const parsed = JSON.parse(raw);
    const list = Array.isArray(parsed?.cvs) ? parsed.cvs : [];
    const restored = [];
    let dropped = 0;

    for (const cv of list) {
      if (!cv || !cv.cvId) {
        dropped += 1;
        continue;
      }
      if (!getCvFileMeta(cv.cvId)) {
        dropped += 1;
        continue;
      }
      restored.push({
        nombre: cv.nombre || 'Sin nombre',
        telefono: cv.telefono || 'No encontrado',
        experiencia: cv.experiencia || '',
        textoCompleto: '',
        archivoOriginal: cv.archivoOriginal || `${cv.cvId}.pdf`,
        cvId: cv.cvId,
        cvFileName: cv.cvFileName || null,
        saludo: cv.saludo || '',
        mensajeIA: cv.mensajeIA || '',
        procesado: cv.procesado !== false,
        error: cv.error,
        fromConversation: Boolean(cv.fromConversation),
        savedAt: cv.savedAt || null
      });
    }

    if (dropped > 0) {
      console.warn(
        `[cvFileStore] Manifest: ${dropped} CV(s) omitidos (archivo faltante). Quedan ${restored.length}.`
      );
      saveCvsManifest(restored);
    }

    return restored;
  } catch (err) {
    console.error('[cvFileStore] Error leyendo cvs-manifest.json:', err.message);
    return [];
  }
}

function clearCvsManifest() {
  ensureCvFilesDir();
  try {
    if (fs.existsSync(MANIFEST_FILE)) fs.unlinkSync(MANIFEST_FILE);
  } catch (err) {
    console.warn('[cvFileStore] No se pudo borrar manifest:', err.message);
  }
}

/** Borra PDFs + manifiesto */
function clearAllCvs() {
  clearAllCvFiles();
  clearCvsManifest();
}

function isPanelIntegrationConfigured() {
  return Boolean(String(process.env.MSG_INTEGRATION_API_KEY || '').trim());
}

module.exports = {
  saveCvFile,
  getCvFileMeta,
  buildSignedToken,
  verifySignedToken,
  buildCvPublicUrl,
  clearAllCvFiles,
  clearAllCvs,
  clearCvsManifest,
  saveCvsManifest,
  loadCvsManifest,
  sanitizeCvForPersist,
  isPublicUrlConfigured,
  isPanelIntegrationConfigured,
  publicBaseUrl,
  CV_FILES_DIR,
  MANIFEST_FILE
};
