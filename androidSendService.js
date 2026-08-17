const androidGatewayStore = require('./androidGatewayStore');
const sessionsStore = require('./sessionsStore');
const { applySenderName } = require('./messageSignature');
const { buildOutboundMessageParts } = require('./aiService');

/**
 * Arma el texto de outreach para Android (saludo + cuerpo) con remitente de la línea.
 * @param {{ saludo?: string, nombre?: string, mensajeIA?: string, mensaje?: string }} contact
 * @param {string|null} logicalSessionId
 */
function buildAndroidOutreachText(contact, logicalSessionId) {
  const senderName = logicalSessionId
    ? sessionsStore.getSessionSenderName(logicalSessionId)
    : '';
  const hasParts =
    contact &&
    (contact.mensajeIA != null || contact.saludo != null || contact.nombre != null);
  if (hasParts && (contact.mensajeIA || contact.saludo)) {
    const [single] = buildOutboundMessageParts({
      saludo: contact.saludo,
      nombre: contact.nombre,
      mensajeIA: contact.mensajeIA || contact.mensaje || ''
    });
    return applySenderName(single, senderName);
  }
  return applySenderName(String(contact?.mensaje || contact?.mensajeIA || ''), senderName);
}

/**
 * Encola jobs Android y espera a que todos terminen (sent/failed/expired).
 * @param {object} opts
 * @param {Array<{ nombre?: string, telefono: string, mensajeIA?: string, mensaje?: string, saludo?: string, deviceId?: string, sessionId?: string }>} [opts.contacts]
 * @param {Array<{ telefono: string, mensaje?: string, mensajeIA?: string, deviceId: string, nombre?: string, logicalSessionId?: string, saludo?: string, meta?: object }>} [opts.assignments]
 * @param {string[]} [opts.sessionIds]
 * @param {string|null} [opts.batchId]
 * @param {(row: object) => void} [opts.onMessageResult]
 * @param {() => boolean} [opts.shouldAbort]
 * @param {number} [opts.pollMs]
 * @param {number} [opts.timeoutMs]
 */
async function runAndroidSendJob({
  contacts,
  assignments = null,
  sessionIds,
  batchId = null,
  onMessageResult = null,
  shouldAbort = null,
  pollMs = 2000,
  timeoutMs = 24 * 60 * 60 * 1000
} = {}) {
  let jobs;

  if (Array.isArray(assignments) && assignments.length > 0) {
    jobs = androidGatewayStore.enqueueAssignedJobs(
      assignments.map((a) => {
        const logicalSessionId = a.logicalSessionId || a.sessionId || null;
        const mensaje = buildAndroidOutreachText(
          {
            telefono: a.telefono,
            nombre: a.nombre,
            saludo: a.saludo || a.meta?.saludo,
            mensajeIA: a.mensajeIA || a.mensaje || a.meta?.mensajeIA,
            mensaje: a.mensaje
          },
          logicalSessionId
        );
        return {
          telefono: a.telefono,
          mensaje,
          deviceId: a.deviceId,
          nombre: a.nombre || null,
          batchId,
          logicalSessionId,
          meta: a.meta || null
        };
      })
    );
  } else {
    const devices = androidGatewayStore.pickOnlineDevices({
      logicalSessionIds: sessionIds || [],
      maxAgeMs: 3 * 60 * 1000
    });

    if (!devices.length) {
      const err = new Error(
        'No hay dispositivos Android online. Registra y deja la app agente en marcha.'
      );
      err.code = 'no_android_devices';
      throw err;
    }

    const items = (contacts || []).map((c, index) => {
      const logicalSessionId =
        c.sessionId ||
        (Array.isArray(sessionIds) && sessionIds.length
          ? sessionIds[index % sessionIds.length]
          : null);
      const mensaje = buildAndroidOutreachText(c, logicalSessionId);
      return {
        telefono: String(c.telefono || '').trim(),
        mensaje,
        nombre: c.nombre || null,
        batchId,
        meta: {
          saludo: c.saludo || null,
          cvId: c.cvId || null,
          archivoOriginal: c.archivoOriginal || null,
          logicalSessionId
        }
      };
    });

    jobs = androidGatewayStore.enqueueJobs(
      items,
      devices.map((d) => d.id)
    );
  }

  const jobIds = jobs.map((j) => j.id);
  const reported = new Set();
  const results = [];
  const started = Date.now();

  const emitRow = (job) => {
    if (reported.has(job.id)) return;
    if (!['sent', 'failed', 'expired'].includes(job.status)) return;
    reported.add(job.id);
    const device = androidGatewayStore.getDevice(job.deviceId);
    const row = {
      success: job.status === 'sent',
      nombre: job.nombre,
      telefono: job.telefono,
      sessionId: job.meta?.logicalSessionId || device?.logicalSessionId || job.deviceId,
      error: job.error || null,
      channel: 'android',
      jobId: job.id
    };
    results.push(row);
    if (typeof onMessageResult === 'function') {
      try {
        onMessageResult(row);
      } catch (err) {
        console.warn('onMessageResult android:', err.message);
      }
    }
  };

  while (Date.now() - started < timeoutMs) {
    if (typeof shouldAbort === 'function' && shouldAbort()) {
      androidGatewayStore.failOpenJobsByBatchId(batchId, 'batch_finished');
      for (const job of androidGatewayStore.getJobsByIds(jobIds)) emitRow(job);
      return results;
    }
    const current = androidGatewayStore.getJobsByIds(jobIds);
    for (const job of current) emitRow(job);
    if (androidGatewayStore.areJobsTerminal(current)) {
      return results;
    }
    await new Promise((r) => setTimeout(r, pollMs));
  }

  for (const job of androidGatewayStore.getJobsByIds(jobIds)) {
    if (['sent', 'failed', 'expired'].includes(job.status)) {
      emitRow(job);
      continue;
    }
    try {
      const failed = androidGatewayStore.reportJobResult({
        jobId: job.id,
        deviceId: job.deviceId,
        ok: false,
        error: 'batch_timeout'
      });
      emitRow(failed);
    } catch {
      emitRow({ ...job, status: 'failed', error: 'batch_timeout' });
    }
  }

  return results;
}

module.exports = {
  runAndroidSendJob,
  buildAndroidOutreachText
};
