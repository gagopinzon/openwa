/** Nombre fijo que se usaba antes en las plantillas */
const LEGACY_SENDER = 'Mónica González';

/** Marcador reemplazado al enviar según la sesión de WhatsApp */
const SENDER_PLACEHOLDER = '{{SENDER_NAME}}';

const ATTE_BLOCK_RE = /\r?\n*\s*Atte:\s*\r?\n?[\s\S]*$/i;

/**
 * @param {object|null|undefined} raw
 * @returns {string}
 */
function extractProfileNameFromOpenWA(raw) {
  if (!raw || typeof raw !== 'object') return '';
  return String(
    raw.profileName || raw.pushName || raw.displayName || raw.name || ''
  ).trim();
}

/**
 * Reescribe el bloque "Atte:" con la firma dada. No toca el cuerpo.
 * @param {string} message
 * @param {string} signatureLine
 * @param {{ appendIfMissing?: boolean }} [opts]
 * @returns {string}
 */
function setAtteSignature(message, signatureLine, opts = {}) {
  if (!message) return message;
  const name = String(signatureLine || '').trim();
  if (!name) return message;

  const body = String(message);
  const signature = `\n\nAtte:\n${name}`;
  if (/\bAtte:/i.test(body)) {
    return body.replace(ATTE_BLOCK_RE, signature);
  }
  if (opts.appendIfMissing) {
    return `${body.trim()}${signature}`;
  }
  return body;
}

/**
 * Tras generar el primer mensaje: la firma queda como placeholder,
 * aunque el modelo haya puesto Pro Talent, [YOUR_NAME] u otro texto.
 * @param {string} message
 * @returns {string}
 */
function ensureSenderPlaceholder(message) {
  return setAtteSignature(message, SENDER_PLACEHOLDER, { appendIfMissing: true });
}

/**
 * @param {string} message
 * @param {string} senderName
 * @returns {string}
 */
function applySenderName(message, senderName) {
  if (!message) return message;
  const name = String(senderName || '').trim();
  if (!name) return message;

  let result = String(message);
  result = result.split(SENDER_PLACEHOLDER).join(name);
  result = result.split('{{sender_name}}').join(name);
  result = result.split('{{Sender Name}}').join(name);

  return setAtteSignature(result, name);
}

/**
 * Nombre del remitente para una sesión lógica guardada.
 * @param {{ senderName?: string, label?: string, id?: string }|null|undefined} session
 * @param {string} [fallbackId]
 * @returns {string}
 */
function resolveSessionSenderName(session, fallbackId = '') {
  if (!session) return String(fallbackId || '').trim();
  const senderName = String(session.senderName || '').trim();
  if (senderName) return senderName;
  const label = String(session.label || '').trim();
  if (label) return label;
  return String(session.id || fallbackId || '').trim();
}

module.exports = {
  LEGACY_SENDER,
  SENDER_PLACEHOLDER,
  extractProfileNameFromOpenWA,
  setAtteSignature,
  ensureSenderPlaceholder,
  applySenderName,
  resolveSessionSenderName
};
