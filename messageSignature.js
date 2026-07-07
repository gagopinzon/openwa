/** Nombre fijo que se usaba antes en las plantillas */
const LEGACY_SENDER = 'Mónica González';

/** Marcador reemplazado al enviar según la sesión de WhatsApp */
const SENDER_PLACEHOLDER = '{{SENDER_NAME}}';

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
 * @param {string} message
 * @param {string} senderName
 * @returns {string}
 */
function applySenderName(message, senderName) {
  if (!message) return message;
  const name = String(senderName || '').trim();
  if (!name) return message;

  let result = message.split(SENDER_PLACEHOLDER).join(name);

  const legacyPattern = new RegExp(
    `(\\nAtte:\\s*\\n)\\s*${LEGACY_SENDER.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\s*$`,
    'i'
  );
  if (legacyPattern.test(result)) {
    result = result.replace(legacyPattern, `$1${name}`);
  }

  return result;
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
  applySenderName,
  resolveSessionSenderName
};
