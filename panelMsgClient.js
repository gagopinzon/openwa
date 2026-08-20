const axios = require('axios');

const DEFAULT_PANEL_BASE = 'https://panel.protalentconnections.com';
const GET_TIMEOUT_MS = 20000;
const POST_TIMEOUT_MS = 150000;

function panelBaseUrl() {
  return String(process.env.PANEL_BASE_URL || DEFAULT_PANEL_BASE)
    .trim()
    .replace(/\/$/, '');
}

function apiKey() {
  return String(process.env.MSG_INTEGRATION_API_KEY || '').trim();
}

function defaultGerenteEmail() {
  return String(process.env.MSG_GERENTE_EMAIL || '').trim();
}

function isConfigured() {
  return Boolean(apiKey());
}

function buildHeaders(gerenteEmail) {
  const key = apiKey();
  if (!key) {
    const err = new Error('MSG_INTEGRATION_API_KEY no está configurada');
    err.status = 500;
    throw err;
  }
    const email = String(gerenteEmail || defaultGerenteEmail() || '').trim();
  if (!email) {
    const err = new Error(
      'Falta el correo del gerente. Guárdalo en tu perfil o envía gerenteEmail.'
    );
    err.status = 400;
    throw err;
  }
  return {
    'X-API-Key': key,
    'X-Gerente-Email': email,
    'Content-Type': 'application/json'
  };
}

function normalizePanelError(error) {
  const status = error.response?.status || error.status || 502;
  const data = error.response?.data;
  const message =
    (data && typeof data === 'object' && data.message) ||
    error.message ||
    'Error al llamar al panel';

  const out = new Error(message);
  out.status = status;
  out.panelBody = data && typeof data === 'object' ? data : { message };
  if (data && typeof data === 'object' && data.leadExtraido) {
    out.leadExtraido = data.leadExtraido;
  }
  return out;
}

/**
 * @param {{ gerenteEmail?: string, fechaInicio?: string, fechaFin?: string, slotMinutos?: number }} opts
 */
async function getDisponibilidad(opts = {}) {
  const gerenteEmail = opts.gerenteEmail || defaultGerenteEmail();
  const headers = buildHeaders(gerenteEmail);
  const params = {};
  if (opts.fechaInicio) params.fechaInicio = opts.fechaInicio;
  if (opts.fechaFin) params.fechaFin = opts.fechaFin;
  if (opts.slotMinutos) params.slotMinutos = opts.slotMinutos;

  try {
    const { data } = await axios.get(`${panelBaseUrl()}/api/external/msg/disponibilidad`, {
      headers,
      params,
      timeout: GET_TIMEOUT_MS
    });
    return data;
  } catch (error) {
    throw normalizePanelError(error);
  }
}

/**
 * @param {{
 *   gerenteEmail?: string,
 *   vendedorId: string,
 *   fecha: string,
 *   horaInicio: string,
 *   horaFin: string,
 *   cvUrl: string,
 *   titulo?: string,
 *   descripcion?: string,
 *   leadCorreo?: string,
 *   leadNombre?: string,
 *   leadTelefono?: string,
 *   leadCiudad?: string,
 *   leadEstado?: string
 * }} body
 */
async function crearReunion(body = {}) {
  const gerenteEmail = body.gerenteEmail || defaultGerenteEmail();
  const headers = buildHeaders(gerenteEmail);

  const payload = {
    vendedorId: body.vendedorId,
    fecha: body.fecha,
    horaInicio: body.horaInicio,
    horaFin: body.horaFin,
    cvUrl: body.cvUrl
  };

  if (body.titulo) payload.titulo = body.titulo;
  if (body.descripcion) payload.descripcion = body.descripcion;
  if (body.leadCorreo) payload.leadCorreo = body.leadCorreo;
  if (body.leadNombre) payload.leadNombre = body.leadNombre;
  if (body.leadTelefono) payload.leadTelefono = body.leadTelefono;
  if (body.leadCiudad) payload.leadCiudad = body.leadCiudad;
  if (body.leadEstado) payload.leadEstado = body.leadEstado;
  if (body.origen) payload.origen = body.origen;

  try {
    const { data } = await axios.post(
      `${panelBaseUrl()}/api/external/msg/reuniones`,
      payload,
      {
        headers,
        timeout: POST_TIMEOUT_MS
      }
    );
    return data;
  } catch (error) {
    throw normalizePanelError(error);
  }
}

module.exports = {
  getDisponibilidad,
  crearReunion,
  isConfigured,
  defaultGerenteEmail,
  panelBaseUrl
};
