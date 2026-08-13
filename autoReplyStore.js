const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const DATA_DIR = path.join(__dirname, 'data');
const CONFIG_FILE = path.join(DATA_DIR, 'auto-reply-config.json');

const DEFAULT_BASE_PROMPT =
  'Eres un asistente de reclutamiento de Pro Talent. Respondes mensajes de WhatsApp de forma breve, amable y profesional. No repitas el pitch inicial completo; responde directamente a lo que preguntó la persona.';

const DEFAULT_RULES = [
  {
    id: 'interes',
    label: 'Muestra interés',
    keywords: ['sí', 'si', 'me interesa', 'claro', 'adelante', 'ok', 'vale'],
    instruction:
      'Confirma entusiasmo y propón agendar una sesión gratuita de diagnóstico. Pregunta qué día u horario le acomoda.'
  },
  {
    id: 'precio',
    label: 'Pregunta costo',
    keywords: ['precio', 'costo', 'cuánto', 'cuanto', 'cobran', 'pago'],
    instruction:
      'Explica que la sesión de diagnóstico es gratuita y sin compromiso. Invita a agendar.'
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

function defaultConfig() {
  return {
    version: 1,
    enabled: process.env.AUTO_REPLY_ENABLED === 'true',
    basePrompt: DEFAULT_BASE_PROMPT,
    rules: DEFAULT_RULES.map((r) => ({ ...r, keywords: [...r.keywords] })),
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
    rules: cfg.rules,
    enabledSessionIds: cfg.enabledSessionIds,
    webhookIdsBySession: cfg.webhookIdsBySession,
    minDelayMs: cfg.minDelayMs,
    maxDelayMs: cfg.maxDelayMs
  };
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
 * @param {{ enabled?: boolean, basePrompt?: string, rules?: Array, enabledSessionIds?: string[]|null, minDelayMs?: number|null, maxDelayMs?: number|null }} patch
 */
function updateConfig(patch) {
  const cfg = readConfig();
  const webhooksBefore = { ...(cfg.webhookIdsBySession || {}) };
  if (patch.enabled !== undefined) cfg.enabled = Boolean(patch.enabled);
  if (patch.basePrompt !== undefined) cfg.basePrompt = String(patch.basePrompt).trim();
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
  updateConfig,
  isSessionEnabled,
  setSessionEnabled,
  setWebhookId,
  clearAllWebhookIds,
  getWebhookUrl,
  matchRule,
  DEFAULT_BASE_PROMPT,
  DEFAULT_RULES
};
