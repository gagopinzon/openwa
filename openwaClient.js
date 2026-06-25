const axios = require('axios');

function getBaseConfig() {
  const baseUrl = (process.env.OPENWA_BASE_URL || 'https://openwa.protalentconnections.com/api').replace(
    /\/$/,
    ''
  );
  const apiKey = process.env.OPENWA_API_KEY || '';
  return { baseUrl, apiKey };
}

function assertOpenWAConfigured() {
  const { apiKey } = getBaseConfig();
  if (!apiKey) {
    throw new Error('OPENWA_API_KEY no está configurado en las variables de entorno');
  }
}

function normalizeOpenWASessionRow(row) {
  if (!row || typeof row !== 'object') return null;
  const id = row.id || row.sessionId;
  if (!id) return null;
  return {
    id: String(id),
    name: String(row.name || row.profileName || id),
    status: String(row.status || row.state || ''),
    phoneNumber: row.phoneNumber ? String(row.phoneNumber) : ''
  };
}

/**
 * Lista sesiones disponibles en el servidor OpenWA.
 * @param {{ status?: string, limit?: number }} [params]
 */
async function listOpenWASessions(params = {}) {
  const qs = new URLSearchParams();
  if (params.status) qs.set('status', params.status);
  if (params.limit) qs.set('limit', String(params.limit));
  const query = qs.toString() ? `?${qs.toString()}` : '';

  const data = await openwaRequest('GET', `/sessions${query}`);
  const rawList = Array.isArray(data)
    ? data
    : data.data || data.sessions || [];

  return rawList.map(normalizeOpenWASessionRow).filter(Boolean);
}

/** Formatea número MX a chatId de OpenWA (ej. 521234567890@c.us) */
function formatPhoneToChatId(phoneNumber) {
  const clean = String(phoneNumber || '').replace(/\D/g, '');
  if (clean.length < 10) {
    throw new Error('El número de teléfono debe tener al menos 10 dígitos');
  }

  let normalized;
  if (clean.length === 10) {
    normalized = `521${clean}`;
  } else if (clean.startsWith('521') && clean.length >= 13) {
    normalized = clean;
  } else if (clean.startsWith('52') && clean.length === 12) {
    normalized = `521${clean.slice(2)}`;
  } else if (clean.startsWith('52')) {
    normalized = clean;
  } else {
    normalized = `521${clean.slice(-10)}`;
  }

  return `${normalized}@c.us`;
}

async function openwaRequest(method, path, body) {
  const { baseUrl, apiKey } = getBaseConfig();
  assertOpenWAConfigured();

  const response = await axios({
    method,
    url: `${baseUrl}${path}`,
    headers: {
      'Content-Type': 'application/json',
      'X-API-Key': apiKey
    },
    data: body,
    validateStatus: () => true
  });

  const data = response.data || {};
  if (response.status < 200 || response.status >= 300) {
    const message =
      data.message || data.error || `OpenWA error ${response.status}`;
    throw new Error(message);
  }
  return data;
}

function isConnectedStatus(status) {
  const s = String(status || '').toLowerCase();
  return s === 'connected' || s === 'open' || s === 'ready';
}

/**
 * @param {string} openwaSessionId
 * @returns {Promise<{ connected: boolean, status: string, raw: object }>}
 */
async function getSessionStatus(openwaSessionId) {
  const data = await openwaRequest('GET', `/sessions/${openwaSessionId}`);
  const status = data.status || data.state || '';
  return {
    connected: isConnectedStatus(status),
    status: String(status),
    raw: data
  };
}

async function sendTextMessage(openwaSessionId, chatId, text) {
  const data = await openwaRequest(
    'POST',
    `/sessions/${openwaSessionId}/messages/send-text`,
    { chatId, text }
  );
  return {
    messageId: data.id || data.messageId,
    raw: data
  };
}

module.exports = {
  assertOpenWAConfigured,
  formatPhoneToChatId,
  getSessionStatus,
  sendTextMessage,
  isConnectedStatus,
  listOpenWASessions,
  normalizeOpenWASessionRow
};
