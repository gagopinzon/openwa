const androidGatewayStore = require('./androidGatewayStore');

/**
 * Encola jobs Android y espera a que todos terminen (sent/failed/expired).
 * @param {object} opts
 * @param {Array<{ nombre?: string, telefono: string, mensajeIA?: string, mensaje?: string, saludo?: string, deviceId?: string, sessionId?: string }>} [opts.contacts]
 * @param {Array<{ telefono: string, mensaje: string, deviceId: string, nombre?: string, logicalSessionId?: string, meta?: object }>} [opts.assignments]
 * @param {string[]} [opts.sessionIds]
 * @param {string|null} [opts.batchId]
 * @param {(row: object) => void} [opts.onMessageResult]
 * @param {number} [opts.pollMs]
 * @param {number} [opts.timeoutMs]
 */
async function runAndroidSendJob({
  contacts,
  assignments = null,
  sessionIds,
  batchId = null,
  onMessageResult = null,
  pollMs = 2000,
  timeoutMs = 24 * 60 * 60 * 1000
} = {}) {
  let jobs;

  if (Array.isArray(assignments) && assignments.length > 0) {
    jobs = androidGatewayStore.enqueueAssignedJobs(
      assignments.map((a) => ({
        telefono: a.telefono,
        mensaje: a.mensaje || a.mensajeIA || '',
        deviceId: a.deviceId,
        nombre: a.nombre || null,
        batchId,
        logicalSessionId: a.logicalSessionId || a.sessionId || null,
        meta: a.meta || null
      }))
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

    const items = (contacts || []).map((c) => {
      const mensaje = String(c.mensajeIA || c.mensaje || '').trim();
      return {
        telefono: String(c.telefono || '').trim(),
        mensaje,
        nombre: c.nombre || null,
        batchId,
        meta: {
          saludo: c.saludo || null,
          cvId: c.cvId || null,
          archivoOriginal: c.archivoOriginal || null
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
  runAndroidSendJob
};
