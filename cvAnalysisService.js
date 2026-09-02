const ollamaService = require('./ollamaService');
const cvFileStore = require('./cvFileStore');
const { extractTextFromPDF, extractCVData } = require('./pdfProcessor');

const EMAIL_RE = /[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/g;
const PHONE_RE = /(?:\+?52)?\s*\(?\d{2,3}\)?[\s.-]?\d{3,4}[\s.-]?\d{4}/g;

function getProvider() {
  const explicit = String(process.env.CV_ANALYSIS_PROVIDER || '').trim().toLowerCase();
  if (explicit === 'ollama' || explicit === 'regex' || explicit === 'deepseek') {
    return explicit;
  }
  if (ollamaService.isConfigured()) return 'ollama';
  return 'regex';
}

/**
 * @param {string} raw
 */
function parseJsonObject(raw) {
  const text = String(raw || '').trim();
  if (!text) return null;
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/i);
  const candidate = fenced ? fenced[1].trim() : text;
  const start = candidate.indexOf('{');
  const end = candidate.lastIndexOf('}');
  if (start < 0 || end <= start) return null;
  try {
    return JSON.parse(candidate.slice(start, end + 1));
  } catch {
    return null;
  }
}

/**
 * @param {Buffer} buffer
 */
function extractLooseSignalsFromPdfBuffer(buffer) {
  const latin = buffer.toString('latin1');
  const utf8 = buffer.toString('utf8');
  const blob = `${latin}\n${utf8}`;
  const emails = [...new Set((blob.match(EMAIL_RE) || []).map((e) => e.toLowerCase()))];
  const phones = [...new Set((blob.match(PHONE_RE) || []).map((p) => p.trim()))];
  return { emails, phones };
}

/**
 * @param {string} text
 * @param {{ nombre?: string, telefono?: string, emails?: string[] }} [hints]
 */
function normalizeLeadFromRegex(text, hints = {}) {
  const base = extractCVData(text);
  const emails = hints.emails || [];
  const email =
    emails.find((e) => e.includes('@')) ||
    (String(text).match(EMAIL_RE) || [])[0] ||
    null;

  return {
    nombre:
      String(hints.nombre || base.nombre || '').trim() ||
      'Candidato',
    telefono:
      String(hints.telefono || base.telefono || '').trim() ||
      'No encontrado',
    correo: email || '',
    leadCorreo: email || '',
    email: email || '',
    experiencia: base.experiencia || '',
    textoCompleto: text,
    ciudad: '',
    estado: '',
    leadCiudad: '',
    leadEstado: '',
    analysisProvider: 'regex'
  };
}

/**
 * @param {string} text
 * @param {{ nombre?: string, telefono?: string, emails?: string[] }} [hints]
 */
async function analyzeCvTextWithOllama(text, hints = {}) {
  const snippet = String(text || '').trim().slice(0, 12000);
  if (!snippet) {
    return normalizeLeadFromRegex('', hints);
  }

  const prompt =
    'Analiza este CV y responde SOLO con JSON válido (sin markdown) con estas claves:\n' +
    '{"nombre":"","email":"","telefono":"","ciudad":"","estado":"","experienciaResumen":""}\n' +
    'Si no encuentras un dato, usa cadena vacía.\n\n' +
    `CV:\n${snippet}`;

  const raw = await ollamaService.chatReply(prompt, {
    systemExtra:
      'Eres un extractor de datos de CV. Devuelve únicamente JSON válido, sin explicaciones.'
  });
  const parsed = parseJsonObject(raw);
  if (!parsed || typeof parsed !== 'object') {
    const fallback = normalizeLeadFromRegex(snippet, hints);
    fallback.analysisProvider = 'ollama_fallback_regex';
    return fallback;
  }

  const email = String(parsed.email || parsed.correo || parsed.leadCorreo || '').trim();
  const telefono =
    String(parsed.telefono || parsed.phone || hints.telefono || '').trim() ||
    'No encontrado';

  return {
    nombre: String(parsed.nombre || hints.nombre || 'Candidato').trim() || 'Candidato',
    telefono,
    correo: email,
    leadCorreo: email,
    email,
    experiencia: String(parsed.experienciaResumen || parsed.experiencia || '').trim(),
    textoCompleto: snippet,
    ciudad: String(parsed.ciudad || '').trim(),
    estado: String(parsed.estado || '').trim(),
    leadCiudad: String(parsed.ciudad || '').trim(),
    leadEstado: String(parsed.estado || '').trim(),
    analysisProvider: 'ollama'
  };
}

/**
 * @param {string} text
 * @param {{ nombre?: string, telefono?: string, emails?: string[] }} [opts]
 */
async function analyzeCvText(text, opts = {}) {
  const provider = getProvider();
  if (provider === 'ollama' && ollamaService.isConfigured()) {
    try {
      return await analyzeCvTextWithOllama(text, opts);
    } catch (error) {
      console.warn('[cvAnalysis] Ollama falló, uso regex:', error.message);
      const fallback = normalizeLeadFromRegex(text, opts);
      fallback.analysisProvider = 'regex_after_ollama_error';
      return fallback;
    }
  }
  return normalizeLeadFromRegex(text, opts);
}

/**
 * @param {Buffer} buffer
 * @param {{ nombre?: string, telefono?: string }} [opts]
 */
async function analyzeCvBuffer(buffer, opts = {}) {
  const loose = extractLooseSignalsFromPdfBuffer(buffer);
  const hints = {
    nombre: opts.nombre,
    telefono: opts.telefono,
    emails: loose.emails
  };

  let text = '';
  try {
    text = await extractTextFromPDF(buffer, { silent: true, maxPages: 8 });
  } catch (error) {
    console.warn('[cvAnalysis] pdf-parse:', error.message);
  }

  if (!text || text.length < 40) {
    const joined = [
      hints.nombre ? `Nombre: ${hints.nombre}` : '',
      hints.telefono ? `Teléfono: ${hints.telefono}` : '',
      loose.emails.length ? `Emails: ${loose.emails.join(', ')}` : '',
      loose.phones.length ? `Teléfonos: ${loose.phones.join(', ')}` : ''
    ]
      .filter(Boolean)
      .join('\n');
    text = joined || text;
  }

  const analyzed = await analyzeCvText(text, hints);
  if (!analyzed.correo && loose.emails[0]) {
    analyzed.correo = loose.emails[0];
    analyzed.leadCorreo = loose.emails[0];
    analyzed.email = loose.emails[0];
  }
  if (
    (!analyzed.telefono || analyzed.telefono === 'No encontrado') &&
    loose.phones[0]
  ) {
    analyzed.telefono = loose.phones[0];
  }
  return analyzed;
}

/**
 * Re-analiza el CV en disco si faltan datos clave (p. ej. email para el panel).
 * @param {string} cvId
 * @param {{ nombre?: string, telefono?: string, force?: boolean }} [opts]
 */
async function ensureCvAnalyzed(cvId, opts = {}) {
  const id = String(cvId || '').trim();
  if (!id) return null;

  const existing =
    (cvFileStore.loadCvsManifest() || []).find((c) => c && c.cvId === id) || null;
  const buffer = cvFileStore.readCvFileBuffer(id);
  if (!buffer) return existing;

  const hasEmail = [existing?.leadCorreo, existing?.correo, existing?.email].some(
    (value) => value && String(value).includes('@')
  );
  if (hasEmail && !opts.force) return existing;

  const analyzed = await analyzeCvBuffer(buffer, {
    nombre: opts.nombre || existing?.nombre,
    telefono: opts.telefono || existing?.telefono
  });
  const patch = {
    ...analyzed,
    analyzedAt: new Date().toISOString()
  };
  return cvFileStore.updateCvEntry(id, patch) || { ...existing, ...patch, cvId: id };
}

/**
 * Estructura de analisisCV que el panel acepta cuando Msg ya analizó con Ollama.
 * @param {object} lead
 */
function buildPanelAnalisisCv(lead = {}) {
  const nombre = String(lead.nombre || lead.leadNombre || '').trim();
  const email = String(
    lead.leadCorreo || lead.correo || lead.email || ''
  ).trim();
  const telefono = String(lead.telefono || lead.leadTelefono || '').trim();
  const ciudad = String(lead.leadCiudad || lead.ciudad || '').trim();
  const estado = String(lead.leadEstado || lead.estado || '').trim();
  const experiencia = String(lead.experiencia || '').trim();
  const puestoPrincipal = experiencia
    ? experiencia.split(/\s+/).slice(0, 5).join(' ')
    : 'Candidato';

  return {
    contacto: {
      nombre,
      email,
      telefono
    },
    localidad: {
      ciudad,
      estado
    },
    puesto: [puestoPrincipal, 'Profesional', 'Especialista', 'Consultor'],
    ultimaExperiencia: experiencia ? experiencia.slice(0, 280) : '',
    evaluaciones: {
      estructura: { puntuacion: 7, explicacion: 'Análisis preliminar Msg/Ollama' },
      perfil: { puntuacion: 7, explicacion: 'Análisis preliminar Msg/Ollama' },
      experiencia: { puntuacion: 7, explicacion: 'Análisis preliminar Msg/Ollama' },
      visibilidad: { puntuacion: 7, explicacion: 'Análisis preliminar Msg/Ollama' },
      empleabilidad: { puntuacion: 7, explicacion: 'Análisis preliminar Msg/Ollama' }
    },
    recomendaciones: [],
    origenAnalisis: lead.analysisProvider || getProvider(),
    textoExtraido: String(lead.textoCompleto || '').slice(0, 12000)
  };
}

/**
 * @param {object} lead
 */
function buildPanelLeadExtraido(lead = {}) {
  const leadCorreo = String(
    lead.leadCorreo || lead.correo || lead.email || ''
  ).trim();
  const leadTelefono = String(lead.telefono || lead.leadTelefono || '').trim();
  return {
    leadNombre: String(lead.nombre || lead.leadNombre || '').trim() || undefined,
    leadCorreo: leadCorreo.includes('@') ? leadCorreo : undefined,
    leadTelefono:
      leadTelefono && leadTelefono !== 'No encontrado' ? leadTelefono : undefined,
    leadCiudad: String(lead.leadCiudad || lead.ciudad || '').trim() || undefined,
    leadEstado: String(lead.leadEstado || lead.estado || '').trim() || undefined,
    experiencia: String(lead.experiencia || '').trim() || undefined
  };
}

/**
 * @param {string} cvId
 * @param {{ nombre?: string, telefono?: string }} [opts]
 */
async function buildPanelAgendaExtras(cvId, opts = {}) {
  const enriched =
    (await ensureCvAnalyzed(cvId, { ...opts, force: true })) || null;
  const leadExtraido = buildPanelLeadExtraido(enriched || {});
  const analisisCV = buildPanelAnalisisCv(enriched || {});
  const cvAnalizadoEnMsg =
    Boolean(leadExtraido.leadCorreo) && getProvider() === 'ollama';
  return { enriched, leadExtraido, analisisCV, cvAnalizadoEnMsg };
}

module.exports = {
  getProvider,
  analyzeCvText,
  analyzeCvBuffer,
  ensureCvAnalyzed,
  buildPanelAnalisisCv,
  buildPanelLeadExtraido,
  buildPanelAgendaExtras,
  extractLooseSignalsFromPdfBuffer,
  parseJsonObject
};
