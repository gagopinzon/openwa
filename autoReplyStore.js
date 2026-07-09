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

function defaultConfig() {
  return {
    version: 1,
    enabled: process.env.AUTO_REPLY_ENABLED === 'true',
    basePrompt: DEFAULT_BASE_PROMPT,
    rules: DEFAULT_RULES.map((r) => ({ ...r, keywords: [...r.keywords] })),
    webhookIdsBySession: {}
  };
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
    return {
      ...base,
      ...parsed,
      rules: Array.isArray(parsed.rules) ? parsed.rules : base.rules,
      webhookIdsBySession:
        parsed.webhookIdsBySession && typeof parsed.webhookIdsBySession === 'object'
          ? parsed.webhookIdsBySession
          : {}
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
    webhookIdsBySession: cfg.webhookIdsBySession
  };
}

/**
 * @param {{ enabled?: boolean, basePrompt?: string, rules?: Array }} patch
 */
function updateConfig(patch) {
  const cfg = readConfig();
  if (patch.enabled !== undefined) cfg.enabled = Boolean(patch.enabled);
  if (patch.basePrompt !== undefined) cfg.basePrompt = String(patch.basePrompt).trim();
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
  return getPublicConfig();
}

function setWebhookId(logicalSessionId, webhookId) {
  const cfg = readConfig();
  if (!cfg.webhookIdsBySession) cfg.webhookIdsBySession = {};
  if (webhookId) {
    cfg.webhookIdsBySession[logicalSessionId] = String(webhookId);
  } else {
    delete cfg.webhookIdsBySession[logicalSessionId];
  }
  writeConfig(cfg);
}

function clearAllWebhookIds() {
  const cfg = readConfig();
  cfg.webhookIdsBySession = {};
  writeConfig(cfg);
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

module.exports = {
  getConfig,
  getPublicConfig,
  updateConfig,
  setWebhookId,
  clearAllWebhookIds,
  getWebhookUrl,
  matchRule,
  DEFAULT_BASE_PROMPT,
  DEFAULT_RULES
};
