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
  syncClientCvEditsIntoArchive
};
