const cvFileStore = require('./cvFileStore');
const contactHistory = require('./contactHistoryStore');

/**
 * Busca cvId usable en el archivo permanente por teléfono.
 * @param {string} phone
 * @returns {string|null}
 */
function lookupCvIdFromArchive(phone) {
  const key = String(phone || '').trim();
  if (!key) return null;
  const list = cvFileStore.loadCvsManifest() || [];
  const hit = list.find(
    (c) =>
      c &&
      c.procesado &&
      c.cvId &&
      contactHistory.phonesMatch(c.telefono, key) &&
      cvFileStore.getCvFileMeta(c.cvId)
  );
  return hit ? hit.cvId : null;
}

/**
 * Solo devuelve cvId si el PDF existe en disco (evita ids viejos en Mongo sin archivo).
 * Siempre intenta archivo permanente por teléfono si los candidatos fallan.
 * @param {{ leadCv?: object|null, contactSession?: object|null, phone?: string }} args
 */
function resolveUsableCvId({ leadCv, contactSession, phone }) {
  const fromLead = String((leadCv && leadCv.cvId) || '').trim();
  const fromSession = String((contactSession && contactSession.cvId) || '').trim();
  const candidates = [fromLead, fromSession].filter(Boolean);

  for (const id of candidates) {
    if (cvFileStore.getCvFileMeta(id)) return id;
  }

  const fromArchive = phone ? lookupCvIdFromArchive(phone) : null;
  if (fromArchive) return fromArchive;

  const reason = !candidates.length && !fromArchive
    ? 'no_cv_id_for_phone'
    : 'cv_file_missing_on_disk';
  console.warn(
    `[auto-reply] resolveUsableCvId=null phone=${phone || '?'} reason=${reason} ` +
      `leadCvId=${fromLead || 'null'} sessionCvId=${fromSession || 'null'}`
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
