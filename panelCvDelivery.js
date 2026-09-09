const cvFileStore = require('./cvFileStore');
const { probeCvPublicUrl } = require('./agendaDebug');
const occCvFetchService = require('./occCvFetchService');

const DEFAULT_MAX_CV_BASE64_CHARS = 700000;

function maxCvBase64Chars() {
  const raw = Number(process.env.PANEL_CV_MAX_BASE64_CHARS);
  if (Number.isFinite(raw) && raw > 0) return Math.floor(raw);
  return DEFAULT_MAX_CV_BASE64_CHARS;
}

function isCvBase64TooLarge(cvBase64) {
  return String(cvBase64 || '').length > maxCvBase64Chars();
}

/**
 * Lee el CV local y arma payload base64 para el panel.
 * @param {string} cvId
 * @returns {{ cvBase64: string, cvFileName: string }|null}
 */
function readPanelCvBase64Payload(cvId) {
  const buffer = cvFileStore.readCvFileBuffer(cvId);
  if (!buffer || buffer.length === 0) return null;
  return {
    cvBase64: buffer.toString('base64'),
    cvFileName: cvFileStore.getCvDisplayFilename(cvId)
  };
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
  if (!probe.ok) return null;

  return { delivery: 'url', cvUrl };
}

/**
 * CV para POST /api/external/msg/reuniones: cvUrl (prod) o base64 (local / PDF chico).
 * Antes de armar el payload, descarga desde OCC si el PDF trae liga (solo al agendar).
 * @param {string} cvId
 * @param {{ probeCvUrl?: (url: string) => Promise<object>, skipOccFetch?: boolean }} [opts]
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

  const urlDelivery = await tryPublicUrlDelivery(id, opts);
  if (urlDelivery) return urlDelivery;

  const base64Payload = readPanelCvBase64Payload(id);
  if (base64Payload && !isCvBase64TooLarge(base64Payload.cvBase64)) {
    return {
      delivery: 'base64',
      cvBase64: base64Payload.cvBase64,
      cvFileName: base64Payload.cvFileName
    };
  }

  if (!cvFileStore.getCvFileMeta(id)) {
    const err = new Error('Archivo del CV no está disponible');
    err.status = 404;
    throw err;
  }

  if (base64Payload && isCvBase64TooLarge(base64Payload.cvBase64)) {
    const err = new Error(
      'El CV es demasiado grande para enviarlo en base64 al panel. ' +
        'Configura CV_PUBLIC_URL pública para que el panel descargue el PDF.'
    );
    err.status = 413;
    throw err;
  }

  if (!cvFileStore.isPublicUrlConfigured()) {
    const err = new Error(
      'No hay PDF local ni CV_PUBLIC_URL configurada para enviar el CV al panel'
    );
    err.status = 503;
    throw err;
  }

  const cvUrl = cvFileStore.buildCvPublicUrl(id);
  if (!cvFileStore.isCvUrlReachableByPanel(cvUrl)) {
    const err = new Error(cvFileStore.panelUnreachableCvUrlError(cvUrl));
    err.status = 503;
    throw err;
  }

  const probeFn = opts.probeCvUrl || probeCvPublicUrl;
  const probe = await probeFn(cvUrl);
  if (!probe.ok) {
    const fatal =
      probe.status === 401 || probe.status === 403 || probe.status === 404;
    const err = new Error(cvFileStore.describeCvProbeFailure(cvUrl, probe));
    err.status = fatal ? 503 : 502;
    throw err;
  }

  return {
    delivery: 'url',
    cvUrl
  };
}

module.exports = {
  DEFAULT_MAX_CV_BASE64_CHARS,
  maxCvBase64Chars,
  isCvBase64TooLarge,
  readPanelCvBase64Payload,
  resolvePanelCvDelivery
};
