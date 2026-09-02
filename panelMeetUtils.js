/**
 * Extrae la liga de Meet para el candidato desde la respuesta del panel.
 * @param {object|null|undefined} panelData
 * @returns {string|null}
 */
function extractMeetUrlFromPanel(panelData) {
  if (!panelData || typeof panelData !== 'object') return null;

  const reunion = panelData.reunion && typeof panelData.reunion === 'object'
    ? panelData.reunion
    : null;
  const urls = panelData.urls && typeof panelData.urls === 'object' ? panelData.urls : null;

  const candidates = [
    panelData.urlReunion,
    panelData.urlReunionLead,
    reunion?.urlReunion,
    reunion?.urlReunionLead,
    panelData.meetUrl,
    reunion?.meetUrl,
    panelData.googleMeetUrl,
    reunion?.googleMeetUrl,
    panelData.hangoutLink,
    reunion?.hangoutLink,
    panelData.participantUrl,
    reunion?.participantUrl,
    urls?.lead,
    urls?.participante,
    urls?.participant,
    panelData.link,
    reunion?.link
  ];

  for (const value of candidates) {
    const url = normalizeMeetUrl(value);
    if (url) return url;
  }
  return null;
}

/**
 * @param {unknown} value
 * @returns {string|null}
 */
function normalizeMeetUrl(value) {
  const url = String(value || '').trim();
  if (!url) return null;
  if (!/^https?:\/\//i.test(url)) return null;
  return url;
}

/**
 * Errores del panel que suelen resolverse reintentando (CV en análisis, timeout, etc.).
 * @param {Error|{ message?: string, status?: number }} error
 */
function isRetryablePanelError(error) {
  const status = Number(error && error.status);
  const msg = String((error && error.message) || '').toLowerCase();
  if (status === 408 || status === 429 || status === 502 || status === 503 || status === 504) {
    return true;
  }
  return (
    msg.includes('timeout') ||
    msg.includes('timed out') ||
    msg.includes('econnaborted') ||
    msg.includes('econnreset') ||
    msg.includes('socket hang up') ||
    msg.includes('procesar el cv') ||
    msg.includes('procesando el cv') ||
    msg.includes('análisis deepseek') ||
    msg.includes('analisis deepseek') ||
    msg.includes('descarga del cv') ||
    msg.includes('descargar el cv')
  );
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

module.exports = {
  extractMeetUrlFromPanel,
  normalizeMeetUrl,
  isRetryablePanelError,
  sleep
};
