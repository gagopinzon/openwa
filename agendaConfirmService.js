const agendaPendingStore = require('./agendaPendingStore');
const panelMsgClient = require('./panelMsgClient');
const cvFileStore = require('./cvFileStore');

function autoConfirmEnabled() {
  const raw = String(process.env.AUTO_AGENDA_CONFIRM || 'true').trim().toLowerCase();
  return raw !== 'false' && raw !== '0' && raw !== 'no';
}

/**
 * Elige un vendedor del slot (primer candidato disponible).
 * @param {Array<{ gerenteEmail?: string, vendedorId?: string }>} candidates
 */
function pickVendor(candidates) {
  const list = Array.isArray(candidates) ? candidates : [];
  const hit = list.find((c) => c && String(c.vendedorId || '').trim());
  if (!hit) return null;
  return {
    vendedorId: String(hit.vendedorId).trim(),
    gerenteEmail: String(hit.gerenteEmail || '').trim().toLowerCase() || null
  };
}

/**
 * Crea la reunión en el panel y confirma la cita pendiente.
 * @param {object} pending
 * @param {{ buildConfirmedMeetingReply?: Function }} [opts]
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

  const vendor = pickVendor(pending.candidateVendors);
  if (!vendor || !vendor.vendedorId) {
    const err = new Error('No hay vendedor disponible para ese horario');
    err.status = 409;
    throw err;
  }

  const gerenteEmail =
    vendor.gerenteEmail || panelMsgClient.defaultGerenteEmail() || '';
  if (!gerenteEmail) {
    const err = new Error('Falta gerenteEmail para crear la reunión en el panel');
    err.status = 400;
    throw err;
  }

  const cvUrl = cvFileStore.buildCvPublicUrl(cvId);
  const panelData = await panelMsgClient.crearReunion({
    gerenteEmail,
    vendedorId: vendor.vendedorId,
    fecha: pending.fecha,
    horaInicio: pending.horaInicio,
    horaFin: pending.horaFin,
    cvUrl,
    titulo: `Sesión — ${pending.contactName || 'candidato'}`,
    leadNombre: pending.contactName,
    leadTelefono: pending.telefono,
    origen: 'msg_auto_agenda'
  });

  const panelReunionId =
    (panelData && (panelData.id || panelData.reunionId || panelData.reunion?.id)) ||
    null;
  const urlReunionLead =
    (panelData && (panelData.urlReunion || panelData.reunion?.urlReunion)) || null;

  const confirmed = agendaPendingStore.confirmPending(pending.id, {
    vendedorId: vendor.vendedorId,
    urlReunion: urlReunionLead || '',
    gerenteEmail,
    panelReunionId
  });

  return {
    confirmed,
    panel: panelData,
    urlReunionLead
  };
}

module.exports = {
  autoConfirmEnabled,
  pickVendor,
  confirmPendingInPanel
};
