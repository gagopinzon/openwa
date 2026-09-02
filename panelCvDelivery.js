const cvFileStore = require('./cvFileStore');
const { probeCvPublicUrl } = require('./agendaDebug');

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
 * CV para POST /api/external/msg/reuniones: base64 (local) o cvUrl (fallback).
 * @param {string} cvId
 * @param {{ probeCvUrl?: (url: string) => Promise<object> }} [opts]
 */
async function resolvePanelCvDelivery(cvId, opts = {}) {
  const id = String(cvId || '').trim();
  if (!id) {
    const err = new Error('cvId es obligatorio');
    err.status = 400;
    throw err;
  }

  const base64Payload = readPanelCvBase64Payload(id);
  if (base64Payload) {
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
  readPanelCvBase64Payload,
  resolvePanelCvDelivery
};
