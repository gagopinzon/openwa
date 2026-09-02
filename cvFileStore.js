const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const DATA_DIR = path.join(__dirname, 'data');
const CV_FILES_DIR = path.join(DATA_DIR, 'cv-files');
const MANIFEST_FILE = path.join(DATA_DIR, 'cvs-manifest.json');
const TOKEN_TTL_SECONDS = 7 * 24 * 60 * 60; // 7 días
const CV_TTL_MS = TOKEN_TTL_SECONDS * 1000;

function isCvExpired(cv, now = Date.now(), ttlMs = CV_TTL_MS) {
  const saved = Date.parse(cv && cv.savedAt);
  if (!Number.isFinite(saved)) return false;
  return now - saved >= ttlMs;
}

function stampMissingSavedAt(cvs, now = Date.now()) {
  const iso = new Date(now).toISOString();
  return (Array.isArray(cvs) ? cvs : []).map((cv) => {
    if (!cv || typeof cv !== 'object') return cv;
    if (cv.savedAt) return cv;
    return { ...cv, savedAt: iso };
  });
}

function partitionExpired(cvs, now = Date.now()) {
  const kept = [];
  const expired = [];
  for (const cv of Array.isArray(cvs) ? cvs : []) {
    if (isCvExpired(cv, now)) expired.push(cv);
    else kept.push(cv);
  }
  return { kept, expired };
}

function getWorkspaceCvs(cvs) {
  return (Array.isArray(cvs) ? cvs : []).filter((c) => c && c.inWorkspace !== false);
}

function archiveAllWorkspace(cvs) {
  return (Array.isArray(cvs) ? cvs : []).map((cv) =>
    cv && typeof cv === 'object' ? { ...cv, inWorkspace: false } : cv
  );
}

function archiveSentByPhones(cvs, sentPhones, phonesMatch) {
  const phones = Array.isArray(sentPhones) ? sentPhones : [];
  const matchFn = typeof phonesMatch === 'function' ? phonesMatch : () => false;
  return (Array.isArray(cvs) ? cvs : []).map((cv) => {
    if (!cv || typeof cv !== 'object') return cv;
    const phone = cv.telefono;
    if (!phone || phone === 'No encontrado') return cv;
    const sent = phones.some((s) => matchFn(phone, s));
    return sent ? { ...cv, inWorkspace: false } : cv;
  });
}

function hasUsablePhone(phone) {
  const raw = String(phone || '').trim();
  return Boolean(raw) && raw !== 'No encontrado' && raw !== 'N/A';
}

/**
 * Archiva el lote anterior y mete el nuevo en mesa.
 * Si un teléfono ya existía, reemplaza esa entrada y reporta el cvId viejo.
 */
function mergeIncomingBatch(archive, incoming, phonesMatch) {
  const matchFn = typeof phonesMatch === 'function' ? phonesMatch : () => false;
  const result = archiveAllWorkspace(archive);
  const replacedIds = [];

  for (const entry of Array.isArray(incoming) ? incoming : []) {
    if (!entry || typeof entry !== 'object') continue;
    const next = { ...entry, inWorkspace: true };
    let idx = -1;
    if (hasUsablePhone(next.telefono)) {
      idx = result.findIndex(
        (c) => c && hasUsablePhone(c.telefono) && matchFn(c.telefono, next.telefono)
      );
    }
    if (idx >= 0) {
      const prevId = result[idx].cvId;
      if (prevId && prevId !== next.cvId) replacedIds.push(prevId);
      result[idx] = next;
    } else {
      result.push(next);
    }
  }

  return { cvs: result, replacedIds };
}

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

function stripTrailingSlash(url) {
  return String(url || '').trim().replace(/\/$/, '');
}

/**
 * Base para cvUrl que el panel descarga.
 * CV_PUBLIC_URL (pública) gana sobre WEBHOOK_PUBLIC_URL (a menudo IP Docker).
 */
function publicBaseUrl() {
  const dedicated = stripTrailingSlash(process.env.CV_PUBLIC_URL);
  if (dedicated) return dedicated;
  return stripTrailingSlash(process.env.WEBHOOK_PUBLIC_URL);
}

function isPublicUrlConfigured() {
  return Boolean(publicBaseUrl());
}

function parseIpv4(hostname) {
  const m = String(hostname || '').match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
  if (!m) return null;
  const parts = m.slice(1).map(Number);
  if (parts.some((n) => n > 255)) return null;
  return parts;
}

function isPrivateIpv4(parts) {
  const [a, b] = parts;
  if (a === 10 || a === 127 || a === 0) return true;
  if (a === 169 && b === 254) return true;
  if (a === 192 && b === 168) return true;
  if (a === 172 && b >= 16 && b <= 31) return true;
  return false;
}

/**
 * El panel corre en internet: no puede GET a Docker/loopback/LAN.
 * @param {string} url
 */
function isCvUrlReachableByPanel(url) {
  const raw = String(url || '').trim();
  if (!raw) return false;
  let parsed;
  try {
    parsed = new URL(raw);
  } catch {
    return false;
  }
  const host = parsed.hostname.toLowerCase().replace(/^\[|\]$/g, '');
  if (!host) return false;
  if (
    host === 'localhost' ||
    host === '::1' ||
    host === '0.0.0.0' ||
    host === 'host.docker.internal' ||
    host.endsWith('.local') ||
    host.endsWith('.localhost')
  ) {
    return false;
  }
  const ipv4 = parseIpv4(host);
  if (ipv4 && isPrivateIpv4(ipv4)) return false;
  return true;
}

/**
 * @param {string} url
 * @returns {string}
 */
function panelUnreachableCvUrlError(url) {
  let host = '';
  try {
    host = new URL(String(url || '')).hostname;
  } catch {
    host = String(url || '').trim() || '(vacía)';
  }
  return (
    `El panel no puede descargar el CV desde ${host} (IP/host privado). ` +
    `Por eso responde 504. Define CV_PUBLIC_URL con una URL pública HTTPS ` +
    `(p. ej. https://msg.protalentconnections.com). ` +
    `WEBHOOK_PUBLIC_URL puede seguir en 172.17.0.1 para OpenWA en Docker.`
  );
}

function hostFromUrl(url) {
  try {
    return new URL(String(url || '')).hostname || '';
  } catch {
    return '';
  }
}

/**
 * Probe a CV_PUBLIC_URL falló: el PDF no está en ese host o el token no es de ese msg.
 * @param {string} cvUrl
 * @param {{ status?: number, reason?: string }} [probe]
 */
function describeCvProbeFailure(cvUrl, probe = {}) {
  const host = hostFromUrl(cvUrl) || '(CV_PUBLIC_URL)';
  const status = Number(probe && probe.status);
  if (status === 401 || status === 403) {
    return (
      `${host} rechazó el token del CV (${status}). ` +
      `El PDF y el token se firmaron en ESTA máquina; ${host} es otro msg. ` +
      `CV_PUBLIC_URL debe ser una URL pública de esta PC (túnel Cloudflare/ngrok al puerto 3445), ` +
      `no el dominio de producción salvo que este proceso sea ese servidor.`
    );
  }
  if (status === 404) {
    return (
      `${host} no tiene ese archivo (404). El PDF está en otra máquina. ` +
      `CV_PUBLIC_URL debe apuntar al msg que guardó el CV.`
    );
  }
  const extra = probe.reason || (status ? `HTTP ${status}` : 'sin respuesta');
  return (
    `El panel no pudo descargar el CV desde ${host} (${extra}). ` +
    `CV_PUBLIC_URL tiene que ser alcanzable desde internet y servir este mismo msg.`
  );
}

/**
 * @param {Buffer} buffer
 */
function isValidPdfBuffer(buffer) {
  if (!buffer || !Buffer.isBuffer(buffer) || buffer.length < 5) return false;
  return buffer.slice(0, 5).toString('ascii') === '%PDF-';
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

/**
 * @param {string} cvId
 * @returns {Buffer|null}
 */
function readCvFileBuffer(cvId) {
  const meta = getCvFileMeta(cvId);
  if (!meta) return null;
  try {
    return fs.readFileSync(meta.filePath);
  } catch {
    return null;
  }
}

/**
 * @param {string} cvId
 */
function getCvDisplayFilename(cvId) {
  const meta = getCvFileMeta(cvId);
  const entry = (loadCvsManifest() || []).find((c) => c && c.cvId === cvId);
  const original = String(entry?.archivoOriginal || '').trim();
  if (original) return original;
  return meta?.fileName || 'CV.pdf';
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
    leadCorreo: cv.leadCorreo || cv.correo || cv.email || undefined,
    correo: cv.correo || cv.leadCorreo || cv.email || undefined,
    email: cv.email || cv.correo || cv.leadCorreo || undefined,
    leadCiudad: cv.leadCiudad || cv.ciudad || undefined,
    ciudad: cv.ciudad || cv.leadCiudad || undefined,
    leadEstado: cv.leadEstado || cv.estado || undefined,
    estado: cv.estado || cv.leadEstado || undefined,
    analysisProvider: cv.analysisProvider || undefined,
    inWorkspace: cv.inWorkspace !== false,
    savedAt: cv.savedAt || new Date().toISOString()
  };
}

/**
 * Reconstruye un CV del JSON del manifest (incluye ciudad/estado/correo).
 * @param {object} cv
 */
function hydrateStoredCv(cv) {
  if (!cv || typeof cv !== 'object' || !cv.cvId) return null;
  return {
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
    leadCorreo: cv.leadCorreo || cv.correo || cv.email || undefined,
    correo: cv.correo || cv.leadCorreo || cv.email || undefined,
    email: cv.email || cv.correo || cv.leadCorreo || undefined,
    leadCiudad: cv.leadCiudad || cv.ciudad || undefined,
    ciudad: cv.ciudad || cv.leadCiudad || undefined,
    leadEstado: cv.leadEstado || cv.estado || undefined,
    estado: cv.estado || cv.leadEstado || undefined,
    analysisProvider: cv.analysisProvider || undefined,
    inWorkspace: cv.inWorkspace !== false,
    savedAt: cv.savedAt || null
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
 * @param {string} cvId
 * @param {object} patch
 */
function updateCvEntry(cvId, patch) {
  const id = String(cvId || '').trim();
  if (!id) return null;
  const cvs = loadCvsManifest();
  const idx = cvs.findIndex((c) => c && c.cvId === id);
  if (idx < 0) return null;
  cvs[idx] = sanitizeCvForPersist({ ...cvs[idx], ...patch, cvId: id });
  saveCvsManifest(cvs);
  return cvs[idx];
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
      restored.push(hydrateStoredCv(cv));
    }

    const hadMissingSavedAt = restored.some((cv) => !cv.savedAt);
    const { kept, expired } = purgeExpiredCvs(restored);

    if (dropped > 0 || expired.length > 0 || hadMissingSavedAt) {
      if (dropped > 0) {
        console.warn(
          `[cvFileStore] Manifest: ${dropped} CV(s) omitidos (archivo faltante).`
        );
      }
      if (expired.length > 0) {
        console.warn(
          `[cvFileStore] Caducidad 7 días: ${expired.length} CV(s) borrados. Quedan ${kept.length}.`
        );
      }
      saveCvsManifest(kept);
    }

    return kept;
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

function deleteCvFile(cvId) {
  const filePath = resolveFilePath(cvId);
  if (!filePath) return false;
  try {
    fs.unlinkSync(filePath);
    return true;
  } catch (err) {
    console.warn(`[cvFileStore] No se pudo borrar CV ${cvId}:`, err.message);
    return false;
  }
}

/**
 * Quita CVs con más de 7 días y borra sus PDFs.
 * @param {Array} cvs
 * @param {number} [now]
 * @returns {{ kept: Array, expired: Array }}
 */
function purgeExpiredCvs(cvs, now = Date.now()) {
  const stamped = stampMissingSavedAt(cvs, now);
  const { kept, expired } = partitionExpired(stamped, now);
  for (const cv of expired) {
    if (cv && cv.cvId) deleteCvFile(cv.cvId);
  }
  return { kept, expired };
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
  CV_TTL_MS,
  TOKEN_TTL_SECONDS,
  isCvExpired,
  stampMissingSavedAt,
  partitionExpired,
  getWorkspaceCvs,
  archiveAllWorkspace,
  archiveSentByPhones,
  mergeIncomingBatch,
  saveCvFile,
  getCvFileMeta,
  readCvFileBuffer,
  getCvDisplayFilename,
  deleteCvFile,
  buildSignedToken,
  verifySignedToken,
  buildCvPublicUrl,
  clearAllCvFiles,
  clearAllCvs,
  clearCvsManifest,
  saveCvsManifest,
  updateCvEntry,
  loadCvsManifest,
  purgeExpiredCvs,
  sanitizeCvForPersist,
  hydrateStoredCv,
  isPublicUrlConfigured,
  isCvUrlReachableByPanel,
  panelUnreachableCvUrlError,
  describeCvProbeFailure,
  isValidPdfBuffer,
  isPanelIntegrationConfigured,
  publicBaseUrl,
  CV_FILES_DIR,
  MANIFEST_FILE
};
