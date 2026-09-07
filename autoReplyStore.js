const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const DATA_DIR = path.join(__dirname, 'data');
const CONFIG_FILE = path.join(DATA_DIR, 'auto-reply-config.json');

/** Playbook editable: identidad, objetivo y encuadre del servicio. */
const DEFAULT_BASE_PROMPT = `Sé profesional y lo más humana posible. Tu rol es simular una agendadora femenina llamada Mónica: carismática y con habilidad para conectar con cada contacto.

Tu objetivo principal es concretar la cita: agendar, persuadir y construir confianza. Sé breve; a los contactos no les gusta leer mucho.

Emojis: solo 💙 y ☺️.

Sé educada, amable y cordial. Cuando encaje, desea el periodo del bloque AHORA (CDMX): buen día, buena tarde o buena noche según ESA hora del sistema (nunca inventes el periodo). También puedes desear buen fin de semana si aplica.

IMPORTANTE — qué somos:
No somos una agenda de reclutamiento y selección. No es entrevista laboral ni oferta de trabajo.
Es una orientación personalizada para revisar su perfil y definir la mejor estrategia para sus objetivos profesionales.
En la sesión revisamos CV, compatibilidad con ATS y vacantes alineadas a su perfil.

Fíjate en lo que ya dijo el prospecto y en lo que tú ya dijiste: no repitas mensajes.`;

/**
 * Identidad corta para el system role (Ollama / DeepSeek).
 * Debe alinearse con el playbook; no contradecirlo.
 */
const DEFAULT_PERSONA_SYSTEM =
  'Eres Mónica, agendadora de Pro Talent en WhatsApp. ' +
  'Carismática, profesional y humana. Tu meta es concretar citas de orientación de perfil ' +
  '(no entrevistas laborales ni ofertas de trabajo). ' +
  'Sé breve (1–3 frases), persuasiva con calidez, y empuja hacia agendar cuando haya apertura. ' +
  'Emojis solo 💙 y ☺️. Responde siempre en español.';

/**
 * Reglas prioritarias del sistema (van en el prompt de cada reply).
 * Sustituyen al playbook si hay conflicto.
 */
const DEFAULT_SYSTEM_INSTRUCTIONS = `INSTRUCCIONES DEL SISTEMA (prioritarias si hay conflicto con el playbook):
- Responde en español como Mónica: cercana, profesional y carismática. Prioridad: concretar la mayor cantidad posible de citas con persuasión y confianza, sin sonar robótica ni grosera.
- Si el lead hace una PREGUNTA (servicio, proceso, costos, tiempos, dudas): respóndela primero, clara y breve; después lleva la conversación hacia agendar la sesión de orientación.
- Nunca digas que es una entrevista laboral, vacante abierta, proceso de selección u oferta de trabajo. Habla de orientación / diagnóstico de perfil (CV, ATS, estrategia profesional).
- Sé breve: ideal un párrafo corto. Si necesitas 2–3 ideas, sepáralas con una línea en blanco (así se envían como mensajes distintos).
- No firmes con "Atte:" ni con nombre de sesión; ya te presentaste.
- Emojis: solo 💙 y ☺️; no uses otros.
- Responde al mensaje del lead; no reenvíes el pitch frío completo.
- Si hay historial reciente: NO repitas saludos, propuestas, horarios, preguntas ni datos que ya aparecen en mensajes marcados como "Tú". Avanza la conversación con algo nuevo.
- Zona horaria: México (CDMX). El bloque AHORA (CDMX) es la ÚNICA fuente de verdad del día y la hora. Si saludas o deseas el día, usa el saludo/deseo que indica ese bloque (nunca "buenas noches" de mañana, ni "buenos días" de noche).
- Horarios del lead: si dice "a las 5", "5:30", "las 6" SIN decir mañana/am, asume TARDE (17:00, 17:30, 18:00). Nunca interpretes 1–7 como madrugada en citas salvo que digan "de la mañana" o "am".
- Cuando el lead muestre apertura o interés, propón o confirma un horario concreto con claridad.`;

const DEFAULT_CV_POLICY_WITH_CV =
  'REGLA CRÍTICA — CV DEL LEAD:\n' +
  '- El PDF del CV de este lead YA está cargado en el sistema (mesa "Cargar CVs").\n' +
  '- NUNCA pidas CV, currículum, curriculum, curriculo, PDF, hoja de vida ni "documento".\n' +
  '- NO digas "envíame", "mándame", "compárteme", "necesito", "pásame", "¿podrías enviarme?" refiriéndote al CV.\n' +
  '- Cuando confirme un horario, el sistema usa el CV ya cargado; tú no lo pidas ni lo menciones.';

const DEFAULT_CV_POLICY_WITHOUT_CV =
  'REGLA CRÍTICA — CV DEL LEAD:\n' +
  '- NUNCA pidas CV, currículum, curriculum, curriculo, PDF, hoja de vida ni "documento" en esta respuesta.\n' +
  '- El sistema toma el archivo de los CVs ya cargados si existe. Tú no lo solicitas.\n' +
  '- Enfócate en la duda o intención del lead y, si aplica, en concretar un horario para la orientación.';

const DEFAULT_RULES = [
  {
    id: 'consulta',
    label: 'Pregunta o duda',
    keywords: [
      'qué incluye',
      'que incluye',
      'cómo funciona',
      'como funciona',
      'en qué consiste',
      'en que consiste',
      'cuéntame',
      'cuentame',
      'explícame',
      'explicame',
      'qué es',
      'que es',
      'información',
      'informacion',
      'duda',
      'consultoría',
      'consultoria',
      'servicio',
      'proceso',
      'beneficios',
      'para qué sirve',
      'para que sirve'
    ],
    instruction:
      'Responde la duda con claridad y calidez, en pocas frases. Aclara que es una orientación de perfil (no entrevista laboral). Cierra invitando a agendar la sesión gratuita para revisar su CV/ATS y estrategia.'
  },
  {
    id: 'interes',
    label: 'Muestra interés',
    keywords: [
      'me interesa',
      'si me interesa',
      'sí me interesa',
      'claro que si',
      'claro que sí',
      'quiero agendar',
      'adelante con la sesión',
      'adelante con la sesion'
    ],
    instruction:
      'Confirma con entusiasmo y lleva de inmediato a concretar horario. Si hay HORARIOS REALES del sistema, compártelos y pide que elija uno; si no, pregunta qué día y hora le acomodan.'
  },
  {
    id: 'precio',
    label: 'Pregunta costo',
    keywords: ['precio', 'costo', 'cuánto', 'cuanto', 'cobran', 'pago'],
    instruction:
      'Explica que la sesión de orientación/diagnóstico es gratuita y sin compromiso. Luego invita con claridad a agendar para revisar su perfil.'
  },
  {
    id: 'no',
    label: 'Rechaza',
    keywords: ['no gracias', 'no me interesa', 'no estoy interesado', 'dejen de escribir'],
    instruction: 'Despídete brevemente y con respeto. No insistas ni vendas más.'
  }
];

function ensureDataDir() {
  if (!fs.existsSync(DATA_DIR)) {
    fs.mkdirSync(DATA_DIR, { recursive: true });
  }
}

function normalizeSessionIds(value) {
  if (!Array.isArray(value)) return null;
  return [
    ...new Set(
      value
        .map((id) => String(id || '').trim())
        .filter(Boolean)
    )
  ];
}

function recommendedDefaults() {
  return {
    basePrompt: DEFAULT_BASE_PROMPT,
    personaSystem: DEFAULT_PERSONA_SYSTEM,
    systemInstructions: DEFAULT_SYSTEM_INSTRUCTIONS,
    cvPolicyWithCv: DEFAULT_CV_POLICY_WITH_CV,
    cvPolicyWithoutCv: DEFAULT_CV_POLICY_WITHOUT_CV,
    rules: DEFAULT_RULES.map((r) => ({ ...r, keywords: [...r.keywords] }))
  };
}

function defaultConfig() {
  const defaults = recommendedDefaults();
  return {
    version: 2,
    enabled: process.env.AUTO_REPLY_ENABLED === 'true',
    basePrompt: defaults.basePrompt,
    personaSystem: defaults.personaSystem,
    systemInstructions: defaults.systemInstructions,
    cvPolicyWithCv: defaults.cvPolicyWithCv,
    cvPolicyWithoutCv: defaults.cvPolicyWithoutCv,
    rules: defaults.rules,
    /** null = todas las líneas; array = solo esas logicalSessionId */
    enabledSessionIds: null,
    webhookIdsBySession: {},
    /** Límites de "escribiendo…" (ms). null = usar .env / defaults del servicio */
    minDelayMs: null,
    maxDelayMs: null
  };
}

function clampDelayMs(value, fallback = null) {
  if (value === null || value === undefined || value === '') return null;
  const n = parseInt(value, 10);
  if (!Number.isFinite(n) || n < 0) return fallback;
  return Math.min(300000, n);
}

function normalizeDelayPair(minDelayMs, maxDelayMs) {
  const min = clampDelayMs(minDelayMs, null);
  let max = clampDelayMs(maxDelayMs, null);
  if (min != null && max != null && max < min) max = min;
  return { minDelayMs: min, maxDelayMs: max };
}

function pickPromptField(parsed, key, fallback) {
  if (parsed[key] === undefined || parsed[key] === null) return fallback;
  return String(parsed[key]);
}

function readConfig() {
  ensureDataDir();
  if (!fs.existsSync(CONFIG_FILE)) {
    const cfg = defaultConfig();
    writeConfig(cfg);
    return cfg;
  }
  try {
    const raw = fs.readFileSync(CONFIG_FILE, 'utf8');
    const parsed = JSON.parse(raw);
    const base = defaultConfig();
    const enabledSessionIds =
      parsed.enabledSessionIds === null || parsed.enabledSessionIds === undefined
        ? null
        : normalizeSessionIds(parsed.enabledSessionIds);

    const delays = normalizeDelayPair(parsed.minDelayMs, parsed.maxDelayMs);

    return {
      ...base,
      ...parsed,
      version: 2,
      basePrompt: pickPromptField(parsed, 'basePrompt', base.basePrompt),
      personaSystem: pickPromptField(parsed, 'personaSystem', base.personaSystem),
      systemInstructions: pickPromptField(
        parsed,
        'systemInstructions',
        base.systemInstructions
      ),
      cvPolicyWithCv: pickPromptField(parsed, 'cvPolicyWithCv', base.cvPolicyWithCv),
      cvPolicyWithoutCv: pickPromptField(
        parsed,
        'cvPolicyWithoutCv',
        base.cvPolicyWithoutCv
      ),
      rules: Array.isArray(parsed.rules) ? parsed.rules : base.rules,
      enabledSessionIds,
      webhookIdsBySession:
        parsed.webhookIdsBySession && typeof parsed.webhookIdsBySession === 'object'
          ? parsed.webhookIdsBySession
          : {},
      minDelayMs: delays.minDelayMs,
      maxDelayMs: delays.maxDelayMs
    };
  } catch {
    return defaultConfig();
  }
}

function writeConfig(data) {
  ensureDataDir();
  fs.writeFileSync(CONFIG_FILE, JSON.stringify(data, null, 2), 'utf8');
}

function getConfig() {
  return readConfig();
}

function getPublicConfig() {
  const cfg = readConfig();
  return {
    enabled: cfg.enabled,
    basePrompt: cfg.basePrompt,
    personaSystem: cfg.personaSystem,
    systemInstructions: cfg.systemInstructions,
    cvPolicyWithCv: cfg.cvPolicyWithCv,
    cvPolicyWithoutCv: cfg.cvPolicyWithoutCv,
    rules: cfg.rules,
    enabledSessionIds: cfg.enabledSessionIds,
    webhookIdsBySession: cfg.webhookIdsBySession,
    minDelayMs: cfg.minDelayMs,
    maxDelayMs: cfg.maxDelayMs
  };
}

function getRecommendedDefaults() {
  return recommendedDefaults();
}

/**
 * true si la línea (logicalSessionId) tiene auto-respuesta IA habilitada.
 * null/undefined en config = todas las líneas.
 */
function isSessionEnabled(logicalSessionId, cfg = null) {
  const config = cfg || readConfig();
  const ids = config.enabledSessionIds;
  if (ids === null || ids === undefined) return true;
  if (!logicalSessionId) return false;
  return ids.includes(String(logicalSessionId));
}

/**
 * @param {{
 *   enabled?: boolean,
 *   basePrompt?: string,
 *   personaSystem?: string,
 *   systemInstructions?: string,
 *   cvPolicyWithCv?: string,
 *   cvPolicyWithoutCv?: string,
 *   rules?: Array,
 *   enabledSessionIds?: string[]|null,
 *   minDelayMs?: number|null,
 *   maxDelayMs?: number|null
 * }} patch
 */
function updateConfig(patch) {
  const cfg = readConfig();
  const webhooksBefore = { ...(cfg.webhookIdsBySession || {}) };
  if (patch.enabled !== undefined) cfg.enabled = Boolean(patch.enabled);
  if (patch.basePrompt !== undefined) cfg.basePrompt = String(patch.basePrompt).trim();
  if (patch.personaSystem !== undefined) {
    cfg.personaSystem = String(patch.personaSystem).trim();
  }
  if (patch.systemInstructions !== undefined) {
    cfg.systemInstructions = String(patch.systemInstructions).trim();
  }
  if (patch.cvPolicyWithCv !== undefined) {
    cfg.cvPolicyWithCv = String(patch.cvPolicyWithCv).trim();
  }
  if (patch.cvPolicyWithoutCv !== undefined) {
    cfg.cvPolicyWithoutCv = String(patch.cvPolicyWithoutCv).trim();
  }
  if (patch.enabledSessionIds !== undefined) {
    cfg.enabledSessionIds =
      patch.enabledSessionIds === null ? null : normalizeSessionIds(patch.enabledSessionIds);
  }
  if (patch.minDelayMs !== undefined || patch.maxDelayMs !== undefined) {
    const delays = normalizeDelayPair(
      patch.minDelayMs !== undefined ? patch.minDelayMs : cfg.minDelayMs,
      patch.maxDelayMs !== undefined ? patch.maxDelayMs : cfg.maxDelayMs
    );
    cfg.minDelayMs = delays.minDelayMs;
    cfg.maxDelayMs = delays.maxDelayMs;
  }
  if (Array.isArray(patch.rules)) {
    cfg.rules = patch.rules.map((rule) => ({
      id: String(rule.id || crypto.randomUUID()).trim(),
      label: String(rule.label || 'Regla').trim(),
      keywords: Array.isArray(rule.keywords)
        ? rule.keywords.map((k) => String(k).trim()).filter(Boolean)
        : String(rule.keywords || '')
            .split(',')
            .map((k) => k.trim())
            .filter(Boolean),
      instruction: String(rule.instruction || '').trim()
    }));
  }
  cfg.version = 2;
  writeConfig(cfg);
  const webhooksAfter = { ...(cfg.webhookIdsBySession || {}) };
  console.log(
    `[auto-reply-store] updateConfig keys=${Object.keys(patch || {}).join(',')} webhooksBefore=${JSON.stringify(
      webhooksBefore
    )} webhooksAfter=${JSON.stringify(webhooksAfter)}`
  );
  return getPublicConfig();
}

function setWebhookId(logicalSessionId, webhookId) {
  const cfg = readConfig();
  if (!cfg.webhookIdsBySession) cfg.webhookIdsBySession = {};
  const before = { ...cfg.webhookIdsBySession };
  if (webhookId) {
    cfg.webhookIdsBySession[logicalSessionId] = String(webhookId);
  } else {
    delete cfg.webhookIdsBySession[logicalSessionId];
  }
  writeConfig(cfg);
  console.log(
    `[auto-reply-store] setWebhookId ${logicalSessionId}=${webhookId || '(deleted)'} before=${JSON.stringify(
      before
    )} after=${JSON.stringify(cfg.webhookIdsBySession)}`
  );
}

function clearAllWebhookIds() {
  const cfg = readConfig();
  const before = { ...(cfg.webhookIdsBySession || {}) };
  cfg.webhookIdsBySession = {};
  writeConfig(cfg);
  console.log(
    `[auto-reply-store] clearAllWebhookIds before=${JSON.stringify(before)}`
  );
}

function getWebhookUrl() {
  const base = String(process.env.WEBHOOK_PUBLIC_URL || '').trim().replace(/\/$/, '');
  if (!base) return null;
  return `${base}/api/webhooks/openwa`;
}

function matchRule(rules, messageBody) {
  const text = String(messageBody || '').toLowerCase();
  if (!text) return null;
  for (const rule of rules || []) {
    const keywords = rule.keywords || [];
    for (const kw of keywords) {
      if (kw && text.includes(String(kw).toLowerCase())) {
        return rule;
      }
    }
  }
  return null;
}

/**
 * Activa/desactiva IA para una logicalSessionId.
 * Si enabledSessionIds es null (todas), materializa a allSessionIds primero.
 * @param {string} sessionId
 * @param {boolean} enabled
 * @param {string[]} allSessionIds — ids actuales de sessionsStore
 */
function setSessionEnabled(sessionId, enabled, allSessionIds) {
  const id = String(sessionId || '').trim();
  if (!id) throw new Error('sessionId es obligatorio');
  if (typeof enabled !== 'boolean') throw new Error('enabled (boolean) es obligatorio');

  const allIds = normalizeSessionIds(allSessionIds) || [];
  if (!allIds.includes(id)) {
    throw new Error(`Sesión desconocida: ${id}`);
  }

  const cfg = readConfig();
  let ids =
    cfg.enabledSessionIds === null || cfg.enabledSessionIds === undefined
      ? [...allIds]
      : normalizeSessionIds(cfg.enabledSessionIds) || [];

  if (enabled) {
    if (!ids.includes(id)) ids.push(id);
  } else {
    ids = ids.filter((x) => x !== id);
  }

  cfg.enabledSessionIds = ids;
  writeConfig(cfg);

  return {
    config: getPublicConfig(),
    sessionId: id,
    sessionEnabled: ids.includes(id)
  };
}

module.exports = {
  getConfig,
  getPublicConfig,
  getRecommendedDefaults,
  updateConfig,
  isSessionEnabled,
  setSessionEnabled,
  setWebhookId,
  clearAllWebhookIds,
  getWebhookUrl,
  matchRule,
  DEFAULT_BASE_PROMPT,
  DEFAULT_PERSONA_SYSTEM,
  DEFAULT_SYSTEM_INSTRUCTIONS,
  DEFAULT_CV_POLICY_WITH_CV,
  DEFAULT_CV_POLICY_WITHOUT_CV,
  DEFAULT_RULES
};
