const cvFileStore = require('./cvFileStore');
const cvAnalysisService = require('./cvAnalysisService');
const { parseJsonObject } = require('./cvAnalysisService');

const EMAIL_RE = /[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/;

function getRequiredLeadFields() {
  const raw = String(process.env.AGENDA_REQUIRED_LEAD_FIELDS || 'ciudad,estado').trim();
  if (!raw) return [];
  const allowed = new Set(['ciudad', 'estado', 'email']);
  const out = [];
  for (const part of raw.split(',')) {
    const key = String(part || '').trim().toLowerCase();
    if (key && allowed.has(key) && !out.includes(key)) out.push(key);
  }
  return out;
}

function ollamaForLeadFieldsEnabled() {
  const raw = String(process.env.AGENDA_LEAD_FIELDS_OLLAMA ?? 'true').trim().toLowerCase();
  if (raw === 'false' || raw === '0' || raw === 'no') return false;
  const ollamaService = require('./ollamaService');
  return ollamaService.isConfigured();
}

/**
 * @param {object|null|undefined} cv
 */
function leadFieldSnapshotFromCv(cv) {
  const entry = cv && typeof cv === 'object' ? cv : {};
  return {
    ciudad: String(entry.leadCiudad || entry.ciudad || '').trim(),
    estado: String(entry.leadEstado || entry.estado || '').trim(),
    email: String(entry.leadCorreo || entry.correo || entry.email || '').trim()
  };
}

function hasLeadFieldValue(snapshot, field) {
  const value = snapshot && snapshot[field];
  if (field === 'email') return Boolean(value && String(value).includes('@'));
  return Boolean(String(value || '').trim());
}

/**
 * @param {object} snapshot
 * @param {string[]} [required]
 */
function listMissingLeadFields(snapshot, required = getRequiredLeadFields()) {
  return required.filter((field) => !hasLeadFieldValue(snapshot, field));
}

/**
 * @param {string[]} missingFields
 * @param {object} parsed
 */
function fieldsStillMissingAfterParse(missingFields, parsed = {}) {
  return listMissingLeadFields(
    {
      ciudad: parsed.ciudad || '',
      estado: parsed.estado || '',
      email: parsed.email || ''
    },
    missingFields
  );
}

/**
 * @param {string} text
 * @param {string[]} missingFields
 */
function parseLeadFieldsReply(text, missingFields = []) {
  const raw = String(text || '').trim();
  const missing = Array.isArray(missingFields) ? missingFields : [];
  const out = {};
  if (!raw || !missing.length) return out;

  const needs = new Set(missing);

  if (needs.has('email')) {
    const match = raw.match(EMAIL_RE);
    if (match) out.email = match[0].toLowerCase();
  }

  if (needs.has('ciudad') || needs.has('estado')) {
    const labeled = raw.match(
      /^(.*?)\s*[.,;]\s*estado\s+(.+)$/i
    );
    const commaParts = raw
      .split(',')
      .map((part) => part.trim())
      .filter(Boolean);

    if (labeled) {
      if (needs.has('ciudad') && !out.ciudad) {
        out.ciudad = labeled[1].replace(/\s+estado$/i, '').trim();
      }
      if (needs.has('estado') && !out.estado) {
        out.estado = labeled[2].trim();
      }
    } else if (commaParts.length >= 2) {
      if (needs.has('ciudad') && !out.ciudad) out.ciudad = commaParts[0];
      if (needs.has('estado') && !out.estado) out.estado = commaParts.slice(1).join(', ');
    } else {
      const locationPhrase = raw.match(
        /\b(?:vivo|radico|estoy|soy)\s+(?:en\s+|de\s+)?([^,.!?]+)/i
      );
      if (locationPhrase && needs.has('ciudad') && !out.ciudad) {
        out.ciudad = locationPhrase[1].trim();
      }

      const enMatch = raw.match(/\ben\s+([^,.!?]+)/i);
      if (enMatch && needs.has('ciudad') && !out.ciudad) {
        out.ciudad = enMatch[1].trim();
      }
      const estadoMatch = raw.match(/\bestado\s+([^,.!?]+)/i);
      if (estadoMatch && needs.has('estado')) {
        out.estado = estadoMatch[1].trim();
      }
      if (needs.has('ciudad') && !out.ciudad && commaParts.length === 1) {
        out.ciudad = commaParts[0];
      }
      if (needs.has('estado') && !out.estado && commaParts.length === 1 && !out.ciudad) {
        out.estado = commaParts[0];
      }
    }
  }

  return out;
}

/**
 * @param {object|null|undefined} raw
 * @param {string[]} missingFields
 */
function normalizeOllamaLeadFields(raw, missingFields = []) {
  const parsed = raw && typeof raw === 'object' ? raw : {};
  const missing = new Set(Array.isArray(missingFields) ? missingFields : []);
  const out = {};

  if (missing.has('ciudad')) {
    const ciudad = String(parsed.ciudad || parsed.city || parsed.localidad || '').trim();
    if (ciudad) out.ciudad = ciudad;
  }
  if (missing.has('estado')) {
    const estado = String(parsed.estado || parsed.state || parsed.provincia || '').trim();
    if (estado) out.estado = estado;
  }
  if (missing.has('email')) {
    const email = String(parsed.email || parsed.correo || parsed.leadCorreo || '').trim();
    if (email.includes('@')) out.email = email.toLowerCase();
  }

  return out;
}

/**
 * @param {object} base
 * @param {object} extra
 * @param {string[]} missingFields
 */
function mergeLeadFieldParses(base = {}, extra = {}, missingFields = []) {
  const merged = { ...base };
  const missing = new Set(Array.isArray(missingFields) ? missingFields : []);
  for (const field of ['ciudad', 'estado', 'email']) {
    if (!missing.has(field)) continue;
    if (!merged[field] && extra[field]) merged[field] = extra[field];
  }
  return merged;
}

/**
 * @param {string} text
 * @param {string[]} missingFields
 */
async function parseLeadFieldsWithOllama(text, missingFields = []) {
  const ollamaService = require('./ollamaService');
  const missing = Array.isArray(missingFields) ? missingFields : [];
  if (!missing.length) return {};

  const prompt =
    'El candidato respondió por WhatsApp. Extrae los datos pedidos.\n' +
    `Campos requeridos: ${missing.join(', ')}\n` +
    'Responde ÚNICAMENTE JSON válido sin markdown:\n' +
    '{"ciudad":"","estado":"","email":""}\n' +
    'Reglas:\n' +
    '- México: si menciona solo una ciudad conocida, infiere el estado (Zapopan→Jalisco, Guadalajara→Jalisco, Monterrey→Nuevo León, CDMX→Ciudad de México).\n' +
    '- ciudad y estado: solo el nombre propio, sin "vivo en" ni frases completas.\n' +
    '- Si no puedes inferir un campo con confianza, déjalo vacío.\n\n' +
    `Mensaje del candidato: ${String(text || '').trim()}`;

  const raw = await ollamaService.chatReply(prompt, {
    systemExtra:
      'Extractor de ubicación y contacto para México. Devuelve solo JSON válido, sin explicaciones.'
  });
  const parsed = parseJsonObject(raw);
  if (!parsed || typeof parsed !== 'object') {
    throw new Error('Ollama no devolvió JSON válido');
  }
  return normalizeOllamaLeadFields(parsed, missing);
}

/**
 * Regex primero; Ollama si aún faltan campos (p. ej. inferir estado desde "vivo en Zapopan").
 * @param {string} text
 * @param {string[]} missingFields
 * @param {{ llmParse?: Function }} [opts]
 */
async function parseLeadFieldsReplyAsync(text, missingFields = [], opts = {}) {
  const missing = Array.isArray(missingFields) ? missingFields : [];
  const regexParsed = parseLeadFieldsReply(text, missing);
  const stillMissing = fieldsStillMissingAfterParse(missing, regexParsed);
  if (!stillMissing.length) return regexParsed;

  const llmParse = opts.llmParse || parseLeadFieldsWithOllama;
  if (!opts.llmParse && !ollamaForLeadFieldsEnabled()) return regexParsed;

  try {
    const ollamaParsed = await llmParse(text, stillMissing);
    return mergeLeadFieldParses(regexParsed, ollamaParsed, missing);
  } catch (error) {
    console.warn('[agendaLeadFields] Ollama falló, uso solo regex:', error.message);
    return regexParsed;
  }
}

/**
 * @param {object} parsed
 */
function patchFromParsedLeadFields(parsed = {}) {
  const patch = {};
  if (parsed.ciudad) {
    patch.leadCiudad = parsed.ciudad;
    patch.ciudad = parsed.ciudad;
  }
  if (parsed.estado) {
    patch.leadEstado = parsed.estado;
    patch.estado = parsed.estado;
  }
  if (parsed.email) {
    patch.leadCorreo = parsed.email;
    patch.correo = parsed.email;
    patch.email = parsed.email;
  }
  return patch;
}

/**
 * @param {string} cvId
 * @param {{ nombre?: string, telefono?: string, force?: boolean }} [opts]
 */
async function getMissingLeadFieldsForCv(cvId, opts = {}) {
  const id = String(cvId || '').trim();
  const fromDisk =
    (cvFileStore.loadCvsManifest() || []).find((c) => c && c.cvId === id) || null;
  const missingOnDisk = listMissingLeadFields(leadFieldSnapshotFromCv(fromDisk));
  if (fromDisk && !missingOnDisk.length) return [];

  const enriched =
    (await cvAnalysisService.ensureCvAnalyzed(id, {
      nombre: opts.nombre,
      telefono: opts.telefono,
      force: Boolean(opts.force)
    })) || fromDisk;
  return listMissingLeadFields(leadFieldSnapshotFromCv(enriched));
}

/**
 * @param {string} cvId
 * @param {object} parsed
 */
function applyLeadFieldsToCv(cvId, parsed = {}) {
  const patch = patchFromParsedLeadFields(parsed);
  if (!Object.keys(patch).length) return null;
  return cvFileStore.updateCvEntry(cvId, patch);
}

/**
 * @param {string} contactName
 * @param {string[]} missingFields
 */
function buildAskMissingLeadFieldsReply(contactName, missingFields = []) {
  const name = String(contactName || 'contacto').split(/\s+/)[0] || 'contacto';
  const missing = Array.isArray(missingFields) ? missingFields : [];
  const parts = [];

  if (missing.includes('ciudad') && missing.includes('estado')) {
    parts.push('¿en qué ciudad y estado vives?');
  } else if (missing.includes('ciudad')) {
    parts.push('¿en qué ciudad vives?');
  } else if (missing.includes('estado')) {
    parts.push('¿en qué estado vives?');
  }
  if (missing.includes('email')) {
    parts.push('¿cuál es tu correo electrónico?');
  }

  const ask = parts.length ? parts.join(' También ') : '¿me compartes los datos que faltan de tu CV?';
  return (
    `${name}, para completar tu registro antes de la sesión, ${ask} ` +
    `(por ejemplo: Guadalajara, Jalisco). ☺️`
  );
}

/**
 * @param {string} stage
 */
function isAwaitingLeadData(stage) {
  return String(stage || '').trim() === 'need_lead_data';
}

module.exports = {
  getRequiredLeadFields,
  ollamaForLeadFieldsEnabled,
  leadFieldSnapshotFromCv,
  listMissingLeadFields,
  fieldsStillMissingAfterParse,
  parseLeadFieldsReply,
  parseLeadFieldsReplyAsync,
  parseLeadFieldsWithOllama,
  normalizeOllamaLeadFields,
  mergeLeadFieldParses,
  patchFromParsedLeadFields,
  getMissingLeadFieldsForCv,
  applyLeadFieldsToCv,
  buildAskMissingLeadFieldsReply,
  isAwaitingLeadData
};
