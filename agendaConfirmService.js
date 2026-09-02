const agendaPendingStore = require('./agendaPendingStore');
const panelMsgClient = require('./panelMsgClient');
const cvFileStore = require('./cvFileStore');
const cvAnalysisService = require('./cvAnalysisService');
const { resolvePanelCvDelivery } = require('./panelCvDelivery');
const {
  extractMeetUrlFromPanel,
  isRetryablePanelError,
  sleep
} = require('./panelMeetUtils');
const { logAgenda, warnAgenda } = require('./agendaDebug');

function syncRetryAttempts() {
  const raw = Number(process.env.AGENDA_PANEL_SYNC_RETRIES || 2);
  return Number.isFinite(raw) && raw >= 0 ? Math.floor(raw) : 2;
}

function syncRetryDelayMs() {
  const raw = Number(process.env.AGENDA_PANEL_SYNC_RETRY_MS || 20000);
  return Number.isFinite(raw) && raw > 0 ? raw : 20000;
}

function autoConfirmEnabled() {
  const raw = String(process.env.AUTO_AGENDA_CONFIRM || 'true').trim().toLowerCase();
  return raw !== 'false' && raw !== '0' && raw !== 'no';
}

/**
 * @param {Array<{ gerenteEmail?: string, vendedorId?: string }>} candidates
 */
function listVendors(candidates) {
  const list = Array.isArray(candidates) ? candidates : [];
  const seen = new Set();
  const out = [];
  for (const c of list) {
    const vendedorId = String(c && c.vendedorId ? c.vendedorId : '').trim();
    if (!vendedorId || seen.has(vendedorId)) continue;
    seen.add(vendedorId);
    out.push({
      vendedorId,
      gerenteEmail: String(c.gerenteEmail || '').trim().toLowerCase() || null
    });
  }
  return out;
}

/**
 * @param {string} telefono
 */
function resolveLeadTelefono(telefono) {
  const t = String(telefono || '').trim();
  if (!t || t.startsWith('lid_')) return undefined;
  return t;
}

/**
 * @param {string} cvId
 */
function resolveCvEntry(cvId) {
  const id = String(cvId || '').trim();
  if (!id) return null;
  return (cvFileStore.loadCvsManifest() || []).find((c) => c && c.cvId === id) || null;
}

/**
 * @param {object} payload
 */
async function crearReunionWithRetries(payload) {
  const maxAttempts = syncRetryAttempts() + 1;
  let lastError = null;

  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    try {
      logAgenda('agenda-confirm.crearReunion.intento', {
        attempt,
        maxAttempts,
        vendedorId: payload.vendedorId,
        fecha: payload.fecha,
        horaInicio: payload.horaInicio
      });
      return await panelMsgClient.crearReunion(payload);
    } catch (error) {
      lastError = error;
      if (attempt < maxAttempts && isRetryablePanelError(error)) {
        const delay = syncRetryDelayMs() * attempt;
        warnAgenda('agenda-confirm.crearReunion.reintento', {
          attempt: attempt + 1,
          maxAttempts,
          delayMs: delay,
          message: error.message,
          status: error.status || null,
          panelBody: error.panelBody || null
        });
        console.warn(
          `[agenda-confirm] reintento ${attempt + 1}/${maxAttempts} en ${delay}ms: ${error.message}`
        );
        await sleep(delay);
        continue;
      }
      throw error;
    }
  }

  throw lastError || new Error('No se pudo crear la reunión en el panel');
}

/**
 * Crea la reunión en el panel (misma API que Agendar reunión en la UI).
 * Prueba cada vendedor disponible en el slot hasta que el panel acepte.
 * @param {object} pending
 */
async function confirmPendingInPanel(pending, opts = {}) {
  logAgenda('agenda-confirm.start', {
    pendingId: pending?.id,
    status: pending?.status,
    cvId: pending?.cvId,
    fecha: pending?.fecha,
    horaInicio: pending?.horaInicio,
    vendors: listVendors(pending?.candidateVendors || []).length
  });

  if (!pending || !pending.id) {
    const err = new Error('Cita pendiente inválida');
    err.status = 400;
    throw err;
  }
  if (pending.status === agendaPendingStore.STATUS.CONFIRMED) {
    const existingUrl = String(pending.urlReunion || '').trim();
    if (existingUrl) {
      return {
        confirmed: pending,
        panel: null,
        urlReunionLead: existingUrl,
        vendedorId: pending.vendedorId || null
      };
    }
    const err = new Error('La reunión ya fue confirmada pero sin liga de Meet');
    err.status = 409;
    throw err;
  }
  if (!panelMsgClient.isConfigured()) {
    const err = new Error('Integración con panel no configurada');
    err.status = 503;
    throw err;
  }

  const cvId = String(pending.cvId || '').trim();
  const cvMeta = cvFileStore.getCvFileMeta(cvId);
  if (!cvMeta) {
    warnAgenda('agenda-confirm.cvNoDisponible', { pendingId: pending.id, cvId });
    const err = new Error('Archivo del CV no está disponible');
    err.status = 404;
    throw err;
  }

  logAgenda('agenda-confirm.cvMeta', {
    pendingId: pending.id,
    cvId,
    fileName: cvMeta.fileName,
    mime: cvMeta.mime,
    publicBase: cvFileStore.publicBaseUrl() || null
  });

  const vendors = listVendors(pending.candidateVendors);
  if (!vendors.length) {
    const err = new Error('No hay vendedor disponible para ese horario');
    err.status = 409;
    throw err;
  }

  const cv = resolveCvEntry(cvId);
  const panelExtras = await cvAnalysisService.buildPanelAgendaExtras(cvId, {
    nombre: pending.contactName || cv?.nombre,
    telefono: pending.telefono || cv?.telefono
  });
  const enrichedCv = panelExtras.enriched || cv;
  const { leadExtraido, analisisCV, cvAnalizadoEnMsg } = panelExtras;
  const cvDelivery = await resolvePanelCvDelivery(cvId);
  logAgenda('agenda-confirm.cvDelivery', {
    pendingId: pending.id,
    cvId,
    delivery: cvDelivery.delivery,
    cvFileName: cvDelivery.cvFileName || null,
    cvBase64Bytes: cvDelivery.cvBase64 ? cvDelivery.cvBase64.length : null,
    cvUrlHost:
      cvDelivery.cvUrl && cvDelivery.delivery === 'url'
        ? (() => {
            try {
              return new URL(cvDelivery.cvUrl).hostname;
            } catch {
              return null;
            }
          })()
        : null
  });

  const leadNombre =
    pending.contactName || enrichedCv?.nombre || leadExtraido.leadNombre || undefined;
  const leadTelefono =
    resolveLeadTelefono(pending.telefono) ||
    enrichedCv?.telefono ||
    leadExtraido.leadTelefono ||
    undefined;
  const leadCorreo =
    leadExtraido.leadCorreo ||
    enrichedCv?.leadCorreo ||
    enrichedCv?.correo ||
    enrichedCv?.email ||
    undefined;

  if (!leadExtraido.leadCorreo) {
    warnAgenda('agenda-confirm.sinEmail', {
      pendingId: pending.id,
      cvId,
      leadExtraido
    });
    const err = new Error(
      'No se encontró email en el CV. Pide al lead un CV con correo visible o que lo indique.'
    );
    err.status = 400;
    throw err;
  }

  logAgenda('agenda-confirm.datosLead', {
    pendingId: pending.id,
    leadNombre,
    leadCorreo,
    leadTelefono: leadTelefono || null,
    cvAnalizadoEnMsg
  });

  let lastError = null;
  let panelData = null;
  let usedVendor = null;

  for (const vendor of vendors) {
    const gerenteEmail =
      vendor.gerenteEmail || panelMsgClient.defaultGerenteEmail() || '';
    if (!gerenteEmail) {
      lastError = new Error('Falta gerenteEmail para crear la reunión en el panel');
      continue;
    }
    try {
      logAgenda('agenda-confirm.probandoVendedor', {
        pendingId: pending.id,
        vendedorId: vendor.vendedorId,
        gerenteEmail
      });
      panelData = await crearReunionWithRetries({
        gerenteEmail,
        vendedorId: vendor.vendedorId,
        fecha: pending.fecha,
        horaInicio: pending.horaInicio,
        horaFin: pending.horaFin,
        ...(cvDelivery.delivery === 'base64'
          ? { cvBase64: cvDelivery.cvBase64, cvFileName: cvDelivery.cvFileName }
          : { cvUrl: cvDelivery.cvUrl }),
        titulo: `Sesión — ${leadNombre || 'candidato'}`,
        leadNombre,
        leadTelefono:
          leadTelefono && leadTelefono !== 'No encontrado' ? leadTelefono : undefined,
        leadCorreo:
          leadCorreo && String(leadCorreo).includes('@') ? leadCorreo : undefined,
        leadCiudad: enrichedCv?.leadCiudad || enrichedCv?.ciudad || undefined,
        leadEstado: enrichedCv?.leadEstado || enrichedCv?.estado || undefined,
        leadExtraido,
        analisisCV,
        cvAnalizadoEnMsg,
        origen: 'msg_auto_agenda'
      });
      usedVendor = { ...vendor, gerenteEmail };
      logAgenda('agenda-confirm.vendedorOk', {
        pendingId: pending.id,
        vendedorId: usedVendor.vendedorId,
        gerenteEmail: usedVendor.gerenteEmail
      });
      break;
    } catch (error) {
      lastError = error;
      warnAgenda('agenda-confirm.vendedorError', {
        pendingId: pending.id,
        vendedorId: vendor.vendedorId,
        status: error.status || null,
        message: error.message,
        panelBody: error.panelBody || null
      });
      if (error.status === 409) continue;
      throw error;
    }
  }

  if (!panelData || !usedVendor) {
    throw lastError || new Error('No se pudo crear la reunión en el panel');
  }

  const panelReunionId =
    (panelData && (panelData.id || panelData.reunionId || panelData.reunion?.id)) ||
    null;
  const urlReunionLead = extractMeetUrlFromPanel(panelData);

  logAgenda('agenda-confirm.panelRespuesta', {
    pendingId: pending.id,
    panelReunionId,
    urlReunionLead: urlReunionLead || null,
    panelKeys: panelData && typeof panelData === 'object' ? Object.keys(panelData) : []
  });

  const confirmed = agendaPendingStore.confirmPending(pending.id, {
    vendedorId: usedVendor.vendedorId,
    urlReunion: urlReunionLead || '',
    gerenteEmail: usedVendor.gerenteEmail,
    panelReunionId
  });

  return {
    confirmed,
    panel: panelData,
    urlReunionLead,
    vendedorId: usedVendor.vendedorId
  };
}

module.exports = {
  autoConfirmEnabled,
  listVendors,
  confirmPendingInPanel
};
