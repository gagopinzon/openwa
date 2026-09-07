const axios = require('axios');

const DEFAULT_CHAT_URL = 'http://127.0.0.1:11434/api/chat';
const DEFAULT_MODEL = 'gemma4:12b';

/** Fallback si la config no trae personaSystem. */
const MONICA_SYSTEM =
  'Eres Mónica, agendadora de Pro Talent en WhatsApp. ' +
  'Carismática, profesional y humana. Tu meta es concretar citas de orientación de perfil ' +
  '(no entrevistas laborales ni ofertas de trabajo). ' +
  'Sé breve (1–3 frases), persuasiva con calidez, y empuja hacia agendar cuando haya apertura. ' +
  'Emojis solo 💙 y ☺️. Responde siempre en español.';

function getChatUrl() {
  return String(process.env.OLLAMA_URL || DEFAULT_CHAT_URL).trim() || DEFAULT_CHAT_URL;
}

function getModel() {
  return String(process.env.OLLAMA_MODEL || DEFAULT_MODEL).trim() || DEFAULT_MODEL;
}

function getTimeoutMs() {
  const v = parseInt(process.env.OLLAMA_TIMEOUT_MS || '120000', 10);
  return Number.isFinite(v) && v >= 5000 ? v : 120000;
}

function getThinkEnabled() {
  const raw = String(process.env.OLLAMA_THINK || '').trim().toLowerCase();
  if (!raw) return false;
  return raw === '1' || raw === 'true' || raw === 'yes';
}

function isExplicitlyEnabled() {
  const p = String(process.env.AI_REPLY_PROVIDER || '').trim().toLowerCase();
  return p === 'ollama';
}

function isConfigured() {
  if (isExplicitlyEnabled()) return true;
  if (String(process.env.OLLAMA_URL || '').trim()) return true;
  return false;
}

/**
 * @param {string} userPrompt
 * @param {{ basePrompt?: string, systemExtra?: string, personaSystem?: string, skipMonica?: boolean }} [opts]
 * @returns {Promise<string>}
 */
async function chatReply(userPrompt, opts = {}) {
  const base = String(opts.basePrompt || '').trim();
  const extra = String(opts.systemExtra || '').trim();
  const persona = String(opts.personaSystem || '').trim() || MONICA_SYSTEM;
  // extra (política CV/agenda) va PRIMERO: los modelos abiertos respetan más
  // las instrucciones al inicio del system prompt.
  const systemParts = opts.skipMonica
    ? [extra, base].filter(Boolean)
    : [extra, persona, base].filter(Boolean);
  const system = systemParts.join('\n\n');

  const response = await axios.post(
    getChatUrl(),
    {
      model: getModel(),
      messages: [
        { role: 'system', content: system },
        { role: 'user', content: String(userPrompt || '').trim() }
      ],
      think: getThinkEnabled(),
      stream: false
    },
    {
      headers: { 'Content-Type': 'application/json' },
      timeout: getTimeoutMs(),
      validateStatus: () => true
    }
  );

  if (response.status >= 400) {
    const detail =
      response.data?.error ||
      response.data?.message ||
      JSON.stringify(response.data || {}).slice(0, 200);
    throw new Error(`Ollama HTTP ${response.status}: ${detail}`);
  }

  const content = response.data?.message?.content;
  if (!content || !String(content).trim()) {
    throw new Error('Ollama devolvió respuesta vacía');
  }
  return String(content).trim();
}

module.exports = {
  getChatUrl,
  getModel,
  getThinkEnabled,
  isConfigured,
  isExplicitlyEnabled,
  chatReply,
  MONICA_SYSTEM
};
