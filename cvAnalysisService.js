const ollamaService = require('./ollamaService');
const cvFileStore = require('./cvFileStore');
const { extractTextFromPDF, extractCVData } = require('./pdfProcessor');
const { logAgenda, warnAgenda } = require('./agendaDebug');
const axios = require('axios');

const EMAIL_RE = /[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/g;
const PHONE_RE = /(?:\+?52)?\s*\(?\d{2,3}\)?[\s.-]?\d{3,4}[\s.-]?\d{4}/g;
const STUB_EVAL_EXPLANATION = 'Análisis preliminar Msg/Ollama';
const EVAL_KEYS = ['estructura', 'perfil', 'experiencia', 'visibilidad', 'empleabilidad'];
const DEEPSEEK_API_URL = 'https://api.deepseek.com/v1/chat/completions';

function getProvider() {
  const explicit = String(process.env.CV_ANALYSIS_PROVIDER || '').trim().toLowerCase();
  if (explicit === 'ollama' || explicit === 'regex' || explicit === 'deepseek') {
    return explicit;
  }
  if (ollamaService.isConfigured()) return 'ollama';
  if (hasDeepSeekKey()) return 'deepseek';
  return 'regex';
}

function hasDeepSeekKey() {
  const key = String(process.env.DEEPSEEK_API_KEY || '').trim();
  return Boolean(key && !key.includes('test') && !key.includes('tu_api_key'));
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

function clampScore(value) {
  const n = Number(value);
  if (!Number.isFinite(n)) return null;
  return Math.max(0, Math.min(10, Math.round(n)));
}

function normalizeEvaluacion(item) {
  if (!item || typeof item !== 'object') return null;
  const puntuacion = clampScore(item.puntuacion);
  const explicacion = String(item.explicacion || '').trim();
  if (puntuacion == null || !explicacion) return null;
  return { puntuacion, explicacion };
}

function normalizeEvaluaciones(ev) {
  if (!ev || typeof ev !== 'object') return null;
  const out = {};
  let any = false;
  for (const key of EVAL_KEYS) {
    const item = normalizeEvaluacion(ev[key]);
    if (item) {
      out[key] = item;
      any = true;
    }
  }
  return any ? out : null;
}

function normalizePuesto(puesto) {
  const list = Array.isArray(puesto)
    ? puesto
    : typeof puesto === 'string' && puesto.trim()
      ? [puesto.trim()]
      : [];
  return list.map((p) => String(p || '').trim()).filter(Boolean).slice(0, 4);
}

function normalizeRecomendaciones(recs) {
  if (!Array.isArray(recs)) return [];
  return recs.map((r) => String(r || '').trim()).filter(Boolean).slice(0, 6);
}

function isRealPanelAnalisis(analisis) {
  const ev = analisis && analisis.evaluaciones;
  if (!ev || typeof ev !== 'object') return false;
  return EVAL_KEYS.some((key) => {
    const item = ev[key];
    if (!item || typeof item !== 'object') return false;
    const exp = String(item.explicacion || '').trim();
    return exp && exp !== STUB_EVAL_EXPLANATION;
  });
}

/**
 * El panel solo omite DeepSeek si Msg ya mandó un diagnóstico real de IA.
 * @param {object} lead
 * @param {object} [analisisCV]
 */
function isCvAnalizadoEnMsg(lead, analisisCV) {
  const provider = String(lead?.analysisProvider || '').toLowerCase();
  if (provider !== 'ollama' && provider !== 'deepseek') return false;
  return isRealPanelAnalisis(analisisCV || lead?.panelAnalisis);
}

function stubEvaluaciones() {
  const item = { puntuacion: 7, explicacion: STUB_EVAL_EXPLANATION };
  return {
    estructura: { ...item },
    perfil: { ...item },
    experiencia: { ...item },
    visibilidad: { ...item },
    empleabilidad: { ...item }
  };
}

function buildCvAnalysisPrompt(text) {
  return (
    'Analiza este CV y responde SOLO con JSON válido (sin markdown).\n' +
    'Haz un diagnóstico profesional básico, con valor real, sin reescribir el CV.\n' +
    'Califica del 1 al 10 cada área (1 = muy deficiente, 10 = excelente) y justifica en 1-2 frases consultivas.\n' +
    'Áreas: estructura, perfil (claridad y posicionamiento), experiencia (impacto de la última), visibilidad, empleabilidad.\n' +
    'El candidato debe notar puntos críticos a mejorar.\n' +
    'En puesto, devuelve 4 títulos: el principal (experiencia más reciente) y 3 alternativas. En español, máximo 5 palabras, sin Sr/Jr.\n' +
    'Si no hay un dato, usa cadena vacía o array vacío.\n\n' +
    'Formato JSON:\n' +
    '{"ultimaExperiencia":"","evaluaciones":{"estructura":{"puntuacion":0,"explicacion":""},"perfil":{"puntuacion":0,"explicacion":""},"experiencia":{"puntuacion":0,"explicacion":""},"visibilidad":{"puntuacion":0,"explicacion":""},"empleabilidad":{"puntuacion":0,"explicacion":""}},"recomendaciones":["","",""],"puesto":["","","",""],"localidad":{"ciudad":"","estado":""},"contacto":{"nombre":"","email":"","telefono":""}}\n\n' +
    `CV:\n${text}`
  );
}

function leadFromFullAnalisis(parsed, hints, text, provider) {
  const contacto =
    parsed.contacto && typeof parsed.contacto === 'object' ? parsed.contacto : {};
  const localidad =
    parsed.localidad && typeof parsed.localidad === 'object' ? parsed.localidad : {};
  const email = String(
    contacto.email || parsed.email || parsed.correo || parsed.leadCorreo || ''
  ).trim();
  const telefono =
    String(contacto.telefono || parsed.telefono || parsed.phone || hints.telefono || '').trim() ||
    'No encontrado';
  const nombre =
    String(contacto.nombre || parsed.nombre || hints.nombre || 'Candidato').trim() ||
    'Candidato';
  const ciudad = String(localidad.ciudad || parsed.ciudad || '').trim();
  const estado = String(localidad.estado || parsed.estado || '').trim();
  const experiencia = String(
    parsed.ultimaExperiencia || parsed.experienciaResumen || parsed.experiencia || ''
  ).trim();
  const evaluaciones = normalizeEvaluaciones(parsed.evaluaciones);
  const puesto = normalizePuesto(parsed.puesto);
  const recomendaciones = normalizeRecomendaciones(parsed.recomendaciones);

  return {
    nombre,
    telefono,
    correo: email,
    leadCorreo: email,
    email,
    experiencia,
    textoCompleto: text,
    ciudad,
    estado,
    leadCiudad: ciudad,
    leadEstado: estado,
    analysisProvider: provider,
    panelAnalisis: {
      contacto: {
        nombre,
        email,
        telefono: telefono === 'No encontrado' ? '' : telefono
      },
      localidad: { ciudad, estado },
      puesto,
      ultimaExperiencia: experiencia,
      evaluaciones,
      recomendaciones
    }
  };
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

  const raw = await ollamaService.chatReply(buildCvAnalysisPrompt(snippet), {
    skipMonica: true,
    systemExtra:
      'Eres un analista de CV. Devuelve únicamente JSON válido, sin explicaciones ni persona de asistente.'
  });
  const parsed = parseJsonObject(raw);
  if (!parsed || typeof parsed !== 'object') {
    const fallback = normalizeLeadFromRegex(snippet, hints);
    fallback.analysisProvider = 'ollama_fallback_regex';
    return fallback;
  }

  return leadFromFullAnalisis(parsed, hints, snippet, 'ollama');
}

/**
 * @param {string} text
 * @param {{ nombre?: string, telefono?: string, emails?: string[] }} [hints]
 */
async function analyzeCvTextWithDeepSeek(text, hints = {}) {
  const snippet = String(text || '').trim().slice(0, 12000);
  if (!snippet) {
    return normalizeLeadFromRegex('', hints);
  }

  const model =
    String(process.env.DEEPSEEK_CV_MODEL || process.env.DEEPSEEK_MODEL || 'deepseek-chat').trim() ||
    'deepseek-chat';
  const timeoutRaw = parseInt(process.env.DEEPSEEK_TIMEOUT_MS || '120000', 10);
  const timeout = Number.isFinite(timeoutRaw) && timeoutRaw >= 5000 ? timeoutRaw : 120000;

  const response = await axios.post(
    process.env.DEEPSEEK_API_URL || DEEPSEEK_API_URL,
    {
      model,
      messages: [
        {
          role: 'system',
          content: 'Eres un analista de CV. Devuelve únicamente JSON válido.'
        },
        { role: 'user', content: buildCvAnalysisPrompt(snippet) }
      ],
      max_tokens: 2048,
      temperature: 0.7
    },
    {
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${process.env.DEEPSEEK_API_KEY}`
      },
      timeout
    }
  );

  const content = response.data?.choices?.[0]?.message?.content;
  const parsed = parseJsonObject(content);
  if (!parsed || typeof parsed !== 'object') {
    const fallback = normalizeLeadFromRegex(snippet, hints);
    fallback.analysisProvider = 'deepseek_fallback_regex';
    return fallback;
  }

  return leadFromFullAnalisis(parsed, hints, snippet, 'deepseek');
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
  if (provider === 'deepseek' && hasDeepSeekKey()) {
    try {
      return await analyzeCvTextWithDeepSeek(text, opts);
    } catch (error) {
      console.warn('[cvAnalysis] DeepSeek falló, uso regex:', error.message);
      const fallback = normalizeLeadFromRegex(text, opts);
      fallback.analysisProvider = 'regex_after_deepseek_error';
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

  logAgenda('cv.analyzeBuffer.start', {
    bytes: buffer?.length || 0,
    provider: getProvider(),
    emailsEnPdf: loose.emails.length,
    phonesEnPdf: loose.phones.length
  });

  let text = '';
  try {
    text = await extractTextFromPDF(buffer, { silent: true, maxPages: 8 });
  } catch (error) {
    warnAgenda('cv.analyzeBuffer.pdfParseError', { message: error.message });
  }

  if (!text || text.length < 40) {
    logAgenda('cv.analyzeBuffer.textoCorto', {
      chars: text ? text.length : 0,
      usandoHints: true
    });
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
  logAgenda('cv.analyzeBuffer.done', {
    provider: analyzed.analysisProvider || getProvider(),
    nombre: analyzed.nombre || null,
    correo: analyzed.leadCorreo || analyzed.correo || null,
    telefono: analyzed.telefono || null,
    textoChars: String(analyzed.textoCompleto || text || '').length
  });
  return analyzed;
}

/**
 * No pisa ciudad/estado/correo que el lead ya dio si el análisis del PDF viene vacío.
 * @param {object|null} existing
 * @param {object} incoming
 */
function preserveFilledLeadFields(existing, incoming) {
  const next = incoming && typeof incoming === 'object' ? { ...incoming } : {};
  if (!existing || typeof existing !== 'object') return next;

  const pairs = [
    ['leadCiudad', 'ciudad'],
    ['leadEstado', 'estado']
  ];
  for (const [a, b] of pairs) {
    const hasNew = Boolean(String(next[a] || next[b] || '').trim());
    const prev = String(existing[a] || existing[b] || '').trim();
    if (!hasNew && prev) {
      next[a] = existing[a] || prev;
      next[b] = existing[b] || prev;
    }
  }

  const prevEmail = String(
    existing.leadCorreo || existing.correo || existing.email || ''
  ).trim();
  const newEmail = String(next.leadCorreo || next.correo || next.email || '').trim();
  if (!newEmail.includes('@') && prevEmail.includes('@')) {
    next.leadCorreo = prevEmail;
    next.correo = prevEmail;
    next.email = prevEmail;
  }
  return next;
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
  if (!buffer) {
    warnAgenda('cv.ensureAnalyzed.sinArchivo', { cvId: id });
    return existing;
  }

  const hasEmail = [existing?.leadCorreo, existing?.correo, existing?.email].some(
    (value) => value && String(value).includes('@')
  );
  if (hasEmail && !opts.force) {
    logAgenda('cv.ensureAnalyzed.cache', {
      cvId: id,
      correo: existing?.leadCorreo || existing?.correo || existing?.email
    });
    return existing;
  }

  logAgenda('cv.ensureAnalyzed.reanalizar', {
    cvId: id,
    force: Boolean(opts.force),
    hadEmail: hasEmail
  });

  const analyzed = await analyzeCvBuffer(buffer, {
    nombre: opts.nombre || existing?.nombre,
    telefono: opts.telefono || existing?.telefono
  });
  const patch = preserveFilledLeadFields(existing, {
    ...analyzed,
    analyzedAt: new Date().toISOString()
  });
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
  const fromAi =
    lead.panelAnalisis && typeof lead.panelAnalisis === 'object'
      ? lead.panelAnalisis
      : {};
  const aiContacto =
    fromAi.contacto && typeof fromAi.contacto === 'object' ? fromAi.contacto : {};
  const aiLocalidad =
    fromAi.localidad && typeof fromAi.localidad === 'object' ? fromAi.localidad : {};
  const puestoPrincipal = experiencia
    ? experiencia.split(/\s+/).slice(0, 5).join(' ')
    : 'Candidato';
  const puesto = normalizePuesto(fromAi.puesto);
  const evaluaciones = isRealPanelAnalisis(fromAi)
    ? {
        ...stubEvaluaciones(),
        ...fromAi.evaluaciones
      }
    : stubEvaluaciones();

  return {
    contacto: {
      nombre: String(aiContacto.nombre || nombre).trim(),
      email: String(aiContacto.email || email).trim(),
      telefono: String(aiContacto.telefono || telefono).trim()
    },
    localidad: {
      ciudad: String(aiLocalidad.ciudad || ciudad).trim(),
      estado: String(aiLocalidad.estado || estado).trim()
    },
    puesto: puesto.length ? puesto : [puestoPrincipal, 'Profesional', 'Especialista', 'Consultor'],
    ultimaExperiencia: String(fromAi.ultimaExperiencia || experiencia || '').slice(0, 280),
    evaluaciones,
    recomendaciones: normalizeRecomendaciones(fromAi.recomendaciones),
    origenAnalisis: lead.analysisProvider || getProvider(),
    textoExtraido: String(lead.textoCompleto || fromAi.textoExtraido || '').slice(0, 12000)
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
  logAgenda('cv.buildPanelExtras.start', { cvId, provider: getProvider() });
  const enriched =
    (await ensureCvAnalyzed(cvId, { ...opts, force: true })) || null;
  const leadExtraido = buildPanelLeadExtraido(enriched || {});
  const analisisCV = buildPanelAnalisisCv(enriched || {});
  const cvAnalizadoEnMsg =
    Boolean(leadExtraido.leadCorreo) && isCvAnalizadoEnMsg(enriched, analisisCV);
  logAgenda('cv.buildPanelExtras.done', {
    cvId,
    leadCorreo: leadExtraido.leadCorreo || null,
    leadNombre: leadExtraido.leadNombre || null,
    cvAnalizadoEnMsg,
    analysisProvider: enriched?.analysisProvider || getProvider()
  });
  return { enriched, leadExtraido, analisisCV, cvAnalizadoEnMsg };
}

module.exports = {
  getProvider,
  analyzeCvText,
  analyzeCvBuffer,
  ensureCvAnalyzed,
  preserveFilledLeadFields,
  buildPanelAnalisisCv,
  buildPanelLeadExtraido,
  buildPanelAgendaExtras,
  isCvAnalizadoEnMsg,
  extractLooseSignalsFromPdfBuffer,
  parseJsonObject
};
