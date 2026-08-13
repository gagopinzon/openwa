const { resolveOpenWASessionId } = require('./sessionsStore');
const {
  formatPhoneToChatId,
  getSessionStatus,
  sendTextMessage,
  extractProfileName
} = require('./openwaClient');
const { getSessionSenderName } = require('./sessionsStore');
const { applySenderName } = require('./messageSignature');
const { resolveExactCounts, buildQueuesFromCounts } = require('./sessionDistribution');
const { buildOutboundMessageParts } = require('./aiService');
const {
  getFailoverConfig,
  classifySendError,
  createFailoverContext,
  requeueContact,
  drainSessionQueue
} = require('./sendFailover');

/** Id lógico para pausar/abortar envíos round-robin multi-sesión */
const ROUND_ROBIN_CONTROL_ID = '__roundrobin__';

/**
 * @param {{ minSeconds?: number, maxSeconds?: number }|null} delayRange
 * @param {number} [delayMinutesFallback]
 */
function normalizeDelayRange(delayRange, delayMinutesFallback = 3) {
  const fallbackSec = Math.max(1, Math.round(Number(delayMinutesFallback) || 3) * 60);
  const minSeconds = Math.max(
    1,
    Math.floor(Number(delayRange?.minSeconds) || fallbackSec)
  );
  const maxSeconds = Math.max(
    minSeconds,
    Math.floor(Number(delayRange?.maxSeconds) || Math.max(fallbackSec, minSeconds))
  );
  return { minSeconds, maxSeconds };
}

/**
 * Espera aleatoria entre mensajes, respetando controles de pausa/aborto.
 * @param {Function|null} checkControls
 * @param {Function|null} onWaitProgress - (remainingMs, totalMs) => void
 * @param {{ minSeconds?: number, maxSeconds?: number }|null} delayRange
 * @returns {'ok'|'aborted'}
 */
async function waitBetweenMessages(checkControls, onWaitProgress = null, delayRange = null) {
  const { minSeconds, maxSeconds } = normalizeDelayRange(delayRange);
  const randomDelaySeconds =
    Math.floor(Math.random() * (maxSeconds - minSeconds + 1)) + minSeconds;
  const delayMs = randomDelaySeconds * 1000;

  const minutes = Math.floor(randomDelaySeconds / 60);
  const seconds = randomDelaySeconds % 60;
  let timeDisplay = '';
  if (minutes > 0 && seconds > 0) {
    timeDisplay = `${minutes} minuto${minutes > 1 ? 's' : ''} y ${seconds} segundo${seconds > 1 ? 's' : ''}`;
  } else if (minutes > 0) {
    timeDisplay = `${minutes} minuto${minutes > 1 ? 's' : ''}`;
  } else {
    timeDisplay = `${seconds} segundo${seconds > 1 ? 's' : ''}`;
  }

  console.log(`Esperando ${timeDisplay} antes del siguiente mensaje...`);

  let remainingTime = delayMs;
  const checkInterval = 5000;

  const reportWait = () => {
    if (onWaitProgress) {
      try {
        onWaitProgress(remainingTime, delayMs);
      } catch (err) {
        console.warn('onWaitProgress:', err.message);
      }
    }
  };

  reportWait();

  while (remainingTime > 0) {
    if (checkControls) {
      const controls = checkControls();

      if (controls.aborted) {
        console.log('Envío abortado durante la espera');
        return 'aborted';
      }

      if (controls.skipWait) {
        console.log('Saltando espera - enviando siguiente mensaje inmediatamente');
        return 'ok';
      }

      while (controls.timePaused && !controls.aborted && !controls.skipWait) {
        console.log('Tiempo de espera pausado...');
        reportWait();
        await new Promise((resolve) => setTimeout(resolve, 1000));

        if (checkControls) {
          const newControls = checkControls();
          if (newControls.aborted) return 'aborted';

          if (newControls.skipWait) {
            console.log('Saltando espera desde pausa de tiempo');
            return 'ok';
          }

          controls.timePaused = newControls.timePaused;
        }
      }

      while (controls.paused && !controls.aborted && !controls.timePaused) {
        console.log('Envío pausado durante la espera...');
        reportWait();
        await new Promise((resolve) => setTimeout(resolve, 5000));

        if (checkControls) {
          const newControls = checkControls();
          if (newControls.aborted) return 'aborted';

          if (newControls.skipWait) {
            console.log('Saltando espera desde modo pausa');
            return 'ok';
          }

          controls.paused = newControls.paused;
        }
      }
    }

    if (checkControls) {
      const controls = checkControls();
      if (controls.timePaused) {
        reportWait();
        await new Promise((resolve) => setTimeout(resolve, 1000));
        continue;
      }
    }

    const waitTime = Math.min(remainingTime, checkInterval);
    await new Promise((resolve) => setTimeout(resolve, waitTime));
    remainingTime -= waitTime;
    reportWait();
  }

  return 'ok';
}

async function applySendingControls(checkControls) {
  if (!checkControls) return 'ok';

  const controls = checkControls();
  if (controls.aborted) {
    console.log('Envío abortado por el usuario');
    return 'aborted';
  }

  while (controls.paused && !controls.aborted) {
    console.log('Envío pausado, esperando...');
    await new Promise((resolve) => setTimeout(resolve, 5000));
    const next = checkControls();
    if (next.aborted) {
      console.log('Envío abortado por el usuario');
      return 'aborted';
    }
    controls.paused = next.paused;
  }

  return checkControls().aborted ? 'aborted' : 'ok';
}

class OpenWAWhatsAppService {
  constructor(sessionId = 'default') {
    this.logicalSessionId = sessionId;
    this.openwaSessionId = null;
    this.isInitialized = false;
  }

  /**
   * Verifica que la sesión OpenWA esté conectada.
   * @returns {Promise<void>}
   */
  async initWhatsApp() {
    this.openwaSessionId = resolveOpenWASessionId(this.logicalSessionId);
    console.log(
      `Verificando sesión OpenWA "${this.logicalSessionId}" → ${this.openwaSessionId}...`
    );

    const status = await getSessionStatus(this.openwaSessionId);
    if (!status.connected) {
      throw new Error(
        `Sesión OpenWA "${this.openwaSessionId}" no está conectada (estado: ${status.status || 'desconocido'}). ` +
          'Escanea el QR en el dashboard de OpenWA.'
      );
    }

    this.isInitialized = true;
    console.log(`Sesión OpenWA lista (${this.logicalSessionId})`);
  }

  /**
   * @param {string} phone
   * @param {string} message
   * @param {{ skipHumanDelay?: boolean }} [options]
   * @returns {Promise<boolean>}
   */
  async sendMessage(phone, message, options = {}) {
    if (!this.isInitialized || !this.openwaSessionId) {
      throw new Error('WhatsApp no está inicializado. Llama a initWhatsApp() primero.');
    }

    try {
      const senderName = getSessionSenderName(this.logicalSessionId);
      const finalMessage = applySenderName(message, senderName);
      console.log(`Enviando mensaje a ${phone} vía OpenWA (remitente: ${senderName})...`);

      const chatId = formatPhoneToChatId(phone);

      if (!options.skipHumanDelay) {
        const humanDelayMs = Math.floor(3000 + Math.random() * 7000);
        console.log(
          `Esperando ${(humanDelayMs / 1000).toFixed(1)} segundos antes de enviar (delay humano)...`
        );
        await new Promise((resolve) => setTimeout(resolve, humanDelayMs));
      }

      const result = await sendTextMessage(this.openwaSessionId, chatId, finalMessage);
      console.log(`Mensaje enviado a ${phone} (id: ${result.messageId || 'n/a'})`);
      return true;
    } catch (error) {
      const msg = error.message || String(error);
      const errorClass = classifySendError(error);
      if (error && typeof error === 'object') {
        error.errorClass = errorClass;
      }
      if (errorClass === 'invalid') {
        console.log(`Número inválido o sin WhatsApp: ${phone} — ${msg}`);
      } else {
        console.error(`Error enviando mensaje a ${phone}:`, msg);
      }
      throw error;
    }
  }

  /**
   * Envía el contacto en 1–4 mensajes (saludo / extras / speech), elegidos al azar.
   * @param {{ telefono: string, nombre?: string, saludo?: string, mensajeIA: string }} contact
   * @returns {Promise<boolean>}
   */
  async sendContactWithGreeting(contact) {
    const parts = buildOutboundMessageParts(contact);
    console.log(
      `Burst → ${contact.telefono}: ${parts.length} mensaje${parts.length === 1 ? '' : 's'}`
    );

    for (let i = 0; i < parts.length; i++) {
      const part = parts[i];
      const preview =
        part.length > 80 ? `${part.substring(0, 80).replace(/\n/g, ' ')}...` : part;
      console.log(`${i + 1}/${parts.length} → "${preview}"`);

      const ok = await this.sendMessage(contact.telefono, part, {
        skipHumanDelay: i > 0
      });
      if (!ok) return false;

      if (i < parts.length - 1) {
        const pauseMs = 1500 + Math.floor(Math.random() * 2000); // 1.5–3.5 s
        console.log(
          `Pausa ${(pauseMs / 1000).toFixed(1)}s antes del siguiente fragmento...`
        );
        await new Promise((resolve) => setTimeout(resolve, pauseMs));
      }
    }

    return true;
  }

  /**
   * @param {Array} contacts
   * @param {number} delayMinutes
   * @param {Function|null} onProgress
   * @param {Function|null} checkControls
   * @param {Function|null} onMessageResult
   * @returns {Promise<Array>}
   */
  async sendBulkMessages(
    contacts,
    delayMinutes = 3,
    onProgress = null,
    checkControls = null,
    onMessageResult = null,
    onWaitProgress = null,
    delayRange = null
  ) {
    if (!this.isInitialized) {
      throw new Error('WhatsApp no está inicializado. Llama a initWhatsApp() primero.');
    }

    const results = [];
    const range = normalizeDelayRange(delayRange, delayMinutes);

    console.log(
      `Iniciando envío masivo de ${contacts.length} mensajes con delay aleatorio de ${range.minSeconds}-${range.maxSeconds}s`
    );

    for (let i = 0; i < contacts.length; i++) {
      const contact = contacts[i];

      if ((await applySendingControls(checkControls)) === 'aborted') {
        break;
      }

      const mensajePreview =
        contact.mensajeIA.length > 100
          ? contact.mensajeIA.substring(0, 100) + '...'
          : contact.mensajeIA;

      console.log(
        `Enviando mensaje ${i + 1}/${contacts.length} a ${contact.nombre} (${contact.telefono})`
      );
      console.log(`Saludo: ${contact.saludo || '(auto)'}`);
      console.log(`Mensaje: ${mensajePreview}`);

      if (onProgress) {
        onProgress({
          readyToSend: true,
          current: i + 1,
          total: contacts.length,
          sessionCurrent: i + 1,
          sessionTotal: contacts.length,
          nombre: contact.nombre,
          telefono: contact.telefono,
          saludo: contact.saludo,
          mensajeIA: contact.mensajeIA,
          sessionId: this.logicalSessionId,
          phase: 'sending'
        });
      }

      try {
        const success = await this.sendContactWithGreeting(contact);

        const rowSuccess = {
          index: i,
          nombre: contact.nombre,
          telefono: contact.telefono,
          saludo: contact.saludo,
          mensajeIA: contact.mensajeIA,
          cvId: contact.cvId || null,
          archivoOriginal: contact.archivoOriginal || null,
          success,
          timestamp: new Date().toISOString()
        };
        results.push(rowSuccess);
        if (onMessageResult) {
          try {
            onMessageResult(rowSuccess);
          } catch (cbErr) {
            console.warn('onMessageResult:', cbErr.message);
          }
        }

        if (onProgress) {
          onProgress({
            current: i + 1,
            total: contacts.length,
            sessionCurrent: i + 1,
            sessionTotal: contacts.length,
            nombre: contact.nombre,
            telefono: contact.telefono,
            saludo: contact.saludo,
            mensajeIA: contact.mensajeIA,
            sessionId: this.logicalSessionId,
            success,
            phase: 'sent'
          });
        }

        if (i < contacts.length - 1) {
          if (onProgress) {
            onProgress({
              sessionId: this.logicalSessionId,
              sessionCurrent: i + 1,
              sessionTotal: contacts.length,
              phase: 'waiting',
              nombre: contacts[i + 1].nombre,
              telefono: contacts[i + 1].telefono
            });
          }

          const waitResult = await waitBetweenMessages(
            checkControls,
            onWaitProgress,
            range
          );
          if (waitResult === 'aborted') {
            return results;
          }
        }
      } catch (error) {
        console.error(`Error procesando contacto ${i + 1}:`, error.message);
        const rowFail = {
          index: i,
          nombre: contact.nombre,
          telefono: contact.telefono,
          saludo: contact.saludo,
          mensajeIA: contact.mensajeIA,
          cvId: contact.cvId || null,
          archivoOriginal: contact.archivoOriginal || null,
          success: false,
          error: error.message,
          timestamp: new Date().toISOString()
        };
        results.push(rowFail);
        if (onMessageResult) {
          try {
            onMessageResult(rowFail);
          } catch (cbErr) {
            console.warn('onMessageResult:', cbErr.message);
          }
        }
      }
    }

    console.log('Envío masivo completado');
    return results;
  }

  async close() {
    this.isInitialized = false;
    console.log('Sesión OpenWA desvinculada del servicio (sigue activa en el servidor OpenWA)');
  }

  isReady() {
    return this.isInitialized;
  }
}

/**
 * @param {OpenWAWhatsAppService} service
 * @param {{ healthRetries: number, healthWaitMs: number }} cfg
 */
async function ensureSessionHealthy(service, cfg) {
  const openwaSessionId = service.openwaSessionId;
  let lastStatus = null;
  for (let attempt = 0; attempt <= cfg.healthRetries; attempt++) {
    try {
      lastStatus = await getSessionStatus(openwaSessionId);
      if (lastStatus.connected) return { ok: true, status: lastStatus };
    } catch (error) {
      lastStatus = { connected: false, status: error.message || 'error' };
      if (classifySendError(error) !== 'session_dead' && attempt < cfg.healthRetries) {
        await new Promise((r) => setTimeout(r, cfg.healthWaitMs));
        continue;
      }
      if (attempt >= cfg.healthRetries) {
        return { ok: false, status: lastStatus, error };
      }
    }
    if (attempt < cfg.healthRetries) {
      await new Promise((r) => setTimeout(r, cfg.healthWaitMs));
    }
  }
  return { ok: false, status: lastStatus };
}

function emitMessageResult(onMessageResult, row) {
  if (!onMessageResult) return;
  try {
    onMessageResult(row);
  } catch (cbErr) {
    console.warn('onMessageResult:', cbErr.message);
  }
}

function buildResultRow(contact, globalIndex, logicalSessionId, extra = {}) {
  return {
    index: globalIndex,
    nombre: contact.nombre,
    telefono: contact.telefono,
    saludo: contact.saludo,
    mensajeIA: contact.mensajeIA,
    cvId: contact.cvId || null,
    archivoOriginal: contact.archivoOriginal || null,
    sessionId: logicalSessionId,
    timestamp: new Date().toISOString(),
    ...extra
  };
}

function emitDrainProgress(onProgress, logicalSessionId, moved) {
  if (!onProgress) return;
  onProgress({
    sessionId: logicalSessionId,
    phase: 'session_dead',
    sessionTotal: 0
  });
  for (const entry of moved) {
    if (!entry.toSessionId) continue;
    onProgress({
      sessionId: logicalSessionId,
      phase: 'requeued',
      nombre: entry.item.contact && entry.item.contact.nombre,
      telefono: entry.item.contact && entry.item.contact.telefono,
      requeuedFrom: logicalSessionId,
      requeuedTo: entry.toSessionId
    });
  }
}

function finalizeDrainFailures(moved, logicalSessionId, onMessageResult, results) {
  for (const entry of moved) {
    if (entry.toSessionId) continue;
    const contact = entry.item.contact;
    const rowFail = buildResultRow(contact, entry.item.globalIndex, logicalSessionId, {
      success: false,
      error: entry.reason || 'no_healthy_sessions'
    });
    results.push(rowFail);
    emitMessageResult(onMessageResult, rowFail);
  }
}

/**
 * Procesa la cola de contactos de una sola sesión con su propio timer.
 * Con failoverCtx, reencola a otras líneas si esta se cae o el envío falla de forma recuperable.
 */
async function sendSessionQueue(
  logicalSessionId,
  service,
  queueItems,
  totalContacts,
  onProgress = null,
  checkControls = null,
  onMessageResult = null,
  onWaitProgress = null,
  failoverCtx = null,
  delayRange = null
) {
  const results = [];
  const cfg = getFailoverConfig();
  let processedOnThisSession = 0;
  const range = normalizeDelayRange(delayRange);

  try {
  while (true) {
    if (failoverCtx && failoverCtx.deadSessionIds.has(logicalSessionId)) {
      break;
    }

    if ((await applySendingControls(checkControls)) === 'aborted') {
      break;
    }

    if (queueItems.length === 0) {
      if (!failoverCtx || !failoverCtx.busySessions) break;
      const peersBusy = [...failoverCtx.busySessions].some(
        (id) => id !== logicalSessionId
      );
      if (!peersBusy) break;
      await new Promise((r) => setTimeout(r, 500));
      continue;
    }

    const item = queueItems.shift();
    const { contact, globalIndex } = item;

    if (
      failoverCtx &&
      Array.isArray(item.triedSessionIds) &&
      item.triedSessionIds.includes(logicalSessionId)
    ) {
      const r = requeueContact(failoverCtx, item, logicalSessionId);
      if (r.ok) {
        if (onProgress) {
          onProgress({
            sessionId: logicalSessionId,
            phase: 'requeued',
            nombre: contact.nombre,
            telefono: contact.telefono,
            requeuedFrom: logicalSessionId,
            requeuedTo: r.toSessionId
          });
        }
      } else {
        const rowFail = buildResultRow(contact, globalIndex, logicalSessionId, {
          success: false,
          error: r.reason
        });
        results.push(rowFail);
        emitMessageResult(onMessageResult, rowFail);
      }
      continue;
    }

    const mensajePreview =
      contact.mensajeIA.length > 100
        ? contact.mensajeIA.substring(0, 100) + '...'
        : contact.mensajeIA;

    console.log(
      `Sesión ${logicalSessionId} ${processedOnThisSession + 1}/~${queueItems.length + 1} (global ${globalIndex + 1}/${totalContacts}): ${contact.nombre} (${contact.telefono})`
    );
    console.log(`Saludo: ${contact.saludo || '(auto)'}`);
    console.log(`Mensaje: ${mensajePreview}`);

    if (failoverCtx) {
      const health = await ensureSessionHealthy(service, cfg);
      if (!health.ok) {
        console.warn(
          `Sesión ${logicalSessionId} no saludable — drenando cola (${queueItems.length + 1} pendientes)`
        );
        queueItems.unshift(item);
        const moved = drainSessionQueue(failoverCtx, logicalSessionId);
        emitDrainProgress(onProgress, logicalSessionId, moved);
        finalizeDrainFailures(moved, logicalSessionId, onMessageResult, results);
        break;
      }
    }

    if (onProgress) {
      onProgress({
        readyToSend: true,
        current: globalIndex + 1,
        total: totalContacts,
        sessionCurrent: processedOnThisSession + 1,
        sessionTotal: processedOnThisSession + 1 + queueItems.length,
        nombre: contact.nombre,
        telefono: contact.telefono,
        saludo: contact.saludo,
        mensajeIA: contact.mensajeIA,
        sessionId: logicalSessionId,
        phase: 'sending'
      });
    }

    let success = false;
    let lastErr = null;
    const maxAttempts = failoverCtx ? cfg.localRetries + 1 : 1;

    for (let attempt = 0; attempt < maxAttempts; attempt++) {
      try {
        if (attempt > 0 && onProgress) {
          onProgress({
            sessionId: logicalSessionId,
            phase: 'retrying',
            nombre: contact.nombre,
            telefono: contact.telefono,
            sessionCurrent: processedOnThisSession + 1,
            sessionTotal: processedOnThisSession + 1 + queueItems.length
          });
        }
        success = await service.sendContactWithGreeting(contact);
        lastErr = null;
        break;
      } catch (error) {
        lastErr = error;
        const cls = error.errorClass || classifySendError(error);
        console.error(
          `Error sesión ${logicalSessionId} contacto ${contact.telefono} (intento ${attempt + 1}/${maxAttempts}):`,
          error.message
        );
        if (cls === 'invalid' || cls === 'session_dead') break;
        if (attempt >= maxAttempts - 1) break;
      }
    }

    if (success) {
      processedOnThisSession += 1;
      const row = buildResultRow(contact, globalIndex, logicalSessionId, { success: true });
      results.push(row);
      emitMessageResult(onMessageResult, row);

      if (onProgress) {
        onProgress({
          current: globalIndex + 1,
          total: totalContacts,
          sessionCurrent: processedOnThisSession,
          sessionTotal: processedOnThisSession + queueItems.length,
          nombre: contact.nombre,
          telefono: contact.telefono,
          saludo: contact.saludo,
          mensajeIA: contact.mensajeIA,
          sessionId: logicalSessionId,
          success: true,
          phase: 'sent'
        });
      }

      if (queueItems.length > 0) {
        const next = queueItems[0];
        if (onProgress) {
          onProgress({
            sessionId: logicalSessionId,
            sessionCurrent: processedOnThisSession,
            sessionTotal: processedOnThisSession + queueItems.length,
            phase: 'waiting',
            nombre: next.contact.nombre,
            telefono: next.contact.telefono
          });
        }
        const waitResult = await waitBetweenMessages(
          checkControls,
          onWaitProgress,
          range
        );
        if (waitResult === 'aborted') break;
      }
      continue;
    }

    const errorClass =
      (lastErr && lastErr.errorClass) || classifySendError(lastErr || 'unknown');
    const errorMsg = (lastErr && lastErr.message) || 'send_failed';

    if (errorClass === 'invalid' || !failoverCtx) {
      processedOnThisSession += 1;
      const rowFail = buildResultRow(contact, globalIndex, logicalSessionId, {
        success: false,
        error: errorClass === 'invalid' ? 'invalid_number' : errorMsg
      });
      results.push(rowFail);
      emitMessageResult(onMessageResult, rowFail);
      continue;
    }

    if (errorClass === 'session_dead') {
      console.warn(`Sesión ${logicalSessionId} muerta durante envío — drenando cola`);
      queueItems.unshift(item);
      const moved = drainSessionQueue(failoverCtx, logicalSessionId);
      emitDrainProgress(onProgress, logicalSessionId, moved);
      finalizeDrainFailures(moved, logicalSessionId, onMessageResult, results);
      break;
    }

    // transient → reencolar solo este contacto
    const r = requeueContact(failoverCtx, item, logicalSessionId);
    if (r.ok) {
      console.log(
        `↩ Reencolado ${contact.telefono} de ${logicalSessionId} → ${r.toSessionId}`
      );
      if (onProgress) {
        onProgress({
          sessionId: logicalSessionId,
          phase: 'requeued',
          nombre: contact.nombre,
          telefono: contact.telefono,
          requeuedFrom: logicalSessionId,
          requeuedTo: r.toSessionId
        });
      }
    } else {
      processedOnThisSession += 1;
      const rowFail = buildResultRow(contact, globalIndex, logicalSessionId, {
        success: false,
        error: r.reason
      });
      results.push(rowFail);
      emitMessageResult(onMessageResult, rowFail);
    }
  }
  } finally {
    if (failoverCtx && failoverCtx.busySessions) {
      failoverCtx.busySessions.delete(logicalSessionId);
    }
  }

  if (onProgress) {
    onProgress({
      sessionId: logicalSessionId,
      phase: 'done',
      sessionTotal: processedOnThisSession
    });
  }

  return results;
}

/**
 * Envía mensajes en paralelo por sesión: cada sesión tiene su cola y su timer independiente.
 * Si una línea cae, reencola pendientes a las vivas (round-robin).
 * @param {Map<string, OpenWAWhatsAppService>} servicesBySessionId
 * @param {string[]} sessionOrder
 */
async function sendRoundRobinBulk(
  servicesBySessionId,
  sessionOrder,
  contacts,
  onProgress = null,
  checkControlsBySession = null,
  onMessageResult = null,
  onWaitProgressBySession = null,
  sessionWeights = null,
  delayRange = null
) {
  const N = sessionOrder.length;
  const counts = resolveExactCounts(sessionOrder, sessionWeights, contacts.length);
  const queues = buildQueuesFromCounts(sessionOrder, contacts, counts);
  const failoverCtx = createFailoverContext(sessionOrder, queues);
  const sumCounts = counts.reduce((a, b) => a + b, 0) || 1;
  const range = normalizeDelayRange(delayRange);

  const distribution = sessionOrder.map((sId, i) => {
    const pct = Math.round((counts[i] / sumCounts) * 1000) / 10;
    return `${sId}: ${queues.get(sId).length} msgs (${pct}%)`;
  });
  console.log(
    `Envío paralelo: ${contacts.length} mensaje(s) entre ${N} sesión(es) con timers independientes + failover`
  );
  console.log(
    `Delay entre mensajes: ${range.minSeconds}-${range.maxSeconds}s (aleatorio)`
  );
  console.log(`📊 Distribución por cantidad → ${distribution.join(', ')}`);

  const sessionPromises = sessionOrder.map((logicalSessionId) => {
    const service = servicesBySessionId.get(logicalSessionId);
    if (!service) {
      return Promise.reject(
        new Error(`Servicio no encontrado para sesión "${logicalSessionId}"`)
      );
    }

    const queueItems = queues.get(logicalSessionId);
    const checkControls = checkControlsBySession
      ? checkControlsBySession(logicalSessionId)
      : null;
    const onWaitProgress = onWaitProgressBySession
      ? onWaitProgressBySession(logicalSessionId)
      : null;

    return sendSessionQueue(
      logicalSessionId,
      service,
      queueItems,
      contacts.length,
      onProgress,
      checkControls,
      onMessageResult,
      onWaitProgress,
      failoverCtx,
      range
    );
  });

  const allResults = await Promise.all(sessionPromises);
  const results = allResults.flat().sort((a, b) => a.index - b.index);

  console.log('Envío paralelo por sesiones completado');
  return results;
}

module.exports = OpenWAWhatsAppService;
module.exports.sendRoundRobinBulk = sendRoundRobinBulk;
module.exports.sendSessionQueue = sendSessionQueue;
module.exports.ROUND_ROBIN_CONTROL_ID = ROUND_ROBIN_CONTROL_ID;
module.exports.ensureSessionHealthy = ensureSessionHealthy;
