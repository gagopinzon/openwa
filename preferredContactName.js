/**
 * Nombre preferido para dirigirse al lead en respuestas IA.
 * Fuente: CV / pitch — nunca pushName de WhatsApp.
 */

const PLACEHOLDER_NAMES = new Set(['(sin nombre)', 'sin nombre', 'contacto', 'amigo']);

/**
 * @param {unknown} raw
 * @returns {string} nombre limpio o ''
 */
function normalizePreferredName(raw) {
  const cleaned = String(raw || '')
    .trim()
    .replace(/^No encontrado$/i, '');
  if (!cleaned) return '';
  if (PLACEHOLDER_NAMES.has(cleaned.toLowerCase())) return '';
  return cleaned;
}

/**
 * Primer nombre capitalizado, o '' si no hay nombre usable.
 * @param {unknown} fullName
 * @returns {string}
 */
function preferredFirstName(fullName) {
  const cleaned = normalizePreferredName(fullName);
  if (!cleaned) return '';
  const first = cleaned.split(/\s+/)[0] || '';
  if (!first) return '';
  return first.charAt(0).toLocaleUpperCase('es') + first.slice(1).toLocaleLowerCase('es');
}

/**
 * Resuelve el nombre para IA (nunca WhatsApp pushName).
 * @param {{
 *   preferredName?: string|null,
 *   sessionName?: string|null,
 *   leadCvNombre?: string|null,
 *   cvId?: string|null,
 *   lastOutboundAt?: string|Date|null
 * }} args
 * @returns {string|null} nombre completo usable, o null
 */
function resolveAiContactName(args = {}) {
  const fromPreferred = normalizePreferredName(args.preferredName);
  if (fromPreferred) return fromPreferred;

  const fromCv = normalizePreferredName(args.leadCvNombre);
  if (fromCv) return fromCv;

  const hasOutboundTrust = Boolean(
    String(args.cvId || '').trim() || args.lastOutboundAt
  );
  if (hasOutboundTrust) {
    const fromSession = normalizePreferredName(args.sessionName);
    if (fromSession) return fromSession;
  }

  return null;
}

/**
 * Inserta el nombre en frases tipo "Perfecto, Ana." → sin nombre: "Perfecto."
 * @param {string} lead e.g. "Perfecto"
 * @param {string} name primer nombre o ''
 * @returns {string}
 */
function phraseWithName(lead, name) {
  const base = String(lead || '').trim();
  const n = preferredFirstName(name);
  if (!base) return n;
  if (!n) return base;
  return `${base}, ${n}`;
}

module.exports = {
  normalizePreferredName,
  preferredFirstName,
  resolveAiContactName,
  phraseWithName
};
