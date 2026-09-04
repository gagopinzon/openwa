const cvFileStore = require('./cvFileStore');
const contactHistory = require('./contactHistoryStore');
const cvAnalysisService = require('./cvAnalysisService');
const { verifyPdfReadable } = require('./pdfProcessor');

/**
 * Guarda un CV de lead (p. ej. PDF recibido por WhatsApp) en disco + manifiesto.
 * @param {Buffer} buffer
 * @param {string} originalName
 * @param {{ telefono?: string, nombre?: string, contactKey?: string, fromConversation?: boolean }} [opts]
 */
async function ingestLeadCvFromBuffer(buffer, originalName, opts = {}) {
  if (!buffer || !Buffer.isBuffer(buffer) || !buffer.length) {
    const err = new Error('Archivo vacío');
    err.status = 400;
    throw err;
  }

  const fromConversation = opts.fromConversation !== false;
  const readable = await verifyPdfReadable(buffer);
  if (!readable) {
    const err = new Error(
      'El archivo no es un PDF legible (WhatsApp a veces envía el documento sin descifrar)'
    );
    err.status = 400;
    err.code = 'invalid_pdf';
    throw err;
  }

  const saved = cvFileStore.saveCvFile(buffer, originalName || 'cv.pdf');
  let cvData = {
    nombre: String(opts.nombre || 'Candidato').trim() || 'Candidato',
    telefono: String(opts.telefono || '').trim() || 'No encontrado',
    experiencia: '',
    textoCompleto: '',
    procesado: true
  };

  try {
    const analyzed = await cvAnalysisService.analyzeCvBuffer(buffer, {
      nombre: cvData.nombre,
      telefono: cvData.telefono
    });
    cvData = {
      ...cvData,
      ...analyzed,
      procesado: true
    };
    if (opts.telefono) cvData.telefono = String(opts.telefono).trim();
    if (opts.nombre && String(opts.nombre).trim()) {
      cvData.nombre = String(opts.nombre).trim();
    }
    console.log(
      `[cvIngest] análisis ${analyzed.analysisProvider || cvAnalysisService.getProvider()} cvId=${saved.cvId}`
    );
  } catch (parseErr) {
    console.warn('[cvIngest] análisis parcial:', parseErr.message);
    if (opts.nombre) cvData.nombre = String(opts.nombre).trim();
  }

  const entry = {
    ...cvData,
    archivoOriginal: originalName || 'cv.pdf',
    cvId: saved.cvId,
    cvFileName: saved.cvFileName,
    saludo: '',
    mensajeIA: '',
    procesado: true,
    fromConversation,
    inWorkspace: false,
    savedAt: new Date().toISOString()
  };

  let cvs = cvFileStore.loadCvsManifest();
  const norm = contactHistory.normalizePhone(entry.telefono);
  if (norm) {
    const prev = cvs.find(
      (c) =>
        c &&
        c.cvId &&
        c.cvId !== entry.cvId &&
        contactHistory.phonesMatch(c.telefono, entry.telefono)
    );
    if (prev && prev.cvId) cvFileStore.retireCvFileToHistory(prev.cvId);

    const idx = cvs.findIndex(
      (c) => contactHistory.normalizePhone(c.telefono) === norm && c.cvId
    );
    if (idx >= 0) {
      cvs[idx] = { ...cvs[idx], ...entry };
    } else {
      cvs.push(entry);
    }
  } else {
    cvs.push(entry);
  }

  cvFileStore.saveCvsManifest(cvs);

  const contactKey = String(opts.contactKey || opts.telefono || '').trim();
  if (contactKey) {
    await contactHistory.linkCvToContact(contactKey, {
      cvId: entry.cvId,
      archivoOriginal: entry.archivoOriginal,
      name: entry.nombre
    });
  } else if (contactHistory.normalizePhone(entry.telefono)) {
    await contactHistory.recordSuccessfulContact({
      normalizedPhone: contactHistory.normalizePhone(entry.telefono),
      name: entry.nombre,
      cvId: entry.cvId,
      archivoOriginal: entry.archivoOriginal
    });
  }

  return { cvId: entry.cvId, entry };
}

module.exports = {
  ingestLeadCvFromBuffer,
  verifyPdfReadable
};
