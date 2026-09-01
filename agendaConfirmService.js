const agendaPendingStore = require('./agendaPendingStore');
const panelMsgClient = require('./panelMsgClient');
const cvFileStore = require('./cvFileStore');

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
 * Crea la reunión en el panel (misma API que Agendar reunión en la UI).
 * Prueba cada vendedor disponible en el slot hasta que el panel acepte.
 * @param {object} pending
 */
async function confirmPendingInPanel(pending, opts = {}) {
  if (!pending || !pending.id) {
    const err = new Error('Cita pendiente inválida');
    err.status = 400;
    throw err;
  }
  if (!panelMsgClient.isConfigured()) {
    const err = new Error('Integración con panel no configurada');
    err.status = 503;
    throw err;
  }
  if (!cvFileStore.isPublicUrlConfigured()) {
    const err = new Error('WEBHOOK_PUBLIC_URL no está configurada para cvUrl pública');
    err.status = 503;
    throw err;
  }

  const cvId = String(pending.cvId || '').trim();
  if (!cvFileStore.getCvFileMeta(cvId)) {
    const err = new Error('Archivo del CV no está disponible');
    err.status = 404;
    throw err;
  }

  const vendors = listVendors(pending.candidateVendors);
  if (!vendors.length) {
    const err = new Error('No hay vendedor disponible para ese horario');
    err.status = 409;
    throw err;
  }

  const cv = resolveCvEntry(cvId);
  const cvUrl = cvFileStore.buildCvPublicUrl(cvId);
  const leadNombre =
    pending.contactName || cv?.nombre || undefined;
  const leadTelefono = resolveLeadTelefono(pending.telefono) || cv?.telefono || undefined;
  const leadCorreo =
    (cv && cv.leadCorreo) ||
    (cv && cv.correo) ||
    (cv && cv.email) ||
    undefined;

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
      panelData = await panelMsgClient.crearReunion({
        gerenteEmail,
        vendedorId: vendor.vendedorId,
        fecha: pending.fecha,
        horaInicio: pending.horaInicio,
        horaFin: pending.horaFin,
        cvUrl,
        titulo: `Sesión — ${leadNombre || 'candidato'}`,
        leadNombre,
        leadTelefono:
          leadTelefono && leadTelefono !== 'No encontrado' ? leadTelefono : undefined,
        leadCorreo:
          leadCorreo && String(leadCorreo).includes('@') ? leadCorreo : undefined,
        leadCiudad: cv?.leadCiudad || cv?.ciudad || undefined,
        leadEstado: cv?.leadEstado || cv?.estado || undefined,
        origen: 'msg_auto_agenda'
      });
      usedVendor = { ...vendor, gerenteEmail };
      break;
    } catch (error) {
      lastError = error;
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
  const urlReunionLead =
    (panelData &&
      (panelData.urlReunion ||
        panelData.reunion?.urlReunion ||
        panelData.meetUrl ||
        panelData.reunion?.meetUrl ||
        panelData.link ||
        panelData.reunion?.link)) ||
    null;

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
