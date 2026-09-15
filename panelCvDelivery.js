const cvFileStore = require('./cvFileStore');
const { probeCvPublicUrl } = require('./agendaDebug');
const occCvFetchService = require('./occCvFetchService');

const DEFAULT_MAX_CV_FILE_BYTES = 10 * 1024 * 1024;

function maxCvFileBytes() {
  const raw = Number(process.env.PANEL_CV_MAX_FILE_BYTES);
  if (Number.isFinite(raw) && raw > 0) return Math.floor(raw);
  return DEFAULT_MAX_CV_FILE_BYTES;
}

function isFatalCvProbeStatus(status) {
  const n = Number(status);
  return n === 401 || n === 403 || n === 404;
}

/**
 * @param {string} cvId
 * @param {{ probeCvUrl?: (url: string) => Promise<object> }} [opts]
 * @returns {Promise<{ delivery: 'url', cvUrl: string }|null>}
 */
async function tryPublicUrlDelivery(cvId, opts = {}) {
  if (!cvFileStore.getCvFileMeta(cvId)) return null;
  if (!cvFileStore.isPublicUrlConfigured()) return null;

  const cvUrl = cvFileStore.buildCvPublicUrl(cvId);
  if (!cvFileStore.isCvUrlReachableByPanel(cvUrl)) return null;

  const probeFn = opts.probeCvUrl || probeCvPublicUrl;
  const probe = await probeFn(cvUrl);
  if (probe && probe.ok) {
    return { delivery: 'url', cvUrl };
  }

  if (isFatalCvProbeStatus(probe && probe.status)) {
    console.warn(
      '[panel-cv] probe cvUrl fatal, no se envía URL:',
      (probe && probe.status) || '',
      (probe && probe.reason) || ''
    );
    return null;
  }

  console.warn(
    '[panel-cv] probe local de cvUrl falló; se envía URL igual:',
    (probe && probe.status) || '',
    (probe && probe.reason) || 'sin respuesta'
  );
  return { delivery: 'url', cvUrl };
}

/**
 * CV para POST /api/external/msg/reuniones: cvFile (multipart) o cvUrl si el PDF > 10 MB.
 * @param {string} cvId
 * @param {{ probeCvUrl?: (url: string) => Promise<object>, skipOccFetch?: boolean }} [opts]
 * @returns {Promise<
 *   | { delivery: 'file', buffer: Buffer, cvFileName: string, mime: string }
 *   | { delivery: 'url', cvUrl: string }
 * >}
 */
async function resolvePanelCvDelivery(cvId, opts = {}) {
  const id = String(cvId || '').trim();
  if (!id) {
    const err = new Error('cvId es obligatorio');
    err.status = 400;
    throw err;
  }

  if (!opts.skipOccFetch) {
    try {
      await occCvFetchService.ensureOccCvFetched(id);
    } catch (err) {
      console.warn(
        '[occ-cv] ensureOccCvFetched en delivery:',
        err && err.message ? err.message : err
      );
    }
  }

  if (!cvFileStore.getCvFileMeta(id)) {
    const err = new Error('Archivo del CV no está disponible');
    err.status = 404;
    throw err;
  }

  const buffer = cvFileStore.readCvFileBuffer(id);
  if (!buffer || buffer.length === 0) {
    const err = new Error('Archivo del CV no está disponible');
    err.status = 404;
    throw err;
  }

  const maxBytes = maxCvFileBytes();
  if (buffer.length <= maxBytes) {
    const meta = cvFileStore.getCvFileMeta(id);
    return {
      delivery: 'file',
      buffer,
      cvFileName: cvFileStore.getCvDisplayFilename(id),
      mime: (meta && meta.mime) || 'application/pdf'
    };
  }

  const urlDelivery = await tryPublicUrlDelivery(id, opts);
  if (urlDelivery) return urlDelivery;

  if (!cvFileStore.isPublicUrlConfigured()) {
    const err = new Error(
      'El CV es demasiado grande para enviarlo como cvFile al panel. ' +
        'Configura CV_PUBLIC_URL pública para que el panel descargue el PDF.'
    );
    err.status = 413;
    throw err;
  }

  const cvUrl = cvFileStore.buildCvPublicUrl(id);
  if (!cvFileStore.isCvUrlReachableByPanel(cvUrl)) {
    const err = new Error(cvFileStore.panelUnreachableCvUrlError(cvUrl));
    err.status = 413;
    throw err;
  }

  const err = new Error(cvFileStore.describeCvProbeFailure(cvUrl, { reason: 'cvFile demasiado grande' }));
  err.status = 413;
  throw err;
}

/**
 * Campos para panelMsgClient.crearReunion según el delivery.
 * @param {{ delivery?: string, buffer?: Buffer, cvFileName?: string, mime?: string, cvUrl?: string }} delivery
 */
function cvFieldsFromDelivery(delivery) {
  const mode = delivery && delivery.delivery;
  if (mode === 'file') {
    return {
      cvFile: delivery.buffer,
      cvFileName: delivery.cvFileName,
      cvMime: delivery.mime
    };
  }
  if (mode === 'url') {
    return { cvUrl: delivery.cvUrl };
  }
  const err = new Error('Delivery de CV inválido');
  err.status = 400;
  throw err;
}

module.exports = {
  DEFAULT_MAX_CV_FILE_BYTES,
  maxCvFileBytes,
  resolvePanelCvDelivery,
  cvFieldsFromDelivery
};
