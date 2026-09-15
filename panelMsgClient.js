const axios = require('axios');
const { logAgenda, warnAgenda, redactCvUrl } = require('./agendaDebug');

const DEFAULT_PANEL_BASE = 'https://panel.protalentconnections.com';
const GET_TIMEOUT_MS = 20000;
const POST_TIMEOUT_MS = 150000;
const MULTIPART_MAX_BODY_BYTES = 11 * 1024 * 1024;
const DEFAULT_DISPONIBILIDAD_CACHE_MS = 90 * 1000;

const disponibilidadCache = new Map();

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

function buildHeaders(gerenteEmail, { json = true } = {}) {
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
  const headers = {
    'X-API-Key': key,
    'X-Gerente-Email': email
  };
  if (json) headers['Content-Type'] = 'application/json';
  return headers;
}

function normalizePanelError(error) {
  const status = error.response?.status || error.status || 502;
  const data = error.response?.data;
  const rawMessage =
    (data && typeof data === 'object' && data.message) ||
    error.message ||
    'Error al llamar al panel';
  const message =
    Number(status) === 413
      ? 'El CV es demasiado grande para crearlo en el panel'
      : rawMessage;

  const out = new Error(message);
  out.status = status;
  out.panelBody = data && typeof data === 'object' ? data : { message: rawMessage };
  if (data && typeof data === 'object' && data.leadExtraido) {
    out.leadExtraido = data.leadExtraido;
  }
  return out;
}

function disponibilidadCacheTtlMs() {
  const raw = Number(process.env.PANEL_DISPONIBILIDAD_CACHE_MS);
  if (Number.isFinite(raw) && raw >= 0) return Math.floor(raw);
  return DEFAULT_DISPONIBILIDAD_CACHE_MS;
}

function disponibilidadCacheKey(opts) {
  const email = String(opts.gerenteEmail || defaultGerenteEmail() || '')
    .trim()
    .toLowerCase();
  return [
    email,
    String(opts.fechaInicio || ''),
    String(opts.fechaFin || ''),
    String(opts.slotMinutos || '')
  ].join('|');
}

function getCachedDisponibilidad(key) {
  const row = disponibilidadCache.get(key);
  if (!row) return null;
  if (Date.now() >= row.expiresAt) {
    disponibilidadCache.delete(key);
    return null;
  }
  return row.data;
}

function setCachedDisponibilidad(key, data) {
  const ttl = disponibilidadCacheTtlMs();
  if (ttl <= 0) return;
  disponibilidadCache.set(key, { data, expiresAt: Date.now() + ttl });
}

function clearDisponibilidadCache() {
  disponibilidadCache.clear();
}

/**
 * @param {{ gerenteEmail?: string, fechaInicio?: string, fechaFin?: string, slotMinutos?: number, skipCache?: boolean }} opts
 */
async function getDisponibilidad(opts = {}) {
  const gerenteEmail = opts.gerenteEmail || defaultGerenteEmail();
  const headers = buildHeaders(gerenteEmail);
  const params = {};
  if (opts.fechaInicio) params.fechaInicio = opts.fechaInicio;
  if (opts.fechaFin) params.fechaFin = opts.fechaFin;
  if (opts.slotMinutos) params.slotMinutos = opts.slotMinutos;

  const cacheKey = disponibilidadCacheKey({ ...opts, gerenteEmail });
  if (!opts.skipCache) {
    const hit = getCachedDisponibilidad(cacheKey);
    if (hit) return hit;
  }

  try {
    const { data } = await axios.get(`${panelBaseUrl()}/api/external/msg/disponibilidad`, {
      headers,
      params,
      timeout: GET_TIMEOUT_MS
    });
    if (!opts.skipCache) setCachedDisponibilidad(cacheKey, data);
    return data;
  } catch (error) {
    throw normalizePanelError(error);
  }
}

function hasCvFile(body) {
  return Buffer.isBuffer(body.cvFile) && body.cvFile.length > 0;
}

function appendFormValue(form, key, value) {
  if (value === undefined || value === null || value === '') return;
  if (typeof value === 'boolean') {
    form.append(key, value ? 'true' : 'false');
    return;
  }
  if (typeof value === 'object') {
    form.append(key, JSON.stringify(value));
    return;
  }
  form.append(key, String(value));
}

function assignOptionalJsonFields(payload, body) {
  if (body.titulo) payload.titulo = body.titulo;
  if (body.descripcion) payload.descripcion = body.descripcion;
  if (body.leadCorreo) payload.leadCorreo = body.leadCorreo;
  if (body.leadNombre) payload.leadNombre = body.leadNombre;
  if (body.leadTelefono) payload.leadTelefono = body.leadTelefono;
  if (body.leadCiudad) payload.leadCiudad = body.leadCiudad;
  if (body.leadEstado) payload.leadEstado = body.leadEstado;
  if (body.leadExtraido && typeof body.leadExtraido === 'object') {
    payload.leadExtraido = body.leadExtraido;
  }
  if (body.analisisCV && typeof body.analisisCV === 'object') {
    payload.analisisCV = body.analisisCV;
  }
  if (body.cvAnalizadoEnMsg === true) {
    payload.cvAnalizadoEnMsg = true;
  }
  if (body.origen) payload.origen = body.origen;
}

function reunionEndpoint() {
  return `${panelBaseUrl()}/api/external/msg/reuniones`;
}

async function postReunionMultipart(gerenteEmail, body) {
  const headers = buildHeaders(gerenteEmail, { json: false });
  const form = new FormData();
  appendFormValue(form, 'vendedorId', body.vendedorId);
  appendFormValue(form, 'fecha', body.fecha);
  appendFormValue(form, 'horaInicio', body.horaInicio);
  appendFormValue(form, 'horaFin', body.horaFin);
  appendFormValue(form, 'titulo', body.titulo);
  appendFormValue(form, 'descripcion', body.descripcion);
  appendFormValue(form, 'leadCorreo', body.leadCorreo);
  appendFormValue(form, 'leadNombre', body.leadNombre);
  appendFormValue(form, 'leadTelefono', body.leadTelefono);
  appendFormValue(form, 'leadCiudad', body.leadCiudad);
  appendFormValue(form, 'leadEstado', body.leadEstado);
  appendFormValue(form, 'leadExtraido', body.leadExtraido);
  appendFormValue(form, 'analisisCV', body.analisisCV);
  if (body.cvAnalizadoEnMsg === true) {
    appendFormValue(form, 'cvAnalizadoEnMsg', true);
  }
  appendFormValue(form, 'origen', body.origen);

  const fileName = String(body.cvFileName || 'cv.pdf').trim() || 'cv.pdf';
  const mime = String(body.cvMime || 'application/pdf').trim() || 'application/pdf';
  const blob = new Blob([body.cvFile], { type: mime });
  form.append('cvFile', blob, fileName);

  const endpoint = reunionEndpoint();
  logAgenda('panel.crearReunion.request', {
    endpoint,
    gerenteEmail,
    vendedorId: body.vendedorId,
    fecha: body.fecha,
    horaInicio: body.horaInicio,
    horaFin: body.horaFin,
    cvDelivery: 'file',
    cvFileBytes: body.cvFile.length,
    cvFileName: fileName,
    leadCorreo: body.leadCorreo || null,
    leadNombre: body.leadNombre || null,
    cvAnalizadoEnMsg: body.cvAnalizadoEnMsg === true,
    tieneLeadExtraido: Boolean(body.leadExtraido),
    tieneAnalisisCV: Boolean(body.analisisCV),
    origen: body.origen || null
  });

  const started = Date.now();
  try {
    const { data, status } = await axios.post(endpoint, form, {
      headers,
      timeout: POST_TIMEOUT_MS,
      maxBodyLength: MULTIPART_MAX_BODY_BYTES,
      maxContentLength: MULTIPART_MAX_BODY_BYTES
    });
    logAgenda('panel.crearReunion.ok', {
      status,
      ms: Date.now() - started,
      reunionId: (data && (data.id || data.reunionId || data.reunion?.id)) || null,
      urlReunion:
        (data &&
          (data.urlReunion ||
            data.urlReunionLead ||
            data.reunion?.urlReunion ||
            data.meetUrl)) ||
        null,
      keys: data && typeof data === 'object' ? Object.keys(data) : []
    });
    return data;
  } catch (error) {
    const normalized = normalizePanelError(error);
    warnAgenda('panel.crearReunion.error', {
      ms: Date.now() - started,
      status: normalized.status,
      message: normalized.message,
      axiosCode: error.code || null,
      panelBody: normalized.panelBody || null
    });
    throw normalized;
  }
}

async function postReunionJson(gerenteEmail, body) {
  const headers = buildHeaders(gerenteEmail);
  const payload = {
    vendedorId: body.vendedorId,
    fecha: body.fecha,
    horaInicio: body.horaInicio,
    horaFin: body.horaFin,
    cvUrl: String(body.cvUrl || '').trim()
  };
  assignOptionalJsonFields(payload, body);

  const endpoint = reunionEndpoint();
  logAgenda('panel.crearReunion.request', {
    endpoint,
    gerenteEmail,
    vendedorId: payload.vendedorId,
    fecha: payload.fecha,
    horaInicio: payload.horaInicio,
    horaFin: payload.horaFin,
    cvDelivery: 'url',
    cvUrl: payload.cvUrl ? redactCvUrl(payload.cvUrl) : null,
    leadCorreo: payload.leadCorreo || null,
    leadNombre: payload.leadNombre || null,
    cvAnalizadoEnMsg: payload.cvAnalizadoEnMsg === true,
    tieneLeadExtraido: Boolean(payload.leadExtraido),
    tieneAnalisisCV: Boolean(payload.analisisCV),
    origen: payload.origen || null
  });

  const started = Date.now();
  try {
    const { data, status } = await axios.post(endpoint, payload, {
      headers,
      timeout: POST_TIMEOUT_MS
    });
    logAgenda('panel.crearReunion.ok', {
      status,
      ms: Date.now() - started,
      reunionId: (data && (data.id || data.reunionId || data.reunion?.id)) || null,
      urlReunion:
        (data &&
          (data.urlReunion ||
            data.urlReunionLead ||
            data.reunion?.urlReunion ||
            data.meetUrl)) ||
        null,
      keys: data && typeof data === 'object' ? Object.keys(data) : []
    });
    return data;
  } catch (error) {
    const normalized = normalizePanelError(error);
    warnAgenda('panel.crearReunion.error', {
      ms: Date.now() - started,
      status: normalized.status,
      message: normalized.message,
      axiosCode: error.code || null,
      panelBody: normalized.panelBody || null
    });
    throw normalized;
  }
}

/**
 * @param {{
 *   gerenteEmail?: string,
 *   vendedorId: string,
 *   fecha: string,
 *   horaInicio: string,
 *   horaFin: string,
 *   cvFile?: Buffer,
 *   cvFileName?: string,
 *   cvMime?: string,
 *   cvUrl?: string,
 *   titulo?: string,
 *   descripcion?: string,
 *   leadCorreo?: string,
 *   leadNombre?: string,
 *   leadTelefono?: string,
 *   leadCiudad?: string,
 *   leadEstado?: string,
 *   leadExtraido?: object,
 *   analisisCV?: object,
 *   cvAnalizadoEnMsg?: boolean,
 *   origen?: string
 * }} body
 */
async function crearReunion(body = {}) {
  const gerenteEmail = body.gerenteEmail || defaultGerenteEmail();
  const cvUrl = String(body.cvUrl || '').trim();
  if (hasCvFile(body)) {
    return postReunionMultipart(gerenteEmail, body);
  }
  if (cvUrl) {
    return postReunionJson(gerenteEmail, { ...body, cvUrl });
  }
  const err = new Error('Falta cvFile o cvUrl para enviar el CV al panel');
  err.status = 400;
  throw err;
}

/**
 * Reagenda una reunión ya creada en Panel.
 * @param {{
 *   reunionId: string,
 *   gerenteEmail?: string,
 *   fecha: string,
 *   horaInicio: string,
 *   horaFin: string,
 *   vendedorId?: string
 * }} body
 */
async function actualizarReunion(body = {}) {
  const reunionId = String(body.reunionId || '').trim();
  if (!reunionId) {
    const err = new Error('reunionId es obligatorio para reagendar');
    err.status = 400;
    throw err;
  }
  const gerenteEmail = body.gerenteEmail || defaultGerenteEmail();
  const headers = buildHeaders(gerenteEmail);
  const vendedorId = String(body.vendedorId || '').trim();
  const fecha = String(body.fecha || '').trim();
  const horaInicio = String(body.horaInicio || '').trim();
  const horaFin = String(body.horaFin || '').trim();
  if (!fecha || !horaInicio || !horaFin) {
    const err = new Error('fecha, horaInicio y horaFin son obligatorios para reagendar');
    err.status = 400;
    throw err;
  }

  const payload = { fecha, horaInicio, horaFin };
  if (vendedorId) payload.vendedorId = vendedorId;
  const endpoint = `${panelBaseUrl()}/api/external/msg/reuniones/${encodeURIComponent(reunionId)}`;
  logAgenda('panel.actualizarReunion.request', {
    endpoint,
    reunionId,
    gerenteEmail,
    vendedorId: vendedorId || null,
    fecha,
    horaInicio,
    horaFin
  });

  const started = Date.now();
  try {
    const { data, status } = await axios.patch(endpoint, payload, {
      headers,
      timeout: POST_TIMEOUT_MS
    });
    logAgenda('panel.actualizarReunion.ok', {
      status,
      ms: Date.now() - started,
      reunionId,
      keys: data && typeof data === 'object' ? Object.keys(data) : []
    });
    return data;
  } catch (error) {
    const normalized = normalizePanelError(error);
    warnAgenda('panel.actualizarReunion.error', {
      ms: Date.now() - started,
      reunionId,
      status: normalized.status,
      message: normalized.message,
      panelBody: normalized.panelBody || null
    });
    throw normalized;
  }
}

module.exports = {
  getDisponibilidad,
  crearReunion,
  actualizarReunion,
  isConfigured,
  defaultGerenteEmail,
  panelBaseUrl,
  clearDisponibilidadCache
};
