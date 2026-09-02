const axios = require('axios');

function agendaDebugEnabled() {
  const raw = String(process.env.AGENDA_DEBUG || 'true').trim().toLowerCase();
  return raw !== 'false' && raw !== '0' && raw !== 'no';
}

/**
 * Oculta el token firmado en URLs de CV público.
 * @param {string} url
 */
function redactCvUrl(url) {
  return String(url || '').replace(/([?&]token=)[^&]+/i, '$1***');
}

/**
 * @param {unknown} value
 * @param {number} [maxLen]
 */
function clip(value, maxLen = 500) {
  const text =
    typeof value === 'string'
      ? value
      : value == null
        ? ''
        : JSON.stringify(value);
  if (text.length <= maxLen) return text;
  return `${text.slice(0, maxLen)}…`;
}

/**
 * @param {string} step
 * @param {Record<string, unknown>} [fields]
 */
function logAgenda(step, fields = {}) {
  if (!agendaDebugEnabled()) return;
  const safe = { ...fields };
  if (safe.cvUrl) safe.cvUrl = redactCvUrl(safe.cvUrl);
  if (safe.url) safe.url = redactCvUrl(safe.url);
  console.log(`[agenda-debug] ${step} ${clip(safe, 4000)}`);
}

/**
 * @param {string} step
 * @param {Record<string, unknown>} [fields]
 */
function warnAgenda(step, fields = {}) {
  const safe = { ...fields };
  if (safe.cvUrl) safe.cvUrl = redactCvUrl(safe.cvUrl);
  if (safe.panelBody) safe.panelBody = clip(safe.panelBody, 2000);
  console.warn(`[agenda-debug] ${step} ${clip(safe, 4000)}`);
}

/**
 * Comprueba si la cvUrl pública responde (útil en servidores locales).
 * @param {string} cvUrl
 */
async function probeCvPublicUrl(cvUrl) {
  const url = String(cvUrl || '').trim();
  if (!url) {
    return { ok: false, reason: 'cvUrl_vacia' };
  }
  try {
    const res = await axios.head(url, {
      timeout: 12000,
      maxRedirects: 5,
      validateStatus: () => true
    });
    const contentType = String(res.headers['content-type'] || '');
    return {
      ok: res.status >= 200 && res.status < 300,
      status: res.status,
      contentType,
      contentLength: res.headers['content-length'] || null
    };
  } catch (error) {
    return {
      ok: false,
      reason: error.code || error.message,
      status: error.response?.status || null
    };
  }
}

module.exports = {
  agendaDebugEnabled,
  redactCvUrl,
  clip,
  logAgenda,
  warnAgenda,
  probeCvPublicUrl
};
