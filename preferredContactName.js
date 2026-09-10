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
 * @param {string} value
 */
function foldNameKey(value) {
  return String(value || '')
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9\s]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
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
 * Resuelve el nombre para IA (nunca WhatsApp pushName / sessionName).
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

  // sessionName suele ser pushName de WhatsApp (jymmy, etc.). Nunca usarlo para la IA.
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

/**
 * ¿El nick de WhatsApp es distinto del nombre del CV?
 * @param {unknown} whatsappName
 * @param {unknown} preferredName
 */
function whatsappNameDiffers(whatsappName, preferredName) {
  const wa = normalizePreferredName(whatsappName);
  const pref = normalizePreferredName(preferredName);
  if (!wa) return false;
  if (!pref) return true;
  const waFold = foldNameKey(wa);
  const prefFold = foldNameKey(pref);
  if (waFold === prefFold) return false;
  const waFirst = foldNameKey(preferredFirstName(wa));
  const prefFirst = foldNameKey(preferredFirstName(pref));
  if (waFirst && prefFirst && waFirst === prefFirst) return false;
  return true;
}

/**
 * Bloque de prompt: prohíbe el nick de WhatsApp.
 * @param {{ whatsappName?: string|null, preferredName?: string|null }} args
 * @returns {string}
 */
function buildWhatsAppNameGuard(args = {}) {
  const wa = normalizePreferredName(args.whatsappName);
  const pref = normalizePreferredName(args.preferredName);
  if (!wa || !whatsappNameDiffers(wa, pref)) return '';

  const firstPref = preferredFirstName(pref);
  if (firstPref) {
    return (
      `NOMBRE — REGLA CRÍTICA:\n` +
      `- Nombre correcto del lead (CV/pitch): "${firstPref}" (completo: "${pref}").\n` +
      `- PROHIBIDO usar su nombre/alias de WhatsApp "${wa}" (o variantes). NUNCA lo saludes así.\n` +
      `- Si saludas o te diriges a la persona, usa solo "${firstPref}".`
    );
  }
  return (
    `NOMBRE — REGLA CRÍTICA:\n` +
    `- PROHIBIDO usar su nombre/alias de WhatsApp "${wa}" (o variantes).\n` +
    `- No conocemos el nombre del CV: habla de forma genérica, sin "Hola [nombre]".`
  );
}

/**
 * Quita o reemplaza el nick de WhatsApp si el modelo lo coló en el reply.
 * @param {string} text
 * @param {{ whatsappName?: string|null, preferredName?: string|null }} args
 * @returns {string}
 */
function sanitizeReplyWhatsAppName(text, args = {}) {
  const raw = String(text || '');
  const wa = normalizePreferredName(args.whatsappName);
  const pref = normalizePreferredName(args.preferredName);
  if (!raw || !wa || !whatsappNameDiffers(wa, pref)) return raw;

  const replacement = preferredFirstName(pref);
  const variants = [...new Set([wa, preferredFirstName(wa)].filter(Boolean))].sort(
    (a, b) => b.length - a.length
  );

  let out = raw;
  for (const variant of variants) {
    const escaped = variant.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const re = new RegExp(`\\b${escaped}\\b`, 'gi');
    if (replacement) {
      out = out.replace(re, replacement);
    } else {
      out = out.replace(re, '');
    }
  }

  return out
    .replace(/\s{2,}/g, ' ')
    .replace(/\s+([,.;:!?])/g, '$1')
    .replace(/(Hola|Qué tal|Que tal|Buenas)\s*,/gi, '$1')
    .replace(/\s+\n/g, '\n')
    .trim();
}

module.exports = {
  normalizePreferredName,
  preferredFirstName,
  resolveAiContactName,
  phraseWithName,
  whatsappNameDiffers,
  buildWhatsAppNameGuard,
  sanitizeReplyWhatsAppName
};
