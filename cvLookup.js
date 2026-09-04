const cvFileStore = require('./cvFileStore');
const contactHistory = require('./contactHistoryStore');

const GENERIC_FIRST_NAMES = new Set([
  'contacto',
  'amigo',
  'lead',
  'candidato',
  'usuario',
  'cliente',
  'nombre'
]);

function foldPersonName(value) {
  return String(value || '')
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z\s]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function firstNameOf(value) {
  return foldPersonName(value).split(/\s+/)[0] || '';
}

function listUsableArchiveCvs() {
  return (cvFileStore.loadCvsManifest() || []).filter(
    (c) => c && c.procesado && c.cvId && cvFileStore.getCvFileMeta(c.cvId)
  );
}

/**
 * Un solo CV cargado cuyo nombre coincida (completo o nombre de pila único).
 * @param {string} name
 * @returns {string|null}
 */
function lookupCvIdByName(name) {
  const wanted = foldPersonName(name);
  const first = firstNameOf(name);
  if (!wanted || first.length < 3 || GENERIC_FIRST_NAMES.has(first)) return null;

  const list = listUsableArchiveCvs();
  const exact = list.filter((c) => foldPersonName(c.nombre) === wanted);
  if (exact.length === 1) return exact[0].cvId;
  if (exact.length > 1) return null;

  const byFirst = list.filter((c) => firstNameOf(c.nombre) === first);
  if (byFirst.length === 1) return byFirst[0].cvId;
  return null;
}

/**
 * Busca cvId usable en el archivo permanente por teléfono y, si no, por nombre.
 * @param {string} phone
 * @param {{ name?: string }} [opts]
 * @returns {string|null}
 */
function lookupCvIdFromArchive(phone, opts = {}) {
  const key = String(phone || '').trim();
  const list = listUsableArchiveCvs();
  if (key && !key.startsWith('lid_')) {
    const hit = list.find((c) => contactHistory.phonesMatch(c.telefono, key));
    if (hit) return hit.cvId;
  }

  const name = String(opts.name || '').trim();
  if (name) return lookupCvIdByName(name);
  return null;
}

/**
 * Solo devuelve cvId si el PDF existe en disco (evita ids viejos en Mongo sin archivo).
 * Teléfono primero; si falla, un CV cargado con el mismo nombre.
 * @param {{ leadCv?: object|null, contactSession?: object|null, phone?: string, name?: string }} args
 */
function resolveUsableCvId({ leadCv, contactSession, phone, name } = {}) {
  const fromLead = String((leadCv && leadCv.cvId) || '').trim();
  const fromSession = String((contactSession && contactSession.cvId) || '').trim();
  const candidates = [fromLead, fromSession].filter(Boolean);

  for (const id of candidates) {
    if (cvFileStore.getCvFileMeta(id)) return id;
  }

  const resolvedName =
    String(name || (contactSession && contactSession.name) || (leadCv && leadCv.nombre) || '').trim();
  const fromArchive = lookupCvIdFromArchive(phone, { name: resolvedName });
  if (fromArchive) return fromArchive;

  const reason = !candidates.length
    ? 'no_cv_id_for_phone_or_name'
    : 'cv_file_missing_on_disk';
  console.warn(
    `[auto-reply] resolveUsableCvId=null phone=${phone || '?'} name=${resolvedName || 'null'} ` +
      `reason=${reason} leadCvId=${fromLead || 'null'} sessionCvId=${fromSession || 'null'}`
  );
  return null;
}

function isUsableProspectPhone(phone) {
  const raw = String(phone || '').trim();
  if (!raw || raw === 'No encontrado' || raw === 'N/A') return false;
  if (raw.startsWith('lid_')) return false;
  const digits = contactHistory.normalizePhone(raw);
  return digits.length >= 10;
}

/**
 * Tras un envío OK: fija teléfono → cvId en el archivo permanente (mesa puede vaciarse).
 * No persiste a disco; el caller debe saveCvsManifest / persistCvsData.
 * @param {Array} archive
 * @param {{ phone?: string, cvId?: string|null, name?: string, archivoOriginal?: string|null }} link
 * @returns {{ ok: boolean, reason: string, cvId?: string, cvs: Array }}
 */
function bindProspectCvLink(archive, { phone, cvId, name, archivoOriginal } = {}) {
  const list = Array.isArray(archive)
    ? archive.map((c) => (c && typeof c === 'object' ? { ...c } : c))
    : [];
  const id = String(cvId || '').trim();
  if (!id) return { ok: false, reason: 'no_cvId', cvs: list };
  if (!isUsableProspectPhone(phone)) {
    return { ok: false, reason: 'skipped_bad_phone', cvs: list };
  }
  if (!cvFileStore.getCvFileMeta(id)) {
    return { ok: false, reason: 'missing_pdf', cvs: list };
  }

  const phoneStr = String(phone).trim();
  const trimmedName = name != null ? String(name).trim() : '';
  const idx = list.findIndex((c) => c && c.cvId === id);

  if (idx < 0) {
    list.push({
      cvId: id,
      telefono: phoneStr,
      nombre: trimmedName || 'Sin nombre',
      archivoOriginal: archivoOriginal || null,
      procesado: true,
      inWorkspace: false,
      savedAt: new Date().toISOString()
    });
  } else {
    const next = { ...list[idx], telefono: phoneStr, procesado: list[idx].procesado !== false };
    if (trimmedName) next.nombre = trimmedName;
    if (archivoOriginal) next.archivoOriginal = String(archivoOriginal);
    list[idx] = next;
  }

  return { ok: true, reason: 'bound', cvId: id, cvs: list };
}

/**
 * Al enviar, el cliente puede traer teléfono/nombre editados: hay que
 * reflejarlos en el archivo permanente (relación teléfono ↔ cvId).
 * @param {Array} archive
 * @param {Array} editedCvs
 */
function syncClientCvEditsIntoArchive(archive, editedCvs) {
  const list = Array.isArray(archive) ? [...archive] : [];
  for (const edited of Array.isArray(editedCvs) ? editedCvs : []) {
    if (!edited || typeof edited !== 'object') continue;
    const idx = list.findIndex(
      (cv) =>
        cv &&
        ((edited.cvId && cv.cvId === edited.cvId) ||
          (edited.archivoOriginal && cv.archivoOriginal === edited.archivoOriginal))
    );
    if (idx < 0) continue;
    const next = { ...list[idx] };
    if (edited.saludo != null) next.saludo = edited.saludo;
    if (edited.mensajeIA != null) next.mensajeIA = edited.mensajeIA;
    if (edited.telefono != null && String(edited.telefono).trim()) {
      next.telefono = String(edited.telefono).trim();
    }
    if (edited.nombre != null && String(edited.nombre).trim()) {
      next.nombre = String(edited.nombre).trim();
    }
    if (edited.cvId) next.cvId = edited.cvId;
    list[idx] = next;
  }
  return list;
}

module.exports = {
  lookupCvIdFromArchive,
  resolveUsableCvId,
  syncClientCvEditsIntoArchive,
  bindProspectCvLink,
  isUsableProspectPhone
};
