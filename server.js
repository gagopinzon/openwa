const express = require('express');
const multer = require('multer');
const path = require('path');
const fs = require('fs');
require('dotenv').config();

const { extractTextFromPDF, extractCVData } = require('./pdfProcessor');
const { generateBulkMessages, buildOutboundMessageParts } = require('./aiService');
const WhatsAppService = require('./openwaWhatsAppService');
const { sendRoundRobinBulk, ROUND_ROBIN_CONTROL_ID } = WhatsAppService;
const { previewDistribution, buildQueuesFromCounts } = require('./sessionDistribution');
const sessionsStore = require('./sessionsStore');
const {
  getSessionStatus,
  listOpenWASessions,
  isConnectedStatus,
  extractProfileName,
  formatPhoneToChatId,
  listChats,
  getChatHistory,
  downloadMessageMedia,
  isViewableMediaType,
  buildChatPreviewLines,
  searchMessages,
  invalidateOpenWACache,
  sendTextMessage,
  markChatRead,
  editMessage,
  deleteMessage,
  deleteChat,
  getContact,
  blockContact,
  unblockContact
} = require('./openwaClient');
const mediaCacheStore = require('./mediaCacheStore');
const {
  hydrateChatMedia,
  resolveMessageMedia,
  guessMimetypeFromType
} = require('./conversationMediaService');
const contactHistory = require('./contactHistoryStore');
const autoReplyService = require('./autoReplyService');
const autoReplyStore = require('./autoReplyStore');
const incomingMessagesStore = require('./incomingMessagesStore');
const usersStore = require('./usersStore');
const cvFileStore = require('./cvFileStore');
const panelMsgClient = require('./panelMsgClient');
const agendaAvailability = require('./agendaAvailability');
const agendaPendingStore = require('./agendaPendingStore');
const agendaOfferStore = require('./agendaOfferStore');
const sendQueueStore = require('./sendQueueStore');
const conversationPreviewStore = require('./conversationPreviewStore');
const androidGatewayStore = require('./androidGatewayStore');
const { runAndroidSendJob } = require('./androidSendService');
const {
  isAuthEnabled,
  authMiddleware,
  validateCredentials,
  createSessionToken,
  isAuthenticated,
  getRequestUser,
  filterSessionsForUser,
  canControlSession,
  canViewSession,
  requireSuper,
  forbidUnlessControlSessions,
  forbidUnlessViewSession,
  setAuthCookie,
  clearAuthCookie
} = require('./auth');

const app = express();
const PORT = process.env.PORT || 3445;
const MAX_SEND_QUEUE_TIMEOUT_MS = 2_147_483_647;
const SEND_QUEUE_RETRY_MS = 10_000;
let sendQueueTimer = null;
let sendQueueTimerBatchId = null;

function clearSendQueueTimer() {
  if (sendQueueTimer) {
    clearTimeout(sendQueueTimer);
  }
  sendQueueTimer = null;
  sendQueueTimerBatchId = null;
}

function armSendQueueTimer(retryDelayMs = null) {
  clearSendQueueTimer();
  const batch = sendQueueStore.getNextScheduledBatch();
  if (!batch || batch.status !== sendQueueStore.STATUS.SCHEDULED || !batch.scheduledAt) {
    return;
  }
  const when = Date.parse(batch.scheduledAt);
  if (!Number.isFinite(when)) return;
  const remaining = Math.max(0, when - Date.now());
  const delay =
    retryDelayMs == null
      ? Math.min(remaining, MAX_SEND_QUEUE_TIMEOUT_MS)
      : Math.min(Math.max(0, retryDelayMs), MAX_SEND_QUEUE_TIMEOUT_MS);
  sendQueueTimerBatchId = batch.id;
  sendQueueTimer = setTimeout(async () => {
    const armedBatchId = sendQueueTimerBatchId;
    sendQueueTimer = null;
    sendQueueTimerBatchId = null;

    const current = sendQueueStore.getBatchById(armedBatchId);
    if (!current || current.status !== sendQueueStore.STATUS.SCHEDULED) {
      armSendQueueTimer();
      return;
    }

    const currentWhen = Date.parse(current.scheduledAt);
    if (Number.isFinite(currentWhen) && currentWhen > Date.now()) {
      armSendQueueTimer();
      return;
    }

    try {
      await dispatchQueuedBatch(null, armedBatchId);
    } catch (err) {
      console.error('send-queue timer dispatch:', err.message);
      const pending = sendQueueStore.getBatchById(armedBatchId);
      if (
        err.status === 409 &&
        pending &&
        pending.status === sendQueueStore.STATUS.SCHEDULED
      ) {
        armSendQueueTimer(SEND_QUEUE_RETRY_MS);
      } else {
        armSendQueueTimer();
      }
    }
  }, delay);
  console.log(
    `🗓️ Cola programada ${batch.id} en ${Math.round(remaining / 1000)}s (${batch.scheduledAt})`
  );
}

// Middleware
app.use(
  express.json({
    limit: '1mb',
    verify: (req, _res, buf) => {
      if (req.path === '/api/webhooks/openwa') {
        req.rawBody = buf;
      }
    }
  })
);
// Nota: express.static se mueve al final para que las rutas API tengan prioridad

// Configuración de multer para subida de archivos
const storage = multer.memoryStorage();
const upload = multer({
  storage: storage,
  fileFilter: (req, file, cb) => {
    if (file.mimetype === 'application/pdf') {
      cb(null, true);
    } else {
      cb(new Error('Solo se permiten archivos PDF'), false);
    }
  },
  limits: {
    fileSize: 10 * 1024 * 1024, // 10MB máximo por archivo
    files: 100 // Máximo 100 archivos por carga
  }
});

// Almacenar datos de CVs (persistidos en data/cvs-manifest.json + data/cv-files/)
let cvsData = cvFileStore.loadCvsManifest();
if (cvsData.length > 0) {
  console.log(`[cvs] Restaurados ${cvsData.length} CV(s) desde disco`);
}

function persistCvsData() {
  try {
    const n = cvFileStore.saveCvsManifest(cvsData);
    return n;
  } catch (err) {
    console.error('[cvs] Error persistiendo manifest:', err.message);
    return 0;
  }
}

/** Quita de la mesa de trabajo los CVs enviados con éxito (evita reenvío accidental). */
function removeSuccessfullySentFromWorkspace(results) {
  if (!Array.isArray(results) || results.length === 0) {
    return { removed: 0, remaining: cvsData.length };
  }

  const sentPhones = results
    .filter((r) => r && r.success && r.telefono)
    .map((r) => r.telefono);

  if (sentPhones.length === 0) {
    return { removed: 0, remaining: cvsData.length };
  }

  const before = cvsData.length;
  cvsData = cvsData.filter((cv) => {
    const phone = cv?.telefono;
    if (!phone || phone === 'No encontrado') return true;
    return !sentPhones.some((sent) => contactHistory.phonesMatch(phone, sent));
  });
  const removed = before - cvsData.length;
  if (removed > 0) {
    persistCvsData();
    console.log(
      `🧹 Mesa de trabajo: quitados ${removed} CV(s) ya enviados; quedan ${cvsData.length}`
    );
  }
  return { removed, remaining: cvsData.length };
}

/**
 * Resuelve el CV del lead por teléfono (o cvId del historial).
 * @param {string} phone
 * @param {{ cvId?: string|null }} [hints]
 */
function findCvForPhone(phone, hints = {}) {
  const reusable = cvsData.filter((c) => c && c.procesado && c.cvId);
  if (hints.cvId) {
    const byId = reusable.find((c) => c.cvId === hints.cvId);
    if (byId) return byId;
  }
  if (!phone) return null;
  return (
    reusable.find((c) => contactHistory.phonesMatch(c.telefono, phone)) || null
  );
}

function publicCvSummary(cv) {
  if (!cv) return null;
  return {
    cvId: cv.cvId,
    nombre: cv.nombre || '',
    telefono: cv.telefono || '',
    archivoOriginal: cv.archivoOriginal || '',
    experiencia: String(cv.experiencia || '').slice(0, 200)
  };
}
const whatsappServices = new Map(); // Map<sessionId, WhatsAppService>

/** @type {{ inProgress: boolean, current: number, total: number, nombre: string|null, error: string|null, completedAt: number|null }} */
let generationState = {
  inProgress: false,
  current: 0,
  total: 0,
  nombre: null,
  error: null,
  completedAt: null
};

/** @type {{ inProgress: boolean, total: number, successCount: number, completedCount: number, sessionIds: string[], startedAt: number|null, completedAt: number|null, error: string|null, message: string|null, results: Array|null, skippedAlreadyContacted: Array, testMode: boolean }} */
let lastSendJob = {
  inProgress: false,
  total: 0,
  successCount: 0,
  completedCount: 0,
  sessionIds: [],
  startedAt: null,
  completedAt: null,
  error: null,
  message: null,
  results: null,
  skippedAlreadyContacted: [],
  testMode: false
};

function isAnySendingInProgress() {
  return lastSendJob.inProgress || [...sessionStates.values()].some((s) => s.sendingInProgress);
}

function buildSendProgressHandlers(controlId) {
  const onProgress = (progressData) => {
    if (progressData.sessionId) {
      const st = getSessionState(progressData.sessionId);
      st.liveStatus = {
        phase: progressData.phase || (progressData.readyToSend ? 'sending' : 'sent'),
        nombre: progressData.nombre,
        telefono: progressData.telefono,
        sessionCurrent: progressData.sessionCurrent,
        sessionTotal: progressData.sessionTotal
      };
    }

    if (progressData.readyToSend) {
      broadcastEvent('readyToSend', {
        current: progressData.current,
        total: progressData.total,
        nombre: progressData.nombre,
        telefono: progressData.telefono,
        sessionId: progressData.sessionId || controlId,
        sessionCurrent: progressData.sessionCurrent,
        sessionTotal: progressData.sessionTotal,
        phase: progressData.phase || 'sending'
      });
    } else if (progressData.sessionId && progressData.phase) {
      broadcastEvent('sessionProgress', {
        sessionId: progressData.sessionId,
        phase: progressData.phase,
        nombre: progressData.nombre,
        telefono: progressData.telefono,
        current: progressData.current,
        total: progressData.total,
        sessionCurrent: progressData.sessionCurrent,
        sessionTotal: progressData.sessionTotal,
        success: progressData.success,
        requeuedFrom: progressData.requeuedFrom,
        requeuedTo: progressData.requeuedTo
      });
    }
  };

  const onWaitProgressBySession = (sId) => (remainingMs, totalWaitMs) => {
    const st = getSessionState(sId);
    st.liveStatus = {
      ...(st.liveStatus || {}),
      phase: st.sendingPaused ? 'paused' : st.timePaused ? 'time_paused' : 'waiting',
      remainingMs,
      totalWaitMs
    };
    broadcastEvent('waitProgress', {
      sessionId: sId,
      remainingMs,
      totalWaitMs,
      phase: st.liveStatus.phase
    });
  };

  return { onProgress, onWaitProgressBySession };
}

async function runWhatsAppSendJob({
  finalCvsToSend,
  sessionIds,
  sessionWeights,
  skippedAlreadyContacted,
  mongoRecordHook,
  testMode,
  channel = 'auto',
  batchId = null
}) {
  const controlId = getBulkControlId(sessionIds);
  const N = sessionIds.length;
  const sendChannelRaw = String(channel || 'auto').toLowerCase();
  const sendChannel =
    sendChannelRaw === 'android' || sendChannelRaw === 'openwa' ? sendChannelRaw : 'auto';

  lastSendJob.inProgress = true;
  lastSendJob.total = finalCvsToSend.length;
  lastSendJob.successCount = 0;
  lastSendJob.completedCount = 0;
  lastSendJob.sessionIds = sessionIds;
  lastSendJob.startedAt = Date.now();
  lastSendJob.completedAt = null;
  lastSendJob.error = null;
  lastSendJob.message = null;
  lastSendJob.results = null;
  lastSendJob.skippedAlreadyContacted = skippedAlreadyContacted;
  lastSendJob.testMode = testMode;
  lastSendJob.channel = sendChannel;

  const trackMessageResult = (row) => {
    lastSendJob.completedCount = (lastSendJob.completedCount || 0) + 1;
    if (row && row.success) {
      lastSendJob.successCount = (lastSendJob.successCount || 0) + 1;
      broadcastEvent('sendSuccess', {
        successCount: lastSendJob.successCount,
        completedCount: lastSendJob.completedCount,
        total: lastSendJob.total,
        nombre: row.nombre,
        telefono: row.telefono,
        sessionId: row.sessionId || null,
        success: true
      });
    } else if (row) {
      broadcastEvent('sendSuccess', {
        successCount: lastSendJob.successCount || 0,
        completedCount: lastSendJob.completedCount,
        total: lastSendJob.total,
        nombre: row.nombre,
        telefono: row.telefono,
        sessionId: row.sessionId || null,
        success: false,
        error: row.error || null
      });
    }
    if (typeof mongoRecordHook === 'function') {
      try {
        mongoRecordHook(row);
      } catch (err) {
        console.warn('mongoRecordHook:', err.message);
      }
    }
  };

  try {
    if (testMode) {
      initSessionSendingState(controlId);
      for (const sId of sessionIds) {
        initSessionSendingState(sId);
      }

      const { onProgress } = buildSendProgressHandlers(controlId);
      const results = await simulateWhatsAppSending(finalCvsToSend, (progress) => {
        onProgress({
          readyToSend: true,
          current: progress.current,
          total: progress.total,
          nombre: progress.nombre,
          telefono: progress.telefono,
          sessionId: sessionIds[0],
          sessionCurrent: progress.current,
          sessionTotal: progress.total,
          phase: 'sending'
        });
        if (progress.result) {
          trackMessageResult({
            ...progress.result,
            sessionId: sessionIds[0]
          });
        }
      });

      resetBulkControlState(controlId, sessionIds);
      lastSendJob.results = results;
      lastSendJob.successCount = results.filter((r) => r.success).length;
      lastSendJob.message = `Envío completado: ${lastSendJob.successCount}/${results.length} mensajes enviados (modo prueba)`;
    } else if (sendChannel === 'android') {
      console.log(
        `📱 Envío Android (forzado) con ${N} sesión(es): ${sessionIds.join(', ')}`
      );
      initSessionSendingState(controlId);
      for (const sId of sessionIds) {
        initSessionSendingState(sId);
      }

      const results = await runAndroidSendJob({
        contacts: finalCvsToSend,
        sessionIds,
        batchId,
        onMessageResult: trackMessageResult,
        pollMs: 2000,
        timeoutMs: 24 * 60 * 60 * 1000
      });

      resetBulkControlState(controlId, sessionIds);
      lastSendJob.results = results;
      lastSendJob.successCount = results.filter((r) => r.success).length;
      lastSendJob.message = `Envío Android: ${lastSendJob.successCount}/${results.length} mensajes`;
    } else {
      // auto | openwa → respetar outreachChannel por línea (openwa forzado = todas openwa)
      const contactsToSend = finalCvsToSend.map((cv) => ({
        nombre: cv.nombre,
        telefono: cv.telefono,
        saludo: cv.saludo,
        mensajeIA: cv.mensajeIA,
        cvId: cv.cvId || null,
        archivoOriginal: cv.archivoOriginal || null
      }));

      const distribution = previewDistribution(
        sessionIds,
        sessionWeights,
        contactsToSend.length
      );
      const queues = buildQueuesFromCounts(sessionIds, contactsToSend, distribution.counts);
      const distributionLog = sessionIds.map((sId, i) => {
        const pct = Math.round(distribution.proportions[i] * 1000) / 10;
        return `${sId}: ${distribution.counts[i]} (${pct}%)`;
      });
      console.log(`📊 Distribución por cantidad → ${distributionLog.join(', ')}`);

      /** @type {Array<{ telefono: string, mensaje: string, deviceId: string, nombre?: string, logicalSessionId: string }>} */
      const androidAssignments = [];
      /** @type {string[]} */
      const openwaSessionIds = [];
      /** @type {Map<string, typeof contactsToSend>} */
      const openwaContactsBySession = new Map();

      for (const sId of sessionIds) {
        const session = sessionsStore.getSession(sId);
        const useAndroid =
          sendChannel === 'auto' &&
          session &&
          session.outreachChannel === 'android';
        const queue = (queues.get(sId) || []).map((row) => row.contact);

        if (useAndroid) {
          const deviceId = session.androidDeviceId;
          if (!deviceId) {
            throw new Error(
              `La línea "${session.label || sId}" tiene primer mensaje por Android pero no tiene celular vinculado.`
            );
          }
          const online = androidGatewayStore
            .pickOnlineDevices({ maxAgeMs: 3 * 60 * 1000 })
            .some((d) => d.id === deviceId);
          if (!online) {
            throw new Error(
              `El celular vinculado a "${session.label || sId}" no está online. Inicia WA Agent.`
            );
          }
          for (const c of queue) {
            androidAssignments.push({
              telefono: c.telefono,
              mensajeIA: c.mensajeIA,
              saludo: c.saludo,
              deviceId,
              nombre: c.nombre || null,
              logicalSessionId: sId,
              meta: {
                cvId: c.cvId || null,
                archivoOriginal: c.archivoOriginal || null,
                saludo: c.saludo || null,
                mensajeIA: c.mensajeIA || null
              }
            });
          }
        } else {
          openwaSessionIds.push(sId);
          openwaContactsBySession.set(sId, queue);
        }
      }

      console.log(
        `📡 Canales → Android: ${androidAssignments.length}, OpenWA: ${[...openwaContactsBySession.values()].reduce((n, a) => n + a.length, 0)}`
      );

      initSessionSendingState(controlId);
      for (const sId of sessionIds) {
        initSessionSendingState(sId);
      }

      const { onProgress, onWaitProgressBySession } = buildSendProgressHandlers(controlId);
      const checkControlsBySession = (sId) => makeSessionCheckControls(sId, controlId);

      const tasks = [];

      if (androidAssignments.length > 0) {
        tasks.push(
          runAndroidSendJob({
            assignments: androidAssignments,
            batchId,
            onMessageResult: trackMessageResult,
            pollMs: 2000,
            timeoutMs: 24 * 60 * 60 * 1000
          })
        );
      }

      if (openwaSessionIds.length > 0) {
        tasks.push(
          (async () => {
            const services = openwaSessionIds.map((sId) => {
              let svc = whatsappServices.get(sId);
              if (!svc) {
                svc = new WhatsAppService(sId);
                whatsappServices.set(sId, svc);
              }
              return svc;
            });
            for (const svc of services) {
              if (!svc.isReady()) await svc.initWhatsApp();
            }
            const servicesBySessionId = new Map(
              openwaSessionIds.map((sId, i) => [sId, services[i]])
            );

            // Aplanar contactos OpenWA en el orden de sesión (ya preasignados)
            const openwaFlat = [];
            for (const sId of openwaSessionIds) {
              openwaFlat.push(...(openwaContactsBySession.get(sId) || []));
            }

            if (openwaSessionIds.length === 1) {
              const singleCheck = makeSessionCheckControls(openwaSessionIds[0], null);
              const onWaitProgress = onWaitProgressBySession(openwaSessionIds[0]);
              return services[0].sendBulkMessages(
                openwaFlat,
                2,
                onProgress,
                singleCheck,
                trackMessageResult,
                onWaitProgress
              );
            }

            // Pesos exactos = tamaño de cola ya asignada por línea
            const openwaWeights = {};
            for (const sId of openwaSessionIds) {
              openwaWeights[sId] = (openwaContactsBySession.get(sId) || []).length;
            }
            return sendRoundRobinBulk(
              servicesBySessionId,
              openwaSessionIds,
              openwaFlat,
              onProgress,
              checkControlsBySession,
              trackMessageResult,
              onWaitProgressBySession,
              openwaWeights
            );
          })()
        );
      }

      let results = [];
      try {
        if (tasks.length === 0) {
          results = [];
        } else {
          const parts = await Promise.all(tasks);
          results = parts.flat();
        }
      } finally {
        resetBulkControlState(controlId, sessionIds);
      }

      lastSendJob.results = results;
      lastSendJob.completedCount = results.length;
      lastSendJob.successCount = results.filter((r) => r.success).length;
      lastSendJob.message = `Envío completado: ${lastSendJob.successCount}/${results.length} mensajes (por línea: Android/OpenWA)`;
    }

    lastSendJob.completedAt = Date.now();
    console.log(`Envío completado. ${lastSendJob.message}`);

    const workspaceCleanup = removeSuccessfullySentFromWorkspace(lastSendJob.results || []);

    // Marcar cola como sent ANTES de liberar inProgress / sendComplete,
    // para que la UI no refresque viendo aún "sending".
    markSendQueueJobFinished();
    try {
      sendQueueStore.clearTerminalBatches();
    } catch (err) {
      console.warn('clearTerminalBatches:', err.message);
    }

    broadcastEvent('cvsUpdated', {
      removed: workspaceCleanup.removed,
      remaining: workspaceCleanup.remaining,
      cvs: cvsData
    });
    broadcastEvent('sendQueueUpdated', sendQueueStore.getPublicState());

    broadcastEvent('sendComplete', {
      message: lastSendJob.message,
      total: finalCvsToSend.length,
      successCount: lastSendJob.successCount,
      completedCount: lastSendJob.completedCount,
      testMode,
      removedFromWorkspace: workspaceCleanup.removed,
      remainingInWorkspace: workspaceCleanup.remaining
    });
  } catch (error) {
    console.error('Error en envío en segundo plano:', error);
    lastSendJob.error = error.message;
    resetBulkControlState(controlId, sessionIds);
    markSendQueueJobFinished();
    broadcastEvent('sendError', { error: error.message });
  } finally {
    lastSendJob.inProgress = false;
  }
}

function getConfiguredSessionIds() {
  return sessionsStore.getLogicalSessionIds();
}

// Configuración de modo de prueba
const TEST_MODE = process.env.TEST_MODE === 'true';

function createMongoRecordHook() {
  return !TEST_MODE && contactHistory.mongoUriConfigured()
    ? (row) => {
        if (!row.success) return;
        const logicalSessionId = row.sessionId || null;
        let openwaSessionId = null;
        if (logicalSessionId) {
          try {
            openwaSessionId = sessionsStore.resolveOpenWASessionId(logicalSessionId);
          } catch {
            openwaSessionId = null;
          }
        }
        contactHistory
          .recordSuccessfulContact({
            normalizedPhone: contactHistory.normalizePhone(row.telefono),
            name: row.nombre,
            logicalSessionId,
            openwaSessionId,
            cvId: row.cvId || null,
            archivoOriginal: row.archivoOriginal || null
          })
          .catch((err) => console.error('contactHistory:', err.message));
      }
    : null;
}

function markSendQueueJobFinished() {
  const batch = sendQueueStore.getSendingBatch();
  if (!batch) return;
  try {
    sendQueueStore.markSent(batch.id);
    broadcastEvent('sendQueueFinished', { batchId: batch.id, status: 'sent' });
    broadcastEvent('sendQueueUpdated', sendQueueStore.getPublicState());
    armSendQueueTimer();
  } catch (err) {
    console.error('send-queue markSent:', err.message);
  }
}

function canControlSendQueueBatch(user, batch) {
  const sessionIds = Array.isArray(batch?.selectedSessions)
    ? batch.selectedSessions
    : [];
  return sessionIds.length === 0 || sessionIds.every((id) => canControlSession(user, id));
}

async function prepareCvsForSend(cvsFromClient) {
  let cvsToProcess = cvsData;
  if (cvsFromClient && Array.isArray(cvsFromClient)) {
    console.log('📝 Recibiendo CVs editados del cliente...');
    cvsToProcess = cvsFromClient;
    cvsToProcess.forEach((editedCv) => {
      const index = cvsData.findIndex(
        (cv) => cv.archivoOriginal === editedCv.archivoOriginal
      );
      if (index !== -1) {
        if (editedCv.saludo != null) cvsData[index].saludo = editedCv.saludo;
        cvsData[index].mensajeIA = editedCv.mensajeIA;
      }
    });
    persistCvsData();
  }

  if (cvsToProcess.length === 0) {
    return {
      error: 'No hay CVs procesados. Sube archivos PDF primero.',
      status: 400
    };
  }

  const cvsToSend = cvsToProcess.filter(
    (cv) =>
      cv.procesado &&
      !cv.alreadyContacted &&
      cv.mensajeIA &&
      cv.mensajeIA.trim() !== '' &&
      cv.telefono !== 'No encontrado'
  );

  if (cvsToSend.length === 0) {
    return {
      error: 'No hay CVs con mensajes de IA generados y números de teléfono válidos',
      status: 400
    };
  }

  const seenPhones = new Set();
  const uniqueCvsToSend = [];
  const duplicates = [];

  for (const cv of cvsToSend) {
    const phoneKey = cv.telefono.trim().toLowerCase();
    if (!seenPhones.has(phoneKey)) {
      seenPhones.add(phoneKey);
      uniqueCvsToSend.push(cv);
    } else {
      duplicates.push(cv);
    }
  }

  if (duplicates.length > 0) {
    console.log(
      `⚠️ Se encontraron ${duplicates.length} CVs duplicados (mismo teléfono). Se enviará solo un mensaje por número.`
    );
    duplicates.forEach((dup) => {
      console.log(
        `  - Duplicado: ${dup.nombre} (${dup.telefono}) - Archivo: ${dup.archivoOriginal}`
      );
    });
  }

  let skippedAlreadyContacted = [];
  let finalCvsToSend = uniqueCvsToSend;

  if (contactHistory.mongoUriConfigured()) {
    try {
      const filtered = await contactHistory.filterOutAlreadyContacted(uniqueCvsToSend);
      finalCvsToSend = filtered.toSend;
      skippedAlreadyContacted = filtered.skippedAlreadyContacted;
    } catch (err) {
      console.warn('⚠️ contactHistory: filtro omitido:', err.message);
    }
    if (skippedAlreadyContacted.length > 0) {
      console.log(
        `📇 ${skippedAlreadyContacted.length} contacto(s) ya en historial; no se reenvían.`
      );
    }
  }

  return { finalCvsToSend, skippedAlreadyContacted, duplicates };
}

async function dispatchQueuedBatch(_user, batchId = null) {
  if (isAnySendingInProgress() || sendQueueStore.getSendingBatch()) {
    const err = new Error('Ya hay un envío de mensajes en curso');
    err.status = 409;
    throw err;
  }

  const target =
    batchId != null
      ? sendQueueStore.getBatchById(batchId)
      : sendQueueStore.pickNextDispatchBatch();

  if (
    !target ||
    (target.status !== sendQueueStore.STATUS.QUEUED &&
      target.status !== sendQueueStore.STATUS.SCHEDULED)
  ) {
    const err = new Error('No hay lote pendiente para enviar');
    err.status = 409;
    throw err;
  }

  clearSendQueueTimer();
  const batch = sendQueueStore.markSending(target.id);
  const mongoRecordHook = createMongoRecordHook();
  const sessionIds = TEST_MODE
    ? batch.selectedSessions?.length
      ? batch.selectedSessions
      : ['default']
    : batch.selectedSessions;

  broadcastEvent('sendQueueStarted', { batchId: batch.id, total: batch.total });
  broadcastEvent('sendQueueUpdated', sendQueueStore.getPublicState());
  runWhatsAppSendJob({
    finalCvsToSend: batch.cvs,
    sessionIds,
    sessionWeights: batch.sessionWeights,
    skippedAlreadyContacted: [],
    mongoRecordHook,
    testMode: TEST_MODE,
    channel: batch.channel || 'auto',
    batchId: batch.id
  }).finally(() => {
    armSendQueueTimer();
  });

  return batch;
}

// Control de envíos en producción (por sesión)
class SessionState {
  constructor() {
    this.sendingInProgress = false;
    this.sendingPaused = false;
    this.sendingAborted = false;
    this.skipWait = false;
    this.timePaused = false;
    /** @type {{ phase: string, nombre?: string, telefono?: string, sessionCurrent?: number, sessionTotal?: number, remainingMs?: number, totalWaitMs?: number }|null} */
    this.liveStatus = null;
  }
}

const sessionStates = new Map(); // Map<sessionId, SessionState>

function getSessionState(sessionId) {
  if (!sessionStates.has(sessionId)) {
    sessionStates.set(sessionId, new SessionState());
  }
  return sessionStates.get(sessionId);
}

function getBulkControlId(sessionIds) {
  return sessionIds.length > 1 ? ROUND_ROBIN_CONTROL_ID : sessionIds[0];
}

function resetBulkControlState(controlId, sessionIds = []) {
  const resetOne = (id) => {
    const state = getSessionState(id);
    state.sendingInProgress = false;
    state.sendingPaused = false;
    state.sendingAborted = false;
    state.skipWait = false;
    state.timePaused = false;
    state.liveStatus = null;
  };

  if (controlId === ROUND_ROBIN_CONTROL_ID) {
    for (const sId of sessionIds) {
      resetOne(sId);
    }
  }
  resetOne(controlId);
}

function initSessionSendingState(sessionId) {
  const state = getSessionState(sessionId);
  state.sendingInProgress = true;
  state.sendingPaused = false;
  state.sendingAborted = false;
  state.skipWait = false;
  state.timePaused = false;
  state.liveStatus = { phase: 'starting' };
  return state;
}

function makeSessionCheckControls(sessionId, globalControlId) {
  return () => {
    const sessionState = getSessionState(sessionId);
    const globalState = globalControlId ? getSessionState(globalControlId) : null;

    const shouldSkipSession = sessionState.skipWait;
    if (shouldSkipSession) sessionState.skipWait = false;

    const shouldSkipGlobal = globalState?.skipWait;
    if (shouldSkipGlobal) globalState.skipWait = false;

    return {
      paused: sessionState.sendingPaused || Boolean(globalState?.sendingPaused),
      aborted: sessionState.sendingAborted || Boolean(globalState?.sendingAborted),
      skipWait: shouldSkipSession || Boolean(shouldSkipGlobal),
      timePaused: sessionState.timePaused || Boolean(globalState?.timePaused)
    };
  };
}

function abortAllActiveSessions() {
  for (const [, state] of sessionStates) {
    if (state.sendingInProgress) {
      state.sendingAborted = true;
      state.sendingPaused = false;
      state.timePaused = false;
    }
  }
}

// Event emitters para notificaciones en tiempo real (Server-Sent Events)
const eventClients = [];
/** @type {ReturnType<typeof setInterval>|null} */
let sseHeartbeatTimer = null;

function ensureSseHeartbeat() {
  if (sseHeartbeatTimer) return;
  sseHeartbeatTimer = setInterval(() => {
    if (eventClients.length === 0) return;
    for (let i = eventClients.length - 1; i >= 0; i--) {
      const client = eventClients[i];
      try {
        client.write(`: ping ${Date.now()}\n\n`);
      } catch {
        eventClients.splice(i, 1);
      }
    }
  }, 20000);
}

// Función para enviar evento a todos los clientes conectados
function broadcastEvent(event, data) {
  eventClients.forEach(client => {
    try {
      client.write(`event: ${event}\n`);
      client.write(`data: ${JSON.stringify(data)}\n\n`);
    } catch (error) {
      // Si el cliente se desconectó, removerlo de la lista
      const index = eventClients.indexOf(client);
      if (index > -1) {
        eventClients.splice(index, 1);
      }
    }
  });
}

/**
 * Simula el envío de mensajes de WhatsApp para modo de prueba
 * @param {Array} cvsToSend - Array de CVs a enviar
 * @param {Function} onProgress - Callback para reportar progreso (opcional)
 * @returns {Promise<Array>} - Resultados simulados
 */
async function simulateWhatsAppSending(cvsToSend, onProgress = null) {
  console.log('🧪 MODO PRUEBA: Simulando envío de mensajes...');

  const results = [];
  const delaySeconds = 2; // En modo prueba, delay más corto para testing

  for (let i = 0; i < cvsToSend.length; i++) {
    const cv = cvsToSend[i];

    // Mostrar el mensaje que se está enviando
    const mensajePreview = cv.mensajeIA.length > 100
      ? cv.mensajeIA.substring(0, 100) + '...'
      : cv.mensajeIA;

    console.log(`🧪 Simulando envío ${i + 1}/${cvsToSend.length} a ${cv.nombre} (${cv.telefono})`);
    const parts = buildOutboundMessageParts(cv);
    console.log(`🧪 Burst: ${parts.length} mensaje${parts.length === 1 ? '' : 's'}`);
    parts.forEach((part, idx) => {
      const preview =
        part.length > 100 ? `${part.substring(0, 100).replace(/\n/g, ' ')}...` : part;
      console.log(`🧪   ${idx + 1}/${parts.length}: ${preview}`);
    });
    console.log(`📱 Mensaje base (preview): ${mensajePreview}`);
    console.log('🧪 Simulando pausas cortas entre fragmentos del burst...');

    // Simular éxito en 90% de los casos
    const success = Math.random() > 0.1;

    const result = {
      index: i,
      nombre: cv.nombre,
      telefono: cv.telefono,
      saludo: cv.saludo,
      mensajeIA: cv.mensajeIA,
      cvId: cv.cvId || null,
      archivoOriginal: cv.archivoOriginal || null,
      success: success,
      timestamp: new Date().toISOString(),
      testMode: true
    };

    results.push(result);

    // Reportar progreso si hay callback
    if (onProgress) {
      onProgress({
        current: i + 1,
        total: cvsToSend.length,
        nombre: cv.nombre,
        telefono: cv.telefono,
        saludo: cv.saludo,
        mensajeIA: cv.mensajeIA,
        success: success,
        result
      });
    }

    // Delay más corto en modo prueba
    if (i < cvsToSend.length - 1) {
      console.log(`🧪 Esperando ${delaySeconds} segundos antes del siguiente mensaje...`);
      await new Promise(resolve => setTimeout(resolve, delaySeconds * 1000));
    }
  }

  console.log('🧪 Simulación completada');
  return results;
}

// --- Autenticación (credenciales en .env) ---

app.get('/login', (req, res) => {
  if (isAuthEnabled() && isAuthenticated(req)) {
    return res.redirect('/');
  }
  res.sendFile(path.join(__dirname, 'public', 'login.html'));
});

app.post('/api/auth/login', (req, res) => {
  if (!isAuthEnabled()) {
    return res.status(503).json({
      success: false,
      error: 'Autenticación no configurada. Define AUTH_USERNAME y AUTH_PASSWORD en .env'
    });
  }

  const username = String(req.body.username || '').trim();
  const password = String(req.body.password || '');
  const result = validateCredentials(username, password);

  if (!result.ok) {
    return res.status(401).json({ success: false, error: 'Usuario o contraseña incorrectos' });
  }

  setAuthCookie(
    res,
    createSessionToken({
      username: result.user.username,
      role: result.user.role
    })
  );
  res.json({
    success: true,
    user: {
      username: result.user.username,
      role: result.user.role,
      isSuper: result.user.isSuper,
      permissions: result.user.permissions || {},
      gerenteEmail: result.user.gerenteEmail || ''
    }
  });
});

app.post('/api/auth/logout', (req, res) => {
  clearAuthCookie(res);
  res.json({ success: true });
});

app.get('/api/auth/status', (req, res) => {
  const user = isAuthenticated(req) ? getRequestUser(req) : null;
  res.json({
    success: true,
    authEnabled: isAuthEnabled(),
    authenticated: Boolean(user),
    user: user
      ? {
          username: user.username,
          role: user.role,
          isSuper: user.isSuper,
          permissions: user.permissions || {},
          gerenteEmail: user.gerenteEmail || ''
        }
      : null
  });
});

/** Perfil del usuario logueado: correo de gerente para Panel */
app.get('/api/me', (req, res) => {
  const user = req.user || getRequestUser(req);
  if (!user) {
    return res.status(401).json({ success: false, error: 'No autenticado' });
  }
  res.json({
    success: true,
    user: {
      username: user.username,
      role: user.role,
      isSuper: user.isSuper,
      gerenteEmail: user.gerenteEmail || '',
      envGerenteEmail: panelMsgClient.defaultGerenteEmail() || ''
    }
  });
});

app.put('/api/me', (req, res) => {
  try {
    const user = req.user || getRequestUser(req);
    if (!user) {
      return res.status(401).json({ success: false, error: 'No autenticado' });
    }

    const gerenteEmail = usersStore.sanitizeGerenteEmail(req.body?.gerenteEmail);

    if (user.isSuper) {
      usersStore.setSuperGerenteEmail(gerenteEmail);
    } else if (user.id) {
      usersStore.updateUser(user.id, { gerenteEmail });
    } else {
      return res.status(400).json({ success: false, error: 'No se pudo actualizar el perfil' });
    }

    const refreshed = getRequestUser(req);
    res.json({
      success: true,
      user: {
        username: refreshed?.username || user.username,
        role: refreshed?.role || user.role,
        isSuper: Boolean(refreshed?.isSuper ?? user.isSuper),
        gerenteEmail: refreshed?.gerenteEmail || gerenteEmail
      }
    });
  } catch (error) {
    res.status(400).json({ success: false, error: error.message });
  }
});

app.use(authMiddleware);

// --- Gestión de usuarios (solo superusuario del .env) ---

app.get('/api/users', requireSuper, (req, res) => {
  try {
    res.json({ success: true, users: usersStore.getAllUsers() });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

app.post('/api/users', requireSuper, (req, res) => {
  try {
    const user = usersStore.createUser({
      username: req.body.username,
      password: req.body.password,
      permissions: req.body.permissions,
      gerenteEmail: req.body.gerenteEmail
    });
    res.status(201).json({ success: true, user });
  } catch (error) {
    res.status(400).json({ success: false, error: error.message });
  }
});

app.put('/api/users/:id', requireSuper, (req, res) => {
  try {
    const patch = {};
    if (req.body.password != null && String(req.body.password).length > 0) {
      patch.password = req.body.password;
    }
    if (req.body.permissions != null) {
      patch.permissions = req.body.permissions;
    }
    if (Object.prototype.hasOwnProperty.call(req.body || {}, 'gerenteEmail')) {
      patch.gerenteEmail = req.body.gerenteEmail;
    }
    const user = usersStore.updateUser(req.params.id, patch);
    res.json({ success: true, user });
  } catch (error) {
    res.status(400).json({ success: false, error: error.message });
  }
});

app.delete('/api/users/:id', requireSuper, (req, res) => {
  try {
    usersStore.deleteUser(req.params.id);
    res.json({ success: true, message: 'Usuario eliminado' });
  } catch (error) {
    res.status(400).json({ success: false, error: error.message });
  }
});

// Ruta principal - servir la interfaz web
app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// Ruta para subir y procesar CVs
app.post('/upload-cvs', upload.array('cvs', 100), async (req, res) => {
  try {
    if (!req.files || req.files.length === 0) {
      return res.status(400).json({
        error: 'No se subieron archivos PDF'
      });
    }

    console.log(`Procesando ${req.files.length} archivos PDF...`);

    // Limpiar datos y archivos anteriores
    cvsData = [];
    cvFileStore.clearAllCvs();

    // Procesar cada archivo PDF
    for (let i = 0; i < req.files.length; i++) {
      const file = req.files[i];
      console.log(`Procesando archivo ${i + 1}/${req.files.length}: ${file.originalname}`);

      try {
        const saved = cvFileStore.saveCvFile(file.buffer, file.originalname);

        // Extraer texto del PDF
        const text = await extractTextFromPDF(file.buffer);

        // Extraer datos estructurados
        const cvData = extractCVData(text);

        // Agregar información del archivo
        const processedCV = {
          ...cvData,
          archivoOriginal: file.originalname,
          cvId: saved.cvId,
          cvFileName: saved.cvFileName,
          saludo: '',
          mensajeIA: '', // Se llenará después
          alreadyContacted: false,
          contactedAt: null,
          procesado: true,
          savedAt: new Date().toISOString()
        };

        cvsData.push(processedCV);

      } catch (error) {
        console.error(`Error procesando ${file.originalname}:`, error.message);
        cvsData.push({
          nombre: 'Error al procesar',
          telefono: 'N/A',
          experiencia: 'Error al extraer texto del PDF',
          archivoOriginal: file.originalname,
          cvId: null,
          cvFileName: null,
          saludo: '',
          mensajeIA: '',
          alreadyContacted: false,
          contactedAt: null,
          procesado: false,
          error: error.message
        });
      }
    }

    // Verificar historial antes de generar IA / mostrar en UI
    let alreadyContactedCount = 0;
    if (contactHistory.mongoUriConfigured()) {
      try {
        cvsData = await contactHistory.annotateAlreadyContacted(cvsData);
        alreadyContactedCount = cvsData.filter((cv) => cv.alreadyContacted).length;
        if (alreadyContactedCount > 0) {
          console.log(
            `📇 ${alreadyContactedCount} CV(s) ya contactados (no se generará IA ni se enviarán).`
          );
        }
      } catch (err) {
        console.warn('⚠️ contactHistory annotate en upload omitido:', err.message);
      }
    }

    persistCvsData();
    console.log(`Procesamiento completado. ${cvsData.length} CVs procesados (persistidos en disco).`);

    res.json({
      success: true,
      message: `Se procesaron ${cvsData.length} CVs exitosamente`,
      alreadyContactedCount,
      cvs: cvsData
    });

  } catch (error) {
    console.error('Error en upload-cvs:', error);
    res.status(500).json({
      error: 'Error interno del servidor',
      message: error.message
    });
  }
});

// Ruta para generar mensajes con IA (responde al instante; el trabajo sigue en segundo plano)
app.post('/generate-messages', async (req, res) => {
  try {
    if (generationState.inProgress) {
      return res.status(409).json({
        error: 'Ya hay una generación de mensajes en curso',
        generation: generationState
      });
    }

    if (cvsData.length === 0) {
      return res.status(400).json({
        error: 'No hay CVs procesados. Sube archivos PDF primero.'
      });
    }

    // Revalidar historial por si hubo contactos entre upload y generate
    if (contactHistory.mongoUriConfigured()) {
      try {
        cvsData = await contactHistory.annotateAlreadyContacted(cvsData);
        persistCvsData();
      } catch (err) {
        console.warn('⚠️ contactHistory annotate en generate omitido:', err.message);
      }
    }

    const alreadySkipped = cvsData.filter(
      (cv) => cv.procesado && cv.nombre !== 'Error al procesar' && cv.alreadyContacted
    );
    const validCVs = cvsData.filter(
      (cv) =>
        cv.procesado &&
        cv.nombre !== 'Error al procesar' &&
        !cv.alreadyContacted
    );

    if (alreadySkipped.length > 0) {
      console.log(
        `📇 Generación: se omiten ${alreadySkipped.length} CV(s) ya contactados.`
      );
    }

    if (validCVs.length === 0) {
      return res.status(400).json({
        error:
          alreadySkipped.length > 0
            ? 'Todos los CVs válidos ya fueron contactados; no hay mensajes de IA que generar.'
            : 'No hay CVs válidos para generar mensajes',
        alreadyContactedCount: alreadySkipped.length,
        cvs: cvsData
      });
    }

    console.log(`Iniciando generación de IA para ${validCVs.length} CVs (en segundo plano)...`);

    generationState = {
      inProgress: true,
      current: 0,
      total: validCVs.length,
      nombre: null,
      error: null,
      completedAt: null
    };

    res.status(202).json({
      success: true,
      started: true,
      total: validCVs.length,
      alreadyContactedCount: alreadySkipped.length,
      cvs: cvsData,
      message: `Generación iniciada para ${validCVs.length} CVs` +
        (alreadySkipped.length > 0
          ? ` (${alreadySkipped.length} ya contactados omitidos)`
          : '')
    });

    (async () => {
      try {
        const cvsWithMessages = await generateBulkMessages(validCVs, (progress) => {
          generationState.current = progress.current;
          generationState.nombre = progress.nombre;
          broadcastEvent('generationProgress', progress);
        });

        cvsWithMessages.forEach(cvWithMessage => {
          const index = cvsData.findIndex(cv => cv.archivoOriginal === cvWithMessage.archivoOriginal);
          if (index !== -1) {
            cvsData[index].saludo = cvWithMessage.saludo;
            cvsData[index].mensajeIA = cvWithMessage.mensajeIA;
          }
        });

        persistCvsData();
        console.log(`Mensajes generados exitosamente para ${cvsWithMessages.length} CVs`);

        generationState.inProgress = false;
        generationState.completedAt = Date.now();
        generationState.current = validCVs.length;

        broadcastEvent('generationComplete', {
          total: cvsWithMessages.length,
          alreadyContactedCount: alreadySkipped.length,
          cvs: cvsData,
          message: `Se generaron mensajes de IA para ${cvsWithMessages.length} CVs`
        });
      } catch (error) {
        console.error('Error generando mensajes:', error);
        generationState.inProgress = false;
        generationState.error = error.message;
        broadcastEvent('generationError', { error: error.message });
      }
    })();
  } catch (error) {
    console.error('Error iniciando generación de mensajes:', error);
    generationState.inProgress = false;
    res.status(500).json({
      error: 'Error generando mensajes con IA',
      message: error.message
    });
  }
});

// Estado de la generación de mensajes (para polling desde el cliente)
app.get('/generation-status', (req, res) => {
  res.json({
    success: true,
    ...generationState
  });
});

// Ruta para obtener el estado actual de los CVs
app.get('/cvs-status', (req, res) => {
  res.json({
    success: true,
    cvs: cvsData
  });
});

/**
 * Actualiza el teléfono de un CV, revalida historial y limpia IA si ya fue contactado.
 * Body: { index?: number, archivoOriginal?: string, telefono: string }
 */
app.post('/cvs/update-phone', async (req, res) => {
  try {
    const telefono = req.body?.telefono != null ? String(req.body.telefono).trim() : '';
    if (!telefono) {
      return res.status(400).json({ error: 'Teléfono requerido' });
    }

    let index = Number.isInteger(req.body?.index) ? req.body.index : parseInt(req.body?.index, 10);
    if (!Number.isInteger(index) || index < 0 || index >= cvsData.length) {
      const archivo = req.body?.archivoOriginal;
      if (archivo) {
        index = cvsData.findIndex((cv) => cv.archivoOriginal === archivo);
      } else {
        index = -1;
      }
    }

    if (index < 0 || index >= cvsData.length) {
      return res.status(404).json({ error: 'CV no encontrado' });
    }

    const status = await contactHistory.lookupContactStatus(telefono);
    const cv = cvsData[index];
    cv.telefono = telefono;
    cv.alreadyContacted = Boolean(status.alreadyContacted);
    cv.contactedAt = status.contactedAt || null;

    if (cv.alreadyContacted) {
      cv.saludo = '';
      cv.mensajeIA = '';
    }

    persistCvsData();

    console.log(
      cv.alreadyContacted
        ? `📇 Teléfono ${telefono} ya en historial (${cv.nombre || cv.archivoOriginal})`
        : `📇 Teléfono ${telefono} libre para contactar (${cv.nombre || cv.archivoOriginal})`
    );

    res.json({
      success: true,
      cv,
      alreadyContacted: cv.alreadyContacted,
      contactedAt: cv.contactedAt,
      cvs: cvsData
    });
  } catch (error) {
    console.error('Error en /cvs/update-phone:', error);
    res.status(500).json({
      error: 'Error actualizando teléfono',
      message: error.message
    });
  }
});

// Ruta para obtener configuración del sistema
app.get('/config', (req, res) => {
  const sessions = filterSessionsForUser(req.user, sessionsStore.getAllSessions());
  const current = req.user || getRequestUser(req);
  const userGerente = (current && current.gerenteEmail) || '';
  const envGerente = panelMsgClient.defaultGerenteEmail() || '';
  res.json({
    success: true,
    testMode: TEST_MODE,
    whatsappProvider: 'openwa',
    sessions,
    user: current
      ? {
          username: current.username,
          role: current.role,
          isSuper: current.isSuper,
          permissions: current.permissions || {},
          gerenteEmail: current.gerenteEmail || ''
        }
      : null,
    autoReply: autoReplyService.getStatus(),
    panel: {
      configured: panelMsgClient.isConfigured(),
      publicCvUrlConfigured: cvFileStore.isPublicUrlConfigured(),
      gerenteEmail: userGerente || envGerente,
      envGerenteEmail: envGerente,
      baseUrl: panelMsgClient.panelBaseUrl()
    },
    message: TEST_MODE
      ? 'Sistema en modo de prueba - los mensajes se simularán'
      : 'Sistema en modo producción - se enviarán mensajes reales vía OpenWA'
  });
});

// CV público firmado (panel descarga sin sesión Msg)
app.get('/api/public/cv/:cvId', (req, res) => {
  try {
    const cvId = String(req.params.cvId || '').trim();
    const token = String(req.query.token || '').trim();
    if (!cvId || !token) {
      return res.status(400).json({ success: false, error: 'cvId y token son obligatorios' });
    }
    if (!cvFileStore.verifySignedToken(cvId, token)) {
      return res.status(401).json({ success: false, error: 'Token inválido o expirado' });
    }
    const meta = cvFileStore.getCvFileMeta(cvId);
    if (!meta) {
      return res.status(404).json({ success: false, error: 'CV no encontrado' });
    }
    res.setHeader('Content-Type', meta.mime);
    res.setHeader('Content-Disposition', `inline; filename="${meta.fileName}"`);
    return res.sendFile(meta.filePath);
  } catch (error) {
    console.error('[public/cv] Error:', error);
    return res.status(500).json({ success: false, error: error.message });
  }
});

// Resolver CV del lead por teléfono (para agendar desde chat)
app.get('/api/panel/cv-by-phone', async (req, res) => {
  try {
    const phone = contactHistory.normalizePhone(req.query.phone || req.query.telefono || '');
    if (!phone) {
      return res.status(400).json({ success: false, error: 'phone es obligatorio' });
    }

    let linkedCvId = null;
    if (contactHistory.mongoUriConfigured()) {
      const doc = await contactHistory.getContactByPhone(phone);
      if (doc && doc.cvId) linkedCvId = doc.cvId;
    }

    const matched = findCvForPhone(phone, { cvId: linkedCvId });
    if (!matched) {
      return res.json({
        success: true,
        found: false,
        telefono: phone,
        linkedCvId,
        cv: null
      });
    }

    return res.json({
      success: true,
      found: true,
      telefono: phone,
      linkedCvId,
      matchSource: linkedCvId && matched.cvId === linkedCvId ? 'historial' : 'telefono',
      cv: publicCvSummary(matched)
    });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

// Proxy autenticado → panel disponibilidad
app.get('/api/panel/disponibilidad', async (req, res) => {
  try {
    if (!panelMsgClient.isConfigured()) {
      return res.status(503).json({
        success: false,
        error:
          'Integración con panel no configurada. Define MSG_INTEGRATION_API_KEY en .env'
      });
    }
    const data = await panelMsgClient.getDisponibilidad({
      gerenteEmail:
        req.query.gerenteEmail ||
        (req.user && req.user.gerenteEmail) ||
        panelMsgClient.defaultGerenteEmail(),
      fechaInicio: req.query.fechaInicio,
      fechaFin: req.query.fechaFin,
      slotMinutos: req.query.slotMinutos ? Number(req.query.slotMinutos) : undefined
    });
    return res.json({ success: true, ...data });
  } catch (error) {
    const status = error.status || 502;
    return res.status(status).json({
      success: false,
      error: error.message,
      ...(error.panelBody && typeof error.panelBody === 'object' ? { panel: error.panelBody } : {})
    });
  }
});

// Agenda IA: slots agregados de todos los gerentes
app.get('/api/agenda/slots', async (req, res) => {
  try {
    if (!forbidUnlessAnyControl(req, res)) return;
    if (!panelMsgClient.isConfigured()) {
      return res.status(503).json({
        success: false,
        error:
          'Integración con panel no configurada. Define MSG_INTEGRATION_API_KEY en .env'
      });
    }
    const includeCandidates = String(req.query.includeCandidates || '') === '1';
    const aggregated = await agendaAvailability.getAggregatedSlots({
      fechaInicio: req.query.fechaInicio,
      fechaFin: req.query.fechaFin,
      slotMinutos: req.query.slotMinutos ? Number(req.query.slotMinutos) : undefined
    });
    const limit = req.query.limit ? Number(req.query.limit) : 40;
    const slots = includeCandidates
      ? (aggregated.slots || []).slice(0, limit)
      : agendaAvailability.publicSlots(aggregated.slots, limit);
    return res.json({
      success: true,
      slots,
      gerentesConsultados: aggregated.gerentesConsultados,
      erroresGerente: aggregated.erroresGerente || []
    });
  } catch (error) {
    const status = error.status || 502;
    return res.status(status).json({ success: false, error: error.message });
  }
});

app.get('/api/agenda/pending', (req, res) => {
  try {
    if (!forbidUnlessAnyControl(req, res)) return;
    const statusFilter = req.query.status
      ? String(req.query.status).split(',').map((s) => s.trim()).filter(Boolean)
      : [agendaPendingStore.STATUS.PENDING_LINK];
    const items = agendaPendingStore.listPending({ status: statusFilter });
    const user = req.user || getRequestUser(req);
    const isSuper = user && (user.isSuper || user.role === 'super');
    const filtered = isSuper
      ? items
      : items.filter((item) => {
          if (!item.logicalSessionId) return true;
          return canControlSession(user, item.logicalSessionId);
        });
    return res.json({ success: true, items: filtered });
  } catch (error) {
    return res.status(500).json({ success: false, error: error.message });
  }
});

app.post('/api/agenda/pending', (req, res) => {
  try {
    if (!forbidUnlessAnyControl(req, res)) return;
    const body = req.body || {};
    const fecha = String(body.fecha || '').trim();
    const horaInicio = String(body.horaInicio || '').trim();
    const horaFin = String(body.horaFin || '').trim();
    const telefono = String(body.telefono || '').trim();
    const cvId = String(body.cvId || '').trim();
    if (!fecha || !horaInicio || !horaFin || !telefono || !cvId) {
      return res.status(400).json({
        success: false,
        error: 'Faltan campos',
        required: ['fecha', 'horaInicio', 'horaFin', 'telefono', 'cvId']
      });
    }
    const item = agendaPendingStore.createPending({
      telefono,
      chatId: body.chatId || null,
      contactName: body.contactName || null,
      cvId,
      fecha,
      horaInicio,
      horaFin,
      label: body.label || null,
      logicalSessionId: body.logicalSessionId || null,
      openwaSessionId: body.openwaSessionId || null,
      candidateVendors: body.candidateVendors || []
    });
    broadcastEvent('agendaPending', item);
    return res.status(201).json({ success: true, item });
  } catch (error) {
    const status = error.status || 500;
    return res.status(status).json({
      success: false,
      error: error.message,
      ...(error.code ? { code: error.code } : {})
    });
  }
});

app.post('/api/agenda/pending/:id/confirm', async (req, res) => {
  try {
    if (!forbidUnlessAnyControl(req, res)) return;
    const pending = agendaPendingStore.getById(req.params.id);
    if (!pending) {
      return res.status(404).json({ success: false, error: 'Cita pendiente no encontrada' });
    }
    if (pending.status !== agendaPendingStore.STATUS.PENDING_LINK) {
      return res.status(409).json({
        success: false,
        error: `La cita ya está en estado ${pending.status}`
      });
    }

    const user = req.user || getRequestUser(req);
    if (
      pending.logicalSessionId &&
      !(user && (user.isSuper || user.role === 'super')) &&
      !canControlSession(user, pending.logicalSessionId)
    ) {
      return res.status(403).json({ success: false, error: 'Sin control sobre esa línea' });
    }

    if (!panelMsgClient.isConfigured()) {
      return res.status(503).json({
        success: false,
        error: 'Integración con panel no configurada'
      });
    }
    if (!cvFileStore.isPublicUrlConfigured()) {
      return res.status(503).json({
        success: false,
        error: 'WEBHOOK_PUBLIC_URL no está configurada para cvUrl pública'
      });
    }

    const body = req.body || {};
    const vendedorId = String(body.vendedorId || '').trim();
    const urlReunion = String(body.urlReunion || '').trim();
    let gerenteEmail = String(body.gerenteEmail || '').trim().toLowerCase();

    if (!vendedorId || !urlReunion) {
      return res.status(400).json({
        success: false,
        error: 'vendedorId y urlReunion son obligatorios'
      });
    }

    if (!gerenteEmail && Array.isArray(pending.candidateVendors)) {
      const match = pending.candidateVendors.find((c) => c.vendedorId === vendedorId);
      if (match) gerenteEmail = match.gerenteEmail;
    }
    if (!gerenteEmail) {
      gerenteEmail =
        (user && user.gerenteEmail) || panelMsgClient.defaultGerenteEmail() || '';
    }
    if (!gerenteEmail) {
      return res.status(400).json({
        success: false,
        error: 'Falta gerenteEmail para crear la reunión en el panel'
      });
    }

    const cvId = String(pending.cvId || '').trim();
    if (!cvFileStore.getCvFileMeta(cvId)) {
      return res.status(404).json({
        success: false,
        error: 'Archivo del CV no está disponible'
      });
    }
    const cvUrl = cvFileStore.buildCvPublicUrl(cvId);
    const cv = cvsData.find((c) => c.cvId === cvId) || null;

    const panelData = await panelMsgClient.crearReunion({
      gerenteEmail,
      vendedorId,
      fecha: pending.fecha,
      horaInicio: pending.horaInicio,
      horaFin: pending.horaFin,
      urlReunion,
      cvUrl,
      titulo: `Sesión — ${pending.contactName || cv?.nombre || 'candidato'}`,
      leadNombre: pending.contactName || cv?.nombre,
      leadTelefono: pending.telefono,
      origen: 'msg_agenda_pending'
    });

    const panelReunionId =
      (panelData && (panelData.id || panelData.reunionId || panelData.reunion?.id)) || null;

    const confirmed = agendaPendingStore.confirmPending(pending.id, {
      vendedorId,
      urlReunion,
      gerenteEmail,
      panelReunionId
    });

    let whatsapp = { sent: false };
    const openwaSessionId = pending.openwaSessionId;
    const chatId =
      pending.chatId ||
      (pending.telefono ? formatPhoneToChatId(pending.telefono) : null);
    if (openwaSessionId && chatId) {
      const senderName = pending.logicalSessionId
        ? sessionsStore.getSessionSenderName(pending.logicalSessionId)
        : 'Pro Talent';
      const text = autoReplyService.buildConfirmedMeetingReply({
        contactName: pending.contactName,
        fecha: pending.fecha,
        horaInicio: pending.horaInicio,
        urlReunion,
        senderName
      });
      try {
        const result = await sendTextMessage(openwaSessionId, chatId, text);
        whatsapp = { sent: true, messageId: result.messageId || null };
      } catch (waErr) {
        whatsapp = { sent: false, error: waErr.message };
        console.warn('[agenda] confirm WhatsApp failed:', waErr.message);
      }
    } else {
      whatsapp = { sent: false, error: 'Sin openwaSessionId/chatId para notificar' };
    }

    broadcastEvent('agendaPendingConfirmed', confirmed);
    return res.json({
      success: true,
      item: confirmed,
      panel: panelData,
      whatsapp
    });
  } catch (error) {
    const status = error.status || 502;
    return res.status(status).json({
      success: false,
      error: error.message,
      ...(error.panelBody && typeof error.panelBody === 'object' ? { panel: error.panelBody } : {})
    });
  }
});

app.post('/api/agenda/pending/:id/cancel', (req, res) => {
  try {
    if (!forbidUnlessAnyControl(req, res)) return;
    const pending = agendaPendingStore.getById(req.params.id);
    if (!pending) {
      return res.status(404).json({ success: false, error: 'Cita pendiente no encontrada' });
    }
    const user = req.user || getRequestUser(req);
    if (
      pending.logicalSessionId &&
      !(user && (user.isSuper || user.role === 'super')) &&
      !canControlSession(user, pending.logicalSessionId)
    ) {
      return res.status(403).json({ success: false, error: 'Sin control sobre esa línea' });
    }
    const item = agendaPendingStore.cancelPending(pending.id);
    broadcastEvent('agendaPendingCancelled', item);
    return res.json({ success: true, item });
  } catch (error) {
    const status = error.status || 500;
    return res.status(status).json({ success: false, error: error.message });
  }
});

// Subir un solo CV para agendar (p. ej. desde conversaciones) sin limpiar el lote actual
app.post('/api/panel/cv-upload', upload.single('cv'), async (req, res) => {
  try {
    if (!req.file) {
      return res.status(400).json({ success: false, error: 'Sube un archivo PDF' });
    }

    const saved = cvFileStore.saveCvFile(req.file.buffer, req.file.originalname);
    let cvData = {
      nombre: 'Candidato',
      telefono: String(req.body.telefono || '').trim() || 'No encontrado',
      experiencia: '',
      textoCompleto: '',
      procesado: true
    };

    try {
      const text = await extractTextFromPDF(req.file.buffer);
      cvData = { ...extractCVData(text), procesado: true };
      if (req.body.telefono) {
        cvData.telefono = String(req.body.telefono).trim();
      }
      if (req.body.nombre && String(req.body.nombre).trim()) {
        cvData.nombre = String(req.body.nombre).trim();
      }
    } catch (parseErr) {
      console.warn('[panel/cv-upload] parse parcial:', parseErr.message);
      if (req.body.nombre) cvData.nombre = String(req.body.nombre).trim();
    }

    const entry = {
      ...cvData,
      archivoOriginal: req.file.originalname,
      cvId: saved.cvId,
      cvFileName: saved.cvFileName,
      saludo: '',
      mensajeIA: '',
      procesado: true,
      fromConversation: true,
      savedAt: new Date().toISOString()
    };

    // Actualizar si ya hay uno con mismo teléfono; si no, agregar
    const norm = contactHistory.normalizePhone(entry.telefono);
    if (norm) {
      const idx = cvsData.findIndex(
        (c) => contactHistory.normalizePhone(c.telefono) === norm && c.cvId
      );
      if (idx >= 0) {
        cvsData[idx] = { ...cvsData[idx], ...entry };
      } else {
        cvsData.push(entry);
      }
    } else {
      cvsData.push(entry);
    }

    persistCvsData();

    res.json({
      success: true,
      cvId: saved.cvId,
      cv: {
        cvId: entry.cvId,
        nombre: entry.nombre,
        telefono: entry.telefono,
        archivoOriginal: entry.archivoOriginal
      }
    });
  } catch (error) {
    console.error('[panel/cv-upload]', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

// Proxy autenticado → crear reunión en panel
app.post('/api/panel/reuniones', async (req, res) => {
  try {
    if (!panelMsgClient.isConfigured()) {
      return res.status(503).json({
        success: false,
        error:
          'Integración con panel no configurada. Define MSG_INTEGRATION_API_KEY en .env'
      });
    }
    if (!cvFileStore.isPublicUrlConfigured()) {
      return res.status(503).json({
        success: false,
        error:
          'WEBHOOK_PUBLIC_URL no está configurada. El panel necesita una URL pública para descargar el CV.'
      });
    }

    const body = req.body || {};
    const cvId = String(body.cvId || '').trim();
    const {
      vendedorId,
      fecha,
      horaInicio,
      horaFin,
      urlReunion,
      gerenteEmail,
      titulo,
      leadCorreo,
      leadNombre,
      leadTelefono,
      leadCiudad,
      leadEstado
    } = body;

    if (!cvId || !vendedorId || !fecha || !horaInicio || !horaFin || !urlReunion) {
      return res.status(400).json({
        success: false,
        error: 'Faltan campos obligatorios',
        required: ['cvId', 'vendedorId', 'fecha', 'horaInicio', 'horaFin', 'urlReunion']
      });
    }

    const cv = cvsData.find((c) => c.cvId === cvId) || null;
    if (!cvFileStore.getCvFileMeta(cvId)) {
      return res.status(404).json({
        success: false,
        error: 'Archivo del CV no está disponible. Sube el PDF e inténtalo de nuevo.'
      });
    }

    const cvUrl = cvFileStore.buildCvPublicUrl(cvId);
    if (!cvUrl) {
      return res.status(503).json({
        success: false,
        error: 'No se pudo construir cvUrl pública'
      });
    }

    const resolvedGerente =
      String(gerenteEmail || '').trim() ||
      (req.user && req.user.gerenteEmail) ||
      panelMsgClient.defaultGerenteEmail();

    const data = await panelMsgClient.crearReunion({
      gerenteEmail: resolvedGerente,
      vendedorId,
      fecha,
      horaInicio,
      horaFin,
      urlReunion: String(urlReunion).trim(),
      cvUrl,
      titulo:
        titulo ||
        `Sesión — ${leadNombre || cv?.nombre || cv?.archivoOriginal || 'candidato'}`,
      leadCorreo,
      leadNombre,
      leadTelefono,
      leadCiudad,
      leadEstado,
      origen: 'msg'
    });

    return res.status(201).json({ success: true, ...data });
  } catch (error) {
    const status = error.status || 502;
    const payload = {
      success: false,
      error: error.message,
      ...(error.panelBody && typeof error.panelBody === 'object' ? { panel: error.panelBody } : {}),
      ...(error.leadExtraido ? { leadExtraido: error.leadExtraido } : {})
    };
    if (status === 400 && /email|correo/i.test(error.message || '')) {
      payload.hint =
        'DeepSeek no encontró email en el CV. Reintenta enviando leadCorreo, o sube un CV con correo visible.';
    }
    if (status === 409) {
      payload.hint = 'El horario ya no está disponible. Elige otro slot.';
    }
    return res.status(status).json(payload);
  }
});

// --- Gestión de sesiones WhatsApp (persistidas en data/sessions.json) ---

app.get('/api/sessions', (req, res) => {
  try {
    const sessions = filterSessionsForUser(req.user, sessionsStore.getAllSessions());
    res.json({ success: true, sessions });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

/** Estado conectada/desconectada en OpenWA para las líneas visibles del usuario. */
app.get('/api/sessions/connection-status', async (req, res) => {
  try {
    const sessions = filterSessionsForUser(req.user, sessionsStore.getAllSessions());
    if (TEST_MODE) {
      const statuses = {};
      sessions.forEach((s) => {
        statuses[s.id] = {
          connected: true,
          status: 'test',
          openwaSessionId: s.openwaSessionId
        };
      });
      return res.json({ success: true, statuses, checkedAt: new Date().toISOString() });
    }

    let remoteById = new Map();
    try {
      const remote = await listOpenWASessions({ limit: 100 });
      remoteById = new Map(
        remote.map((row) => [String(row.id).toLowerCase(), row])
      );
    } catch (err) {
      console.warn('[sessions/connection-status] listOpenWASessions falló:', err.message);
    }

    const statuses = {};
    for (const s of sessions) {
      const key = String(s.openwaSessionId || '').toLowerCase();
      const row = key ? remoteById.get(key) : null;
      if (!row) {
        statuses[s.id] = {
          connected: false,
          status: remoteById.size === 0 ? 'unreachable' : 'missing',
          openwaSessionId: s.openwaSessionId
        };
      } else {
        statuses[s.id] = {
          connected: isConnectedStatus(row.status),
          status: row.status || 'unknown',
          openwaSessionId: s.openwaSessionId
        };
      }
    }

    res.json({
      success: true,
      statuses,
      checkedAt: new Date().toISOString()
    });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

app.post('/api/sessions', requireSuper, async (req, res) => {
  try {
    const openwaSessionId = String(req.body.openwaSessionId || '').trim();
    if (!openwaSessionId) {
      return res.status(400).json({ success: false, error: 'openwaSessionId es obligatorio' });
    }

    let senderName =
      req.body.senderName != null ? String(req.body.senderName).trim() : '';

    if (!senderName) {
      try {
        const status = await getSessionStatus(openwaSessionId);
        senderName = status.profileName || extractProfileName(status.raw);
      } catch (err) {
        console.warn(`No se pudo obtener nombre de perfil para ${openwaSessionId}:`, err.message);
      }
    }

    const session = sessionsStore.addSession({
      openwaSessionId,
      label: req.body.label,
      ...(senderName ? { senderName } : {})
    });
    res.status(201).json({ success: true, session });
  } catch (error) {
    res.status(400).json({ success: false, error: error.message });
  }
});

app.put('/api/sessions/:id', requireSuper, (req, res) => {
  try {
    const logicalId = req.params.id;
    const patch = {
      label: req.body.label,
      openwaSessionId: req.body.openwaSessionId,
      senderName: req.body.senderName
    };
    if (Object.prototype.hasOwnProperty.call(req.body, 'androidDeviceId')) {
      patch.androidDeviceId = req.body.androidDeviceId;
    }
    if (Object.prototype.hasOwnProperty.call(req.body, 'outreachChannel')) {
      patch.outreachChannel = req.body.outreachChannel;
    }

    const session = sessionsStore.updateSession(logicalId, patch);

    if (Object.prototype.hasOwnProperty.call(req.body, 'androidDeviceId')) {
      try {
        if (session.androidDeviceId) {
          androidGatewayStore.linkDeviceToLogicalSession(
            session.androidDeviceId,
            logicalId
          );
        } else {
          // Desvincular devices que apuntaban a esta línea
          for (const d of androidGatewayStore.listDevices()) {
            if (d.logicalSessionId === logicalId) {
              androidGatewayStore.linkDeviceToLogicalSession(d.id, null);
            }
          }
        }
      } catch (linkErr) {
        return res.status(400).json({
          success: false,
          error: `Línea guardada, pero no se pudo vincular Android: ${linkErr.message}`,
          session
        });
      }
    }

    res.json({ success: true, session });
  } catch (error) {
    res.status(400).json({ success: false, error: error.message });
  }
});

app.post('/api/sessions/:id/sync-sender-name', requireSuper, async (req, res) => {
  try {
    const logicalId = req.params.id;
    const session = sessionsStore.getSession(logicalId);
    if (!session) {
      return res.status(404).json({ success: false, error: `Sesión "${logicalId}" no encontrada` });
    }

    const status = await getSessionStatus(session.openwaSessionId);
    const profileName = status.profileName || extractProfileName(status.raw);
    if (!profileName) {
      return res.status(400).json({
        success: false,
        error: 'OpenWA no devolvió un nombre de perfil para esta sesión'
      });
    }

    const updated = sessionsStore.updateSession(logicalId, { senderName: profileName });
    res.json({ success: true, session: updated });
  } catch (error) {
    res.status(400).json({ success: false, error: error.message });
  }
});

app.delete('/api/sessions/:id', requireSuper, (req, res) => {
  try {
    const logicalId = req.params.id;
    sessionsStore.removeSession(logicalId);
    usersStore.removeSessionFromAllUsers(logicalId);
    const cached = whatsappServices.get(logicalId);
    if (cached) {
      cached.close().catch(() => {});
      whatsappServices.delete(logicalId);
    }
    res.json({ success: true, message: `Sesión ${logicalId} eliminada` });
  } catch (error) {
    res.status(400).json({ success: false, error: error.message });
  }
});

app.get('/api/openwa/sessions', requireSuper, async (req, res) => {
  try {
    const status = req.query.status ? String(req.query.status) : undefined;
    const sessions = await listOpenWASessions({ status, limit: 100 });
    res.json({ success: true, sessions });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

app.post('/api/sessions/import-connected', requireSuper, async (req, res) => {
  try {
    const remote = await listOpenWASessions({ limit: 100 });
    const connected = remote.filter((s) => isConnectedStatus(s.status));
    const added = sessionsStore.importOpenWASessions(connected);
    res.json({
      success: true,
      added,
      message:
        added.length > 0
          ? `Se agregaron ${added.length} sesión(es) conectada(s)`
          : 'No hay sesiones nuevas para importar (todas ya estaban registradas o ninguna conectada)'
    });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

app.get('/api/send-queue', (req, res) => {
  const state = sendQueueStore.getPublicState();
  const visibleBatches = (state.batches || []).filter((b) =>
    canControlSendQueueBatch(req.user, b)
  );
  const filtered = {
    ...state,
    batches: visibleBatches,
    batch: visibleBatches.find((b) => b.id === state.batch?.id) || visibleBatches[0] || null
  };
  res.json({ success: true, ...filtered });
});

app.post('/api/send-queue', async (req, res) => {
  try {
    const selectedSessions =
      Array.isArray(req.body?.selectedSessions) && req.body.selectedSessions.length > 0
        ? req.body.selectedSessions.map(String)
        : filterSessionsForUser(
            req.user,
            sessionsStore.getAllSessions(),
            'control'
          ).map((s) => s.id);
    if (!TEST_MODE && (!selectedSessions || selectedSessions.length < 1)) {
      return res.status(400).json({ error: 'No hay sesiones configuradas' });
    }
    if (!forbidUnlessControlSessions(selectedSessions || [], req, res)) return;

    const prepared = await prepareCvsForSend(req.body?.cvs);
    if (prepared.error) {
      return res.status(prepared.status || 400).json({ error: prepared.error });
    }
    if (!prepared.finalCvsToSend.length) {
      return res.status(400).json({
        error: 'No hay CVs con mensajes listos y teléfonos válidos'
      });
    }

    const slot =
      req.body?.slot === 'morning' || req.body?.slot === 'afternoon'
        ? req.body.slot
        : null;

    const batch = sendQueueStore.enqueue({
      cvs: prepared.finalCvsToSend,
      selectedSessions,
      sessionWeights: req.body?.sessionWeights || null,
      scheduledAt: slot ? null : req.body?.scheduledAt || null,
      slot,
      channel:
        req.body?.channel === 'android' || req.body?.channel === 'openwa'
          ? req.body.channel
          : 'auto'
    });
    armSendQueueTimer();

    broadcastEvent('sendQueueUpdated', sendQueueStore.getPublicState());
    res.status(201).json({ success: true, batch, ...sendQueueStore.getPublicState() });
  } catch (err) {
    res.status(err.status || 500).json({ error: err.message });
  }
});

app.post('/api/send-queue/dispatch', async (req, res) => {
  try {
    const batchId = req.body?.batchId || null;
    const target = batchId
      ? sendQueueStore.getBatchById(batchId)
      : sendQueueStore.pickNextDispatchBatch();
    if (target?.selectedSessions?.length) {
      if (!forbidUnlessControlSessions(target.selectedSessions, req, res)) return;
    }
    const started = await dispatchQueuedBatch(req.user, batchId);
    res.status(202).json({
      success: true,
      started: true,
      batch: started,
      ...sendQueueStore.getPublicState()
    });
  } catch (err) {
    res.status(err.status || 500).json({ error: err.message });
  }
});

app.post('/api/send-queue/cancel', (req, res) => {
  try {
    const batchId = req.body?.batchId || null;
    const current = batchId
      ? sendQueueStore.getBatchById(batchId)
      : sendQueueStore.getBatch();
    if (current?.selectedSessions?.length) {
      if (!forbidUnlessControlSessions(current.selectedSessions, req, res)) return;
    }
    const batch = sendQueueStore.cancel(batchId);
    armSendQueueTimer();
    broadcastEvent('sendQueueUpdated', sendQueueStore.getPublicState());
    res.json({ success: true, batch, ...sendQueueStore.getPublicState() });
  } catch (err) {
    res.status(err.status || 500).json({ error: err.message });
  }
});

app.post('/api/send-queue/clear', (req, res) => {
  try {
    const force = Boolean(req.body?.force);
    const sending = sendQueueStore.getSendingBatch();

    if (sending?.selectedSessions?.length) {
      if (!forbidUnlessControlSessions(sending.selectedSessions, req, res)) return;
    }

    // Job vivo: nunca limpiar
    if (isAnySendingInProgress()) {
      return res.status(409).json({
        error: 'No se puede limpiar la cola durante un envío'
      });
    }

    // sending en disco sin job = huérfano; force o auto-recovery
    if (sending && !force) {
      return res.status(409).json({
        error:
          'Hay un lote marcado como enviando sin job activo. Usa force:true para desbloquearlo.',
        orphanSending: true,
        batchId: sending.id
      });
    }

    sendQueueStore.clearBatch({ force: Boolean(sending) || force });
    clearSendQueueTimer();
    const state = sendQueueStore.getPublicState();
    broadcastEvent('sendQueueUpdated', state);
    res.json({ success: true, ...state });
  } catch (err) {
    res.status(err.status || 500).json({ error: err.message });
  }
});

app.post('/api/send-queue/clear-terminal', (req, res) => {
  try {
    sendQueueStore.clearTerminalBatches();
    const state = sendQueueStore.getPublicState();
    broadcastEvent('sendQueueUpdated', state);
    res.json({ success: true, ...state });
  } catch (err) {
    res.status(err.status || 500).json({ error: err.message });
  }
});

function getAndroidGatewayToken() {
  return String(process.env.ANDROID_GATEWAY_TOKEN || '').trim();
}

function requireAndroidToken(req, res) {
  const expected = getAndroidGatewayToken();
  if (!expected) {
    res.status(503).json({
      error: 'Android gateway no configurado. Define ANDROID_GATEWAY_TOKEN en .env'
    });
    return false;
  }
  const got = String(
    req.headers['x-android-token'] || req.query.token || req.body?.token || ''
  ).trim();
  if (!got || got !== expected) {
    res.status(401).json({ error: 'Token Android inválido' });
    return false;
  }
  return true;
}

// --- Android gateway (agente en celular) ---
app.get('/api/android/devices', (req, res) => {
  try {
    if (!forbidUnlessAnyControl(req, res)) return;
    res.json({
      success: true,
      config: androidGatewayStore.getConfig(),
      devices: androidGatewayStore.listDevices(),
      online: androidGatewayStore.pickOnlineDevices({ maxAgeMs: 3 * 60 * 1000 })
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/android/jobs', (req, res) => {
  try {
    if (!forbidUnlessAnyControl(req, res)) return;
    const jobs = androidGatewayStore.listJobs({
      batchId: req.query.batchId || null,
      status: req.query.status || null,
      limit: Number(req.query.limit) || 100
    });
    res.json({ success: true, jobs });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/android/devices/register', (req, res) => {
  try {
    if (!requireAndroidToken(req, res)) return;
    const device = androidGatewayStore.registerDevice({
      label: req.body?.label,
      logicalSessionId: req.body?.logicalSessionId || null,
      deviceId: req.body?.deviceId || null,
      batteryLevel: req.body?.batteryLevel
    });
    res.json({ success: true, device, config: androidGatewayStore.getConfig() });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/android/devices/:id/heartbeat', (req, res) => {
  try {
    if (!requireAndroidToken(req, res)) return;
    const device = androidGatewayStore.heartbeat(req.params.id, {
      batteryLevel: req.body?.batteryLevel
    });
    if (!device) return res.status(404).json({ error: 'device_not_found' });
    res.json({ success: true, device });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/android/jobs/next', (req, res) => {
  try {
    if (!requireAndroidToken(req, res)) return;
    const deviceId = String(req.query.deviceId || '').trim();
    if (!deviceId) return res.status(400).json({ error: 'deviceId requerido' });
    if (!androidGatewayStore.getDevice(deviceId)) {
      return res.status(404).json({ error: 'device_not_found' });
    }
    const job = androidGatewayStore.claimNextJob({ deviceId });
    res.json({ success: true, job: job || null, config: androidGatewayStore.getConfig() });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/android/jobs/:id/result', (req, res) => {
  try {
    if (!requireAndroidToken(req, res)) return;
    const deviceId = String(req.body?.deviceId || '').trim();
    if (!deviceId) return res.status(400).json({ error: 'deviceId requerido' });
    const job = androidGatewayStore.reportJobResult({
      jobId: req.params.id,
      deviceId,
      ok: Boolean(req.body?.ok),
      error: req.body?.error || null
    });
    res.json({ success: true, job });
  } catch (err) {
    const code = err.code || null;
    const status =
      code === 'job_not_found'
        ? 404
        : code === 'device_mismatch' || code === 'invalid_status'
          ? 409
          : 500;
    res.status(status).json({ error: err.message, code });
  }
});

const DEFAULT_ANDROID_TEST_MESSAGE =
  'Hola, este es un mensaje de prueba de ProTalent Connections. Si lo recibiste, la línea Android está funcionando correctamente.';

app.post('/api/android/test-send', requireSuper, (req, res) => {
  try {
    const deviceId = String(req.body?.deviceId || '').trim();
    const telefono = String(req.body?.telefono || '').replace(/\D/g, '');
    const mensaje = String(req.body?.mensaje || DEFAULT_ANDROID_TEST_MESSAGE).trim();

    if (!deviceId) {
      return res.status(400).json({ error: 'Selecciona un celular vinculado' });
    }
    if (telefono.length < 10) {
      return res.status(400).json({ error: 'Teléfono destino inválido (mín. 10 dígitos)' });
    }
    if (!mensaje) {
      return res.status(400).json({ error: 'Mensaje vacío' });
    }

    const device = androidGatewayStore.getDevice(deviceId);
    if (!device) {
      return res.status(404).json({ error: 'Dispositivo no encontrado' });
    }

    const online = androidGatewayStore.pickOnlineDevices({ maxAgeMs: 3 * 60 * 1000 });
    if (!online.some((d) => d.id === deviceId)) {
      return res.status(409).json({
        error: 'Ese celular no está online. Abre WA Agent e Iniciar agente.'
      });
    }

    let finalMessage = mensaje;
    if (device.logicalSessionId) {
      const senderName = sessionsStore.getSessionSenderName(device.logicalSessionId);
      if (senderName && !/Atte:/i.test(finalMessage)) {
        finalMessage = `${finalMessage}\n\nAtte:\n${senderName}`;
      } else if (senderName) {
        const { applySenderName } = require('./messageSignature');
        finalMessage = applySenderName(finalMessage, senderName);
      }
    }

    const [job] = androidGatewayStore.enqueueJobs(
      [
        {
          telefono,
          mensaje: finalMessage,
          nombre: 'Prueba ProTalent',
          meta: {
            test: true,
            bypassInterval: true,
            source: 'admin_test',
            logicalSessionId: device.logicalSessionId || null
          }
        }
      ],
      [deviceId]
    );

    res.json({
      success: true,
      message: 'Prueba encolada. El celular debería abrir WhatsApp en unos segundos.',
      job,
      device: { id: device.id, label: device.label }
    });
  } catch (err) {
    res.status(err.status || 500).json({ error: err.message, code: err.code || null });
  }
});

// Ruta para enviar mensajes por WhatsApp
app.post('/send-whatsapp', async (req, res) => {
  try {
    const sendingBatch = sendQueueStore.getSendingBatch();
    if (sendingBatch || isAnySendingInProgress()) {
      return res.status(409).json({
        error: 'Hay un envío en curso. Espera a que termine o usa la cola.',
        batch: sendingBatch && canControlSendQueueBatch(req.user, sendingBatch)
          ? sendingBatch
          : null
      });
    }

    const configuredIds = filterSessionsForUser(
      req.user,
      sessionsStore.getAllSessions(),
      'control'
    ).map((s) => s.id);
    const selectedSessions =
      Array.isArray(req.body.selectedSessions) && req.body.selectedSessions.length > 0
        ? req.body.selectedSessions.map((id) => String(id)).filter(Boolean)
        : configuredIds.length > 0
          ? configuredIds
          : null;

    if (!TEST_MODE && (!selectedSessions || selectedSessions.length < 1)) {
      return res.status(400).json({
        success: false,
        error: 'No hay sesiones configuradas. Agrega sesiones en la interfaz web.'
      });
    }

    if (!forbidUnlessControlSessions(selectedSessions || [], req, res)) {
      return;
    }

    const sessionIds = TEST_MODE
      ? (selectedSessions && selectedSessions.length > 0 ? selectedSessions : ['default'])
      : selectedSessions;

    const prepared = await prepareCvsForSend(req.body?.cvs);
    if (prepared.error) {
      return res.status(prepared.status || 400).json({ error: prepared.error });
    }
    const { finalCvsToSend, skippedAlreadyContacted, duplicates } = prepared;
    const mongoRecordHook = createMongoRecordHook();

    if (finalCvsToSend.length === 0) {
      return res.status(200).json({
        success: true,
        message:
          skippedAlreadyContacted.length > 0
            ? 'Todos los destinatarios ya habían sido contactados antes.'
            : 'No hay destinatarios para enviar.',
        skippedAlreadyContacted,
        allSkippedOrEmpty: true,
        results: [],
        testMode: TEST_MODE
      });
    }

    console.log(`Iniciando envío de ${finalCvsToSend.length} mensajes por WhatsApp (${duplicates.length} duplicados eliminados)...`);
    console.log(`Modo de prueba: ${TEST_MODE ? 'ACTIVADO (simulando envíos)' : 'DESACTIVADO (enviando real)'}`);

    const sessionWeights =
      req.body.sessionWeights && typeof req.body.sessionWeights === 'object'
        ? req.body.sessionWeights
        : null;
    const channel =
      req.body?.channel === 'android' || req.body?.channel === 'openwa'
        ? req.body.channel
        : 'auto';

    try {
      sendQueueStore.beginDirectSend({
        cvs: finalCvsToSend,
        selectedSessions: sessionIds,
        sessionWeights,
        scheduledAt: null,
        channel
      });
    } catch (error) {
      if (error.status) {
        return res.status(error.status).json({ error: error.message });
      }
      throw error;
    }

    res.status(202).json({
      success: true,
      started: true,
      total: finalCvsToSend.length,
      sessionIds,
      channel,
      skippedAlreadyContacted,
      testMode: TEST_MODE,
      message: `Envío iniciado para ${finalCvsToSend.length} mensajes (${channel})`
    });

    runWhatsAppSendJob({
      finalCvsToSend,
      sessionIds,
      sessionWeights,
      skippedAlreadyContacted,
      mongoRecordHook,
      testMode: TEST_MODE,
      channel
    });
  } catch (error) {
    console.error('Error enviando mensajes por WhatsApp:', error);
    res.status(500).json({
      error: 'Error enviando mensajes por WhatsApp',
      message: error.message
    });
  }
});

// Estado del envío masivo (para polling desde el cliente)
app.get('/send-job-status', (req, res) => {
  const anyInProgress = [...sessionStates.values()].some((s) => s.sendingInProgress);

  res.json({
    success: true,
    inProgress: lastSendJob.inProgress || anyInProgress,
    anyInProgress,
    total: lastSendJob.total,
    successCount: lastSendJob.successCount || 0,
    completedCount: lastSendJob.completedCount || 0,
    sessionIds: lastSendJob.sessionIds,
    startedAt: lastSendJob.startedAt,
    completedAt: lastSendJob.completedAt,
    error: lastSendJob.error,
    message: lastSendJob.message,
    results: lastSendJob.results,
    skippedAlreadyContacted: lastSendJob.skippedAlreadyContacted,
    testMode: lastSendJob.testMode
  });
});

// Ruta para verificar sesiones OpenWA (equivalente a "abrir WhatsApp" en Puppeteer)
app.post('/open-whatsapp', async (req, res) => {
  try {
    if (TEST_MODE) {
      return res.status(400).json({
        error: 'No se puede verificar sesiones OpenWA en modo de prueba'
      });
    }

    const openAllSessions = req.body.openAllSessions === true;
    /** @type {string[]} */
    let sessionIds;
    const configuredIds = filterSessionsForUser(
      req.user,
      sessionsStore.getAllSessions(),
      'control'
    ).map((s) => s.id);
    if (openAllSessions) {
      sessionIds = configuredIds.length > 0 ? [...configuredIds] : [];
      if (sessionIds.length === 0) {
        return res.status(400).json({
          error: 'No hay sesiones configuradas. Agrega sesiones en la interfaz web.'
        });
      }
    } else if (Array.isArray(req.body.sessionIds) && req.body.sessionIds.length > 0) {
      sessionIds = req.body.sessionIds.map((id) => String(id)).filter(Boolean);
    } else {
      sessionIds = [req.body.sessionId || 'session1'];
    }

    if (!forbidUnlessControlSessions(sessionIds, req, res)) {
      return;
    }

    /** @returns {Promise<{ sessionId: string, success: boolean, skippedAlreadyOpen?: boolean, message?: string, openwaSessionId?: string, status?: string }>} */
    const checkOneSession = async (logicalSessionId) => {
      let openwaSessionId;
      try {
        openwaSessionId = sessionsStore.resolveOpenWASessionId(logicalSessionId);
      } catch (err) {
        return {
          sessionId: logicalSessionId,
          success: false,
          error: err.message
        };
      }

      const cached = whatsappServices.get(logicalSessionId);
      if (cached && cached.isReady()) {
        return {
          sessionId: logicalSessionId,
          openwaSessionId,
          success: true,
          skippedAlreadyOpen: true,
          message: `Sesión OpenWA ya verificada (${logicalSessionId})`
        };
      }

      const status = await getSessionStatus(openwaSessionId);
      if (!status.connected) {
        return {
          sessionId: logicalSessionId,
          openwaSessionId,
          success: false,
          status: status.status,
          error: `Sesión no conectada (estado: ${status.status || 'desconocido'})`
        };
      }

      let svc = whatsappServices.get(logicalSessionId);
      if (!svc) {
        svc = new WhatsAppService(logicalSessionId);
        whatsappServices.set(logicalSessionId, svc);
      }
      svc.openwaSessionId = openwaSessionId;
      svc.isInitialized = true;

      console.log(`Sesión OpenWA verificada (${logicalSessionId} → ${openwaSessionId})`);
      return {
        sessionId: logicalSessionId,
        openwaSessionId,
        success: true,
        status: status.status,
        message: `Sesión ${logicalSessionId} conectada en OpenWA`
      };
    };

    const settled = await Promise.allSettled(sessionIds.map((id) => checkOneSession(id)));

    /** @type {Array<{ sessionId: string, success: boolean, skippedAlreadyOpen?: boolean, message?: string, error?: string }>} */
    const results = settled.map((s, idx) => {
      const sid = sessionIds[idx];
      if (s.status === 'fulfilled') {
        return s.value;
      }
      console.error(`Error verificando sesión OpenWA (${sid}):`, s.reason);
      return {
        sessionId: sid,
        success: false,
        error: s.reason && (s.reason.message || String(s.reason))
      };
    });

    const okCount = results.filter((r) => r.success).length;
    const allOk = okCount === results.length;

    return res.json({
      success: okCount > 0,
      allOpened: allOk,
      message:
        openAllSessions || sessionIds.length > 1
          ? `OpenWA: ${okCount}/${results.length} sesión(es) conectada(s).`
          : results[0].success
            ? results[0].skippedAlreadyOpen
              ? results[0].message
              : 'Sesión OpenWA verificada correctamente'
            : `Error: ${results[0].error || 'desconocido'}`,
      results
    });
  } catch (error) {
    console.error('Error verificando sesiones OpenWA:', error);
    res.status(500).json({
      error: 'Error verificando sesiones OpenWA',
      message: error.message
    });
  }
});

// Ruta para desvincular sesión local (OpenWA sigue activo en el servidor remoto)
app.post('/close-whatsapp', async (req, res) => {
  try {
    const sessionId = req.body.sessionId || 'default';
    const whatsappService = whatsappServices.get(sessionId);

    if (whatsappService) {
      await whatsappService.close();
      whatsappServices.delete(sessionId);
      console.log(`Servicio local desvinculado (Sesión: ${sessionId})`);
    }

    res.json({
      success: true,
      message:
        'Servicio local desvinculado. Las sesiones WhatsApp siguen gestionándose en el dashboard de OpenWA.'
    });
  } catch (error) {
    console.error('Error desvinculando sesión:', error);
    res.status(500).json({
      error: 'Error desvinculando sesión',
      message: error.message
    });
  }
});

// Ruta para limpiar datos
app.post('/clear-data', (req, res) => {
  cvsData = [];
  cvFileStore.clearAllCvs();
  console.log('Datos de CVs limpiados (disco + memoria)');

  res.json({
    success: true,
    message: 'Datos limpiados correctamente'
  });
});

function assertSendingControl(req, res, sessionId) {
  if (sessionId === ROUND_ROBIN_CONTROL_ID) {
    const activeIds = [...sessionStates.entries()]
      .filter(([, state]) => state.sendingInProgress)
      .map(([id]) => id);
    if (activeIds.length === 0) return true;
    return forbidUnlessControlSessions(activeIds, req, res);
  }
  return forbidUnlessControlSessions([sessionId], req, res);
}

// Ruta para pausar envíos (solo en producción)
app.post('/pause-sending', (req, res) => {
  if (TEST_MODE) {
    return res.status(400).json({
      error: 'No se puede pausar en modo de prueba'
    });
  }

  const sessionId = req.body.sessionId || 'default';
  if (!assertSendingControl(req, res, sessionId)) return;

  if (sessionId === ROUND_ROBIN_CONTROL_ID) {
    let pausedAny = false;
    for (const [, state] of sessionStates) {
      if (state.sendingInProgress) {
        state.sendingPaused = true;
        pausedAny = true;
      }
    }
    if (!pausedAny) {
      return res.status(400).json({ error: 'No hay envíos en progreso' });
    }
    console.log('⏸️  Envíos pausados en todas las sesiones activas');
    return res.json({ success: true, message: 'Envíos pausados en todas las sesiones' });
  }

  const sessionState = getSessionState(sessionId);

  if (!sessionState.sendingInProgress) {
    return res.status(400).json({
      error: 'No hay envíos en progreso para esta sesión'
    });
  }

  sessionState.sendingPaused = true;
  console.log(`⏸️  Envíos pausados por el usuario (Sesión: ${sessionId})`);

  res.json({
    success: true,
    message: 'Envíos pausados'
  });
});

// Ruta para reanudar envíos (solo en producción)
app.post('/resume-sending', (req, res) => {
  if (TEST_MODE) {
    return res.status(400).json({
      error: 'No se puede reanudar en modo de prueba'
    });
  }

  const sessionId = req.body.sessionId || 'default';
  if (!assertSendingControl(req, res, sessionId)) return;

  if (sessionId === ROUND_ROBIN_CONTROL_ID) {
    let resumedAny = false;
    for (const [, state] of sessionStates) {
      if (state.sendingInProgress) {
        state.sendingPaused = false;
        resumedAny = true;
      }
    }
    if (!resumedAny) {
      return res.status(400).json({ error: 'No hay envíos en progreso' });
    }
    console.log('▶️  Envíos reanudados en todas las sesiones activas');
    return res.json({ success: true, message: 'Envíos reanudados en todas las sesiones' });
  }

  const sessionState = getSessionState(sessionId);

  if (!sessionState.sendingInProgress) {
    return res.status(400).json({
      error: 'No hay envíos en progreso para esta sesión'
    });
  }

  sessionState.sendingPaused = false;
  console.log(`▶️  Envíos reanudados por el usuario (Sesión: ${sessionId})`);

  res.json({
    success: true,
    message: 'Envíos reanudados'
  });
});

// Ruta para abortar envíos (solo en producción)
app.post('/abort-sending', (req, res) => {
  if (TEST_MODE) {
    return res.status(400).json({
      error: 'No se puede abortar en modo de prueba'
    });
  }

  const sessionId = req.body.sessionId || 'default';
  if (!assertSendingControl(req, res, sessionId)) return;

  if (sessionId === ROUND_ROBIN_CONTROL_ID) {
    const hadActive = [...sessionStates.values()].some((s) => s.sendingInProgress);
    if (!hadActive) {
      return res.status(400).json({ error: 'No hay envíos en progreso' });
    }
    abortAllActiveSessions();
    console.log('🛑 Envíos abortados en todas las sesiones activas');
    return res.json({ success: true, message: 'Envíos abortados en todas las sesiones' });
  }

  const sessionState = getSessionState(sessionId);

  if (!sessionState.sendingInProgress) {
    return res.status(400).json({
      error: 'No hay envíos en progreso para esta sesión'
    });
  }

  sessionState.sendingAborted = true;
  sessionState.sendingPaused = false;
  console.log(`🛑 Envíos abortados por el usuario (Sesión: ${sessionId})`);

  res.json({
    success: true,
    message: 'Envíos abortados'
  });
});

// Ruta para pausar el tiempo de espera
app.post('/pause-time', (req, res) => {
  if (TEST_MODE) {
    return res.status(400).json({
      error: 'No se puede pausar el tiempo en modo de prueba'
    });
  }

  const sessionId = req.body.sessionId || 'default';
  if (!assertSendingControl(req, res, sessionId)) return;

  if (sessionId === ROUND_ROBIN_CONTROL_ID) {
    let pausedAny = false;
    for (const [, state] of sessionStates) {
      if (state.sendingInProgress) {
        state.timePaused = true;
        pausedAny = true;
      }
    }
    if (!pausedAny) {
      return res.status(400).json({ error: 'No hay envíos en progreso' });
    }
    return res.json({ success: true, message: 'Tiempo pausado en todas las sesiones' });
  }

  const sessionState = getSessionState(sessionId);

  if (!sessionState.sendingInProgress) {
    return res.status(400).json({
      error: 'No hay envíos en progreso para esta sesión'
    });
  }

  sessionState.timePaused = true;
  console.log(`⏸️  Tiempo de espera pausado (Sesión: ${sessionId})`);

  res.json({
    success: true,
    message: 'Tiempo de espera pausado'
  });
});

// Ruta para reanudar el tiempo de espera
app.post('/resume-time', (req, res) => {
  if (TEST_MODE) {
    return res.status(400).json({
      error: 'No se puede reanudar el tiempo en modo de prueba'
    });
  }

  const sessionId = req.body.sessionId || 'default';
  if (!assertSendingControl(req, res, sessionId)) return;

  if (sessionId === ROUND_ROBIN_CONTROL_ID) {
    let resumedAny = false;
    for (const [, state] of sessionStates) {
      if (state.sendingInProgress) {
        state.timePaused = false;
        resumedAny = true;
      }
    }
    if (!resumedAny) {
      return res.status(400).json({ error: 'No hay envíos en progreso' });
    }
    return res.json({ success: true, message: 'Tiempo reanudado en todas las sesiones' });
  }

  const sessionState = getSessionState(sessionId);

  if (!sessionState.sendingInProgress) {
    return res.status(400).json({
      error: 'No hay envíos en progreso para esta sesión'
    });
  }

  sessionState.timePaused = false;
  console.log(`▶️  Tiempo de espera reanudado (Sesión: ${sessionId})`);

  res.json({
    success: true,
    message: 'Tiempo de espera reanudado'
  });
});

// Ruta para enviar el siguiente mensaje manualmente (saltar la espera)
app.post('/skip-wait', (req, res) => {
  if (TEST_MODE) {
    return res.status(400).json({
      error: 'No se puede saltar la espera en modo de prueba'
    });
  }

  const sessionId = req.body.sessionId || 'default';
  if (!assertSendingControl(req, res, sessionId)) return;

  if (sessionId === ROUND_ROBIN_CONTROL_ID) {
    let skippedAny = false;
    for (const [, state] of sessionStates) {
      if (state.sendingInProgress) {
        state.skipWait = true;
        state.timePaused = false;
        skippedAny = true;
      }
    }
    if (!skippedAny) {
      return res.status(400).json({ error: 'No hay envíos en progreso' });
    }
    return res.json({ success: true, message: 'Siguiente mensaje en todas las sesiones activas' });
  }

  const sessionState = getSessionState(sessionId);

  if (!sessionState.sendingInProgress) {
    return res.status(400).json({
      error: 'No hay envíos en progreso para esta sesión'
    });
  }

  sessionState.skipWait = true;
  sessionState.timePaused = false;
  console.log(`⏩ Saltando espera - enviando siguiente mensaje manualmente (Sesión: ${sessionId})`);

  res.json({
    success: true,
    message: 'El siguiente mensaje se enviará inmediatamente'
  });
});

// Ruta para obtener estado de envíos
app.get('/sending-status', (req, res) => {
  const sessionId = req.query.sessionId || 'default';
  const sessionState = getSessionState(sessionId);

  res.json({
    success: true,
    sendingInProgress: sessionState.sendingInProgress,
    sendingPaused: sessionState.sendingPaused,
    sendingAborted: sessionState.sendingAborted,
    timePaused: sessionState.timePaused,
    liveStatus: sessionState.liveStatus,
    testMode: TEST_MODE
  });
});

// Estado de envío de varias sesiones (panel principal)
app.get('/sending-status-all', (req, res) => {
  const idsParam = req.query.sessionIds;
  const sessionIds =
    typeof idsParam === 'string' && idsParam.trim()
      ? idsParam.split(',').map((id) => id.trim()).filter(Boolean)
      : getConfiguredSessionIds();

  const sessions = sessionIds.map((id) => {
    const st = getSessionState(id);
    return {
      sessionId: id,
      sendingInProgress: st.sendingInProgress,
      sendingPaused: st.sendingPaused,
      sendingAborted: st.sendingAborted,
      timePaused: st.timePaused,
      liveStatus: st.liveStatus
    };
  });

  res.json({
    success: true,
    sessions,
    anyInProgress: sessions.some((s) => s.sendingInProgress),
    testMode: TEST_MODE
  });
});

// --- Auto-respuesta IA (webhooks OpenWA) ---

function getCvContextForPhone(phone) {
  const cv = findCvForPhone(phone);
  if (!cv) return null;
  const exp = String(cv.experiencia || '').slice(0, 500);
  return `Nombre: ${cv.nombre}\nExperiencia: ${exp}`;
}

function getLeadCvForPhone(phone) {
  return findCvForPhone(phone) || null;
}

function userHasAnyControl(req) {
  const user = req.user || getRequestUser(req);
  if (!user) return false;
  if (user.isSuper || user.role === 'super') return true;
  const sessions = sessionsStore.getAllSessions();
  return filterSessionsForUser(user, sessions, 'control').length > 0;
}

function forbidUnlessAnyControl(req, res) {
  if (!userHasAnyControl(req)) {
    res.status(403).json({
      success: false,
      error: 'Se requiere permiso de control en al menos una línea'
    });
    return false;
  }
  return true;
}

app.post('/api/webhooks/openwa', async (req, res) => {
  res.status(200).json({ received: true });

  try {
    const secret = String(process.env.WEBHOOK_SECRET || '').trim();
    const signature = req.headers['x-openwa-signature'];
    const rawBody = req.rawBody || Buffer.from(JSON.stringify(req.body || {}));

    if (secret && !autoReplyService.verifySignature(rawBody, signature, secret)) {
      console.warn('Webhook OpenWA: firma HMAC inválida');
      return;
    }

    const payload = req.body && Object.keys(req.body).length ? req.body : JSON.parse(rawBody.toString('utf8'));
    const idempotencyKey = req.headers['x-openwa-idempotency-key'];

    // Siempre registrar el mensaje entrante para la bandeja (aunque no haya auto-respuesta).
    const inboxRecord = autoReplyService.captureIncomingMessage({
      payload,
      broadcastEvent,
      idempotencyKey
    });

    const replyResult = await autoReplyService.handleIncomingWebhook({
      payload,
      idempotencyKey,
      broadcastEvent,
      getCvContext: getCvContextForPhone,
      getLeadCv: getLeadCvForPhone,
      testMode: TEST_MODE
    });

    if (inboxRecord && replyResult) {
      incomingMessagesStore.update(inboxRecord.id, {
        autoReplyHandled: Boolean(replyResult.handled),
        autoReplyReason: replyResult.handled ? 'replied' : replyResult.reason || null,
        replyMessage: replyResult.replyMessage || null
      });
    }

    if (replyResult?.handled) {
      console.log(
        `[auto-reply] replied phone=${replyResult.telefono || '?'} session=${replyResult.sessionId || replyResult.openwaSessionId}`
      );
    } else if (inboxRecord) {
      console.log(
        `[auto-reply] skip reason=${replyResult?.reason || 'unknown'} phone=${inboxRecord.telefono || '?'} session=${inboxRecord.sessionId || inboxRecord.openwaSessionId || '?'} body=${String(inboxRecord.body || '').slice(0, 80)}`
      );
    }
  } catch (err) {
    console.error('Webhook OpenWA error:', err.message);
  }
});

app.get('/api/incoming-messages', (req, res) => {
  try {
    const requestedSession = req.query.sessionId ? String(req.query.sessionId) : '';
    if (requestedSession && !forbidUnlessViewSession(requestedSession, req, res)) {
      return;
    }

    let messages = incomingMessagesStore.list({
      limit: req.query.limit,
      sessionId: requestedSession || undefined
    });

    if (!req.user?.isSuper) {
      const allowed = new Set(
        filterSessionsForUser(req.user, sessionsStore.getAllSessions()).map((s) => s.id)
      );
      messages = messages.filter((m) => {
        const sid = m.sessionId || m.logicalSessionId;
        return sid && allowed.has(sid);
      });
    }

    res.json({ success: true, messages, total: messages.length });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

app.delete('/api/incoming-messages', (req, res) => {
  try {
    if (!req.user?.isSuper) {
      const hasControl = filterSessionsForUser(
        req.user,
        sessionsStore.getAllSessions(),
        'control'
      ).length > 0;
      if (!hasControl) {
        return res.status(403).json({
          success: false,
          error: 'No tienes permiso para limpiar la bandeja'
        });
      }
    }
    incomingMessagesStore.clear();
    res.json({ success: true, message: 'Bandeja limpiada' });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

/** Resuelve sesión lógica o OpenWA id → sesión configurada + openwaSessionId */
function resolveConfiguredSession(sessionParam) {
  const raw = String(sessionParam || '').trim();
  if (!raw) return null;
  const byLogical = sessionsStore.getSession(raw);
  if (byLogical) return byLogical;
  return (
    sessionsStore.getAllSessions().find((s) => s.openwaSessionId === raw) || null
  );
}

function openwaHttpStatus(error) {
  if (error && error.code === 'RATE_LIMIT') return 429;
  const status = Number(error && error.status);
  if (status >= 400 && status < 600) return status;
  return 500;
}

/** Ejecuta tareas async con concurrencia limitada. */
async function mapWithConcurrency(items, concurrency, worker) {
  const list = Array.isArray(items) ? items : [];
  const limit = Math.max(1, Number(concurrency) || 1);
  const results = new Array(list.length);
  let nextIndex = 0;

  async function runWorker() {
    while (nextIndex < list.length) {
      const index = nextIndex;
      nextIndex += 1;
      results[index] = await worker(list[index], index);
    }
  }

  const workers = Array.from({ length: Math.min(limit, list.length) }, () =>
    runWorker()
  );
  await Promise.all(workers);
  return results;
}

let conversationPreviewEnrichPromise = null;
let conversationPreviewEnrichQueued = null;

function previewEnrichDelayMs() {
  const v = parseInt(process.env.CONVERSATIONS_PREVIEW_DELAY_MS, 10);
  return Number.isFinite(v) && v >= 0 ? v : 700;
}

function previewEnrichBatchSize() {
  const v = parseInt(process.env.CONVERSATIONS_PREVIEW_BATCH, 10);
  return Number.isFinite(v) && v > 0 ? Math.min(v, 40) : 12;
}

/**
 * Carga previews de historial y los persiste en disco.
 * Ritmo lento a propósito para no disparar ThrottlerException en OpenWA.
 * @param {Array<{ sessionId: string, chatId: string, key?: string, lastMessage?: string }>} items
 * @param {{ lines?: number, user?: object }} [opts]
 */
async function enrichAndPersistConversationPreviews(items, opts = {}) {
  const lines = Math.min(Math.max(parseInt(opts.lines, 10) || 4, 1), 6);
  const delayMs = previewEnrichDelayMs();
  const list = Array.isArray(items) ? items : [];
  if (!list.length) return [];

  const previews = [];
  let hitRateLimit = false;

  for (let i = 0; i < list.length; i++) {
    const item = list[i];
    const session = resolveConfiguredSession(item.sessionId);
    const key =
      item.key ||
      conversationPreviewStore.chatKey(item.sessionId, item.chatId);

    // Si el cliente ya manda líneas, solo persistir (sin pegarle a OpenWA).
    if (Array.isArray(item.previewLines) && item.previewLines.length) {
      const previewLines = item.previewLines
        .map((l) => String(l || '').trim())
        .filter(Boolean)
        .slice(-8);
      previews.push({
        key: session
          ? conversationPreviewStore.chatKey(session.id, item.chatId)
          : key,
        sessionId: session ? session.id : item.sessionId,
        chatId: item.chatId,
        previewLines,
        lastFromMe:
          item.lastFromMe === true || item.lastFromMe === false
            ? item.lastFromMe
            : null,
        lastMessage:
          item.lastMessage || previewLines[previewLines.length - 1] || '',
        sourceLastMessage:
          item.sourceLastMessage ||
          item.lastMessage ||
          previewLines[previewLines.length - 1] ||
          ''
      });
      continue;
    }

    if (hitRateLimit) {
      previews.push({
        key,
        sessionId: item.sessionId,
        chatId: item.chatId,
        previewLines: [],
        error: 'rate_limited'
      });
      continue;
    }

    if (!session) {
      previews.push({
        key,
        sessionId: item.sessionId,
        chatId: item.chatId,
        previewLines: []
      });
      continue;
    }
    if (opts.user && !canViewSession(opts.user, session.id)) {
      previews.push({
        key,
        sessionId: session.id,
        chatId: item.chatId,
        previewLines: []
      });
      continue;
    }

    try {
      const messages = await getChatHistory(session.openwaSessionId, item.chatId, {
        limit: 12
      });
      const built = buildChatPreviewLines(messages, lines);
      const previewLines = built.previewLines || [];
      previews.push({
        key: conversationPreviewStore.chatKey(session.id, item.chatId),
        sessionId: session.id,
        chatId: item.chatId,
        previewLines,
        lastFromMe: built.lastFromMe,
        lastMessage: previewLines.length
          ? previewLines[previewLines.length - 1]
          : item.lastMessage || '',
        sourceLastMessage: item.lastMessage || ''
      });
    } catch (err) {
      if (err && err.code === 'RATE_LIMIT') {
        hitRateLimit = true;
        console.warn(
          `[conversations] rate-limit en previews — pausando lote (${list.length - i} pendientes)`
        );
      }
      previews.push({
        key,
        sessionId: session.id,
        chatId: item.chatId,
        previewLines: [],
        error: err.message
      });
      if (hitRateLimit) {
        await new Promise((r) => setTimeout(r, Math.max(delayMs * 4, 5000)));
      }
    }

    if (i < list.length - 1 && delayMs > 0) {
      await new Promise((r) => setTimeout(r, delayMs));
    }
  }

  conversationPreviewStore.upsertMany(
    previews.filter((p) => p.previewLines && p.previewLines.length)
  );
  return previews;
}

function scheduleConversationPreviewEnrichment(chats, user) {
  const batch = previewEnrichBatchSize();
  const needing = conversationPreviewStore.listNeedingEnrichment(chats, batch);
  if (!needing.length) return;

  if (conversationPreviewEnrichPromise) {
    conversationPreviewEnrichQueued = { chats, user };
    return;
  }

  conversationPreviewEnrichPromise = enrichAndPersistConversationPreviews(needing, {
    lines: 4,
    user
  })
    .then((rows) => {
      const ok = rows.filter((r) => r.previewLines && r.previewLines.length).length;
      if (ok) {
        console.log(`[conversations] previews persistidos: ${ok}/${needing.length}`);
      }
    })
    .catch((err) => {
      console.warn('[conversations] enrich background:', err.message);
    })
    .finally(() => {
      conversationPreviewEnrichPromise = null;
      const queued = conversationPreviewEnrichQueued;
      conversationPreviewEnrichQueued = null;
      const nextChats = queued ? queued.chats : chats;
      const nextUser = queued ? queued.user : user;
      const still = conversationPreviewStore.listNeedingEnrichment(nextChats, batch);
      if (still.length) {
        setTimeout(() => {
          scheduleConversationPreviewEnrichment(nextChats, nextUser);
        }, Math.max(previewEnrichDelayMs() * 3, 4000));
      }
    });
}

app.get('/api/conversations/search', async (req, res) => {
  try {
    const q = String(req.query.q || '').trim();
    if (q.length < 2) {
      return res.status(400).json({
        success: false,
        error: 'Escribe al menos 2 caracteres para buscar'
      });
    }

    const allowed = filterSessionsForUser(req.user, sessionsStore.getAllSessions());
    if (!allowed.length) {
      return res.status(400).json({
        success: false,
        error: 'No hay sesiones configuradas a las que tengas acceso'
      });
    }

    const byOpenwaId = new Map(
      allowed.map((s) => [String(s.openwaSessionId), s])
    );
    const limit = Math.min(Math.max(parseInt(req.query.limit, 10) || 30, 1), 50);

    const raw = await searchMessages({ q, limit: Math.min(limit * 3, 100) });
    if (!raw.available) {
      return res.json({
        success: true,
        available: false,
        q,
        hits: [],
        total: 0,
        error: raw.error || 'Búsqueda en historial no disponible en OpenWA'
      });
    }

    const hits = [];
    for (const hit of raw.hits || []) {
      if (!hit || typeof hit !== 'object') continue;
      const openwaSessionId = String(hit.sessionId || '');
      const session = byOpenwaId.get(openwaSessionId);
      if (!session) continue;

      const chatId = String(hit.chatId || '');
      if (!chatId) continue;

      hits.push({
        messageId: hit.messageId || hit.waMessageId || null,
        sessionId: session.id,
        sessionLabel: session.label || session.id,
        openwaSessionId: session.openwaSessionId,
        chatId,
        body: hit.body != null ? String(hit.body) : '',
        snippet: hit.snippet != null ? String(hit.snippet) : String(hit.body || ''),
        timestamp: hit.timestamp != null ? Number(hit.timestamp) : null,
        type: hit.type != null ? String(hit.type) : 'text',
        direction: hit.direction != null ? String(hit.direction) : null,
        from: hit.from != null ? String(hit.from) : null,
        score: hit.score != null ? Number(hit.score) : null
      });
      if (hits.length >= limit) break;
    }

    res.json({
      success: true,
      available: true,
      q,
      hits,
      total: hits.length,
      tookMs: raw.tookMs,
      provider: raw.provider
    });
  } catch (error) {
    console.error('[conversations] search error:', error.message);
    res.status(openwaHttpStatus(error)).json({ success: false, error: error.message });
  }
});

app.get('/api/conversations', async (req, res) => {
  try {
    const rawSession = String(req.query.sessionId || '').trim();
    const wantAll = !rawSession || rawSession === 'all';
    const baseSessions = wantAll
      ? sessionsStore.getAllSessions()
      : [resolveConfiguredSession(rawSession)].filter(Boolean);
    const sessions = filterSessionsForUser(req.user, baseSessions);

    if (!wantAll && rawSession && sessions.length === 0) {
      return res.status(403).json({
        success: false,
        error: `No tienes acceso a la sesión "${rawSession}"`
      });
    }

    if (!sessions.length) {
      return res.status(400).json({
        success: false,
        error: wantAll
          ? 'No hay sesiones configuradas'
          : 'Indica sessionId de una sesión configurada'
      });
    }

    const limit = Math.min(Math.max(parseInt(req.query.limit, 10) || 100, 1), 200);
    const includeGroups = String(req.query.includeGroups || '') === '1';

    console.log(
      `[conversations] listando chats sesiones=${sessions.map((s) => s.id).join(',')} limit=${limit}`
    );

    const settled = await mapWithConcurrency(sessions, 2, async (session) => {
      try {
        let chats = await listChats(session.openwaSessionId, {
          limit,
          offset: 0
        });
        if (!includeGroups) {
          chats = chats.filter((c) => !c.isGroup);
        }
        return { session, chats, error: null };
      } catch (err) {
        console.error(
          `[conversations] error sesión=${session.id}:`,
          err.message
        );
        return { session, chats: [], error: err.message, rateLimited: err.code === 'RATE_LIMIT' };
      }
    });

    const chats = settled
      .flatMap(({ session, chats: sessionChats }) =>
        sessionChats.map((c) => ({
          ...c,
          sessionId: session.id,
          sessionLabel: session.label || session.id,
          openwaSessionId: session.openwaSessionId,
          key: `${session.id}::${c.id}`
        }))
      )
      .sort((a, b) => (Number(b.timestamp) || 0) - (Number(a.timestamp) || 0));

    const errors = settled
      .filter((row) => row.error)
      .map((row) => ({
        sessionId: row.session.id,
        label: row.session.label || row.session.id,
        error: row.error
      }));

    const rateLimited = settled.some((row) => row.rateLimited);
    if (rateLimited && !chats.length) {
      return res.status(429).json({
        success: false,
        error: errors[0]?.error || 'Too Many Requests',
        errors
      });
    }

    console.log(
      `[conversations] OK ${chats.length} chats (${sessions.length} sesiones, ${errors.length} errores)`
    );

    const chatsWithPreviews = conversationPreviewStore.applyToChats(chats);
    scheduleConversationPreviewEnrichment(chatsWithPreviews, req.user);

    res.json({
      success: true,
      all: wantAll,
      sessions: sessions.map((s) => ({
        id: s.id,
        label: s.label || s.id,
        openwaSessionId: s.openwaSessionId
      })),
      errors,
      chats: chatsWithPreviews
    });
  } catch (error) {
    console.error('[conversations] error:', error.message);
    res.status(openwaHttpStatus(error)).json({ success: false, error: error.message });
  }
});

/**
 * Enriquecer previews: últimas N líneas de historial por chat.
 * Body: { items: [{ sessionId, chatId }], lines?: 4 }
 */
app.post('/api/conversations/previews', async (req, res) => {
  try {
    const lines = Math.min(Math.max(parseInt(req.body.lines, 10) || 4, 1), 6);
    const rawItems = Array.isArray(req.body.items) ? req.body.items : [];
    const items = rawItems
      .slice(0, previewEnrichBatchSize())
      .map((row) => ({
        sessionId: String((row && row.sessionId) || '').trim(),
        chatId: String((row && row.chatId) || '').trim(),
        lastMessage: String((row && row.lastMessage) || ''),
        sourceLastMessage: String((row && row.sourceLastMessage) || ''),
        lastFromMe:
          row && (row.lastFromMe === true || row.lastFromMe === false)
            ? row.lastFromMe
            : undefined,
        previewLines: Array.isArray(row && row.previewLines) ? row.previewLines : undefined
      }))
      .filter((row) => row.sessionId && row.chatId);

    if (!items.length) {
      return res.json({ success: true, previews: [] });
    }

    const previews = await enrichAndPersistConversationPreviews(items, {
      lines,
      user: req.user
    });

    res.json({ success: true, lines, previews });
  } catch (error) {
    console.error('[conversations] previews error:', error.message);
    res.status(openwaHttpStatus(error)).json({ success: false, error: error.message });
  }
});

app.post('/api/conversations/reply', async (req, res) => {
  try {
    const session = resolveConfiguredSession(req.body.sessionId);
    if (!session) {
      return res.status(400).json({
        success: false,
        error: 'Indica sessionId de una sesión configurada'
      });
    }

    if (!forbidUnlessControlSessions([session.id], req, res)) {
      return;
    }

    const chatId = String(req.body.chatId || '').trim();
    const text = String(req.body.text || '').trim();
    if (!chatId) {
      return res.status(400).json({ success: false, error: 'chatId es obligatorio' });
    }
    if (!text) {
      return res.status(400).json({ success: false, error: 'El mensaje no puede estar vacío' });
    }
    if (text.length > 4000) {
      return res.status(400).json({
        success: false,
        error: 'El mensaje es demasiado largo (máx. 4000 caracteres)'
      });
    }

    console.log(
      `[conversations] reply sesión=${session.id} chat=${chatId} chars=${text.length}`
    );

    const result = await sendTextMessage(session.openwaSessionId, chatId, text);
    invalidateOpenWACache({
      openwaSessionId: session.openwaSessionId,
      chatId
    });

    // Al contestar manualmente, pausar la IA de ese remitente para no pelear la conversación.
    let aiPaused = null;
    const phone = contactHistory.normalizePhone(String(chatId).replace(/@.*$/, ''));
    if (phone && contactHistory.mongoUriConfigured()) {
      try {
        const pauseResult = await contactHistory.setContactAiPaused(phone, true);
        if (pauseResult.ok) {
          aiPaused = true;
          broadcastEvent('aiControlChanged', {
            sessionId: session.id,
            chatId,
            telefono: phone,
            aiPaused: true,
            reason: 'manual_reply',
            timestamp: new Date().toISOString()
          });
        }
      } catch (err) {
        console.warn('[conversations] no se pudo pausar IA tras reply manual:', err.message);
      }
    }

    res.json({
      success: true,
      sessionId: session.id,
      sessionLabel: session.label || session.id,
      chatId,
      messageId: result.messageId || null,
      aiPaused
    });
  } catch (error) {
    console.error('[conversations] reply error:', error.message);
    res.status(openwaHttpStatus(error)).json({ success: false, error: error.message });
  }
});

app.get('/api/conversations/contact-status', async (req, res) => {
  try {
    const session = resolveConfiguredSession(req.query.sessionId);
    if (!session) {
      return res.status(400).json({
        success: false,
        error: 'Indica sessionId de una sesión configurada'
      });
    }
    if (!forbidUnlessViewSession(session.id, req, res)) return;

    const chatId = String(req.query.chatId || req.query.contactId || '').trim();
    if (!chatId) {
      return res.status(400).json({ success: false, error: 'chatId es obligatorio' });
    }
    if (chatId.endsWith('@g.us')) {
      return res.json({
        success: true,
        sessionId: session.id,
        chatId,
        isGroup: true,
        isBlocked: false,
        aiPaused: false,
        sessionAiEnabled: autoReplyStore.isSessionEnabled(session.id)
      });
    }

    const phone = contactHistory.normalizePhone(String(chatId).replace(/@.*$/, ''));
    let aiPaused = false;
    let knownContact = false;
    let linkedCvId = null;
    if (phone) {
      const contactDoc = await contactHistory.getContactByPhone(phone);
      if (contactDoc) {
        knownContact = true;
        aiPaused = Boolean(contactDoc.aiPaused);
        linkedCvId = contactDoc.cvId || null;
      }
    }

    const matchedCv = publicCvSummary(findCvForPhone(phone, { cvId: linkedCvId }));

    try {
      const contact = await getContact(session.openwaSessionId, chatId);
      res.json({
        success: true,
        sessionId: session.id,
        chatId,
        telefono: phone || null,
        isGroup: false,
        isBlocked: contact.isBlocked,
        name: contact.name,
        knownContact,
        aiPaused,
        linkedCvId,
        matchedCv,
        sessionAiEnabled: autoReplyStore.isSessionEnabled(session.id),
        autoReplyEnabled: Boolean(autoReplyStore.getConfig().enabled)
      });
    } catch (err) {
      res.json({
        success: true,
        sessionId: session.id,
        chatId,
        telefono: phone || null,
        isGroup: false,
        isBlocked: false,
        knownContact,
        aiPaused,
        linkedCvId,
        matchedCv,
        sessionAiEnabled: autoReplyStore.isSessionEnabled(session.id),
        autoReplyEnabled: Boolean(autoReplyStore.getConfig().enabled),
        warning: err.message
      });
    }
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

app.post('/api/conversations/ai-control', async (req, res) => {
  try {
    const session = resolveConfiguredSession(req.body.sessionId);
    if (!session) {
      return res.status(400).json({
        success: false,
        error: 'Indica sessionId de una sesión configurada'
      });
    }
    if (!forbidUnlessControlSessions([session.id], req, res)) return;

    const chatId = String(req.body.chatId || '').trim();
    if (!chatId) {
      return res.status(400).json({ success: false, error: 'chatId es obligatorio' });
    }
    if (chatId.endsWith('@g.us')) {
      return res.status(400).json({
        success: false,
        error: 'La IA no se aplica a grupos'
      });
    }

    if (typeof req.body.aiPaused !== 'boolean') {
      return res.status(400).json({
        success: false,
        error: 'aiPaused (boolean) es obligatorio'
      });
    }

    const phone = contactHistory.normalizePhone(String(chatId).replace(/@.*$/, ''));
    if (!phone) {
      return res.status(400).json({ success: false, error: 'No se pudo obtener el teléfono del chat' });
    }

    const result = await contactHistory.setContactAiPaused(phone, req.body.aiPaused);
    if (!result.ok) {
      return res.status(400).json({ success: false, error: result.error || 'No se pudo actualizar' });
    }

    broadcastEvent('aiControlChanged', {
      sessionId: session.id,
      chatId,
      telefono: phone,
      aiPaused: result.aiPaused,
      reason: 'manual_toggle',
      timestamp: new Date().toISOString()
    });

    res.json({
      success: true,
      sessionId: session.id,
      chatId,
      telefono: phone,
      aiPaused: result.aiPaused
    });
  } catch (error) {
    console.error('[conversations] ai-control error:', error.message);
    res.status(500).json({ success: false, error: error.message });
  }
});

app.get('/api/conversations/:chatId/messages', async (req, res) => {
  try {
    const session = resolveConfiguredSession(req.query.sessionId);
    if (!session) {
      return res.status(400).json({
        success: false,
        error: 'Indica sessionId de una sesión configurada'
      });
    }

    if (!forbidUnlessViewSession(session.id, req, res)) {
      return;
    }

    const chatId = decodeURIComponent(req.params.chatId || '');
    if (!chatId) {
      return res.status(400).json({ success: false, error: 'chatId es obligatorio' });
    }

    const includeMedia =
      req.query.includeMedia === '1' ||
      req.query.includeMedia === 'true' ||
      req.query.includeMedia === true;

    const limit = req.query.limit || 80;
    let messages;
    if (includeMedia) {
      const hydrated = await hydrateChatMedia(session.openwaSessionId, chatId, limit);
      messages = hydrated.messages || [];
    } else {
      messages = await getChatHistory(session.openwaSessionId, chatId, {
        limit,
        includeMedia: false
      });
    }

    // OpenWA suele devolver más antiguos primero; normalizamos a cronológico.
    const sorted = [...messages].sort((a, b) => {
      const ta = a.timestamp || 0;
      const tb = b.timestamp || 0;
      return ta - tb;
    });

    const publicMessages = sorted.map((msg) => {
      const type = String(msg.type || 'text');
      const viewable = isViewableMediaType(type);
      const hasCached =
        Boolean(msg.id) &&
        mediaCacheStore.has(session.openwaSessionId, chatId, msg.id);
      const wantsMedia = viewable || Boolean(msg.hasMedia) || hasCached;
      const mediaUrl =
        wantsMedia && msg.id
          ? `/api/conversations/${encodeURIComponent(chatId)}/messages/${encodeURIComponent(String(msg.id))}/media?sessionId=${encodeURIComponent(session.id)}`
          : null;
      const body = String(msg.body || '');
      const placeholder = `[${type}]`;
      const cleanBody =
        viewable && body.toLowerCase() === placeholder.toLowerCase() ? '' : body;

      return {
        id: msg.id,
        chatId: msg.chatId || chatId,
        from: msg.from,
        to: msg.to,
        body: cleanBody,
        type,
        fromMe: msg.fromMe,
        isGroup: msg.isGroup,
        timestamp: msg.timestamp,
        contactName: msg.contactName,
        hasMedia: wantsMedia,
        mimetype: (msg.media && msg.media.mimetype) || null,
        mediaUrl
      };
    });

    res.json({
      success: true,
      sessionId: session.id,
      sessionLabel: session.label || session.id,
      openwaSessionId: session.openwaSessionId,
      chatId,
      includeMedia: Boolean(includeMedia),
      messages: publicMessages
    });
  } catch (error) {
    res.status(openwaHttpStatus(error)).json({ success: false, error: error.message });
  }
});

app.get('/api/conversations/:chatId/messages/:messageId/media', async (req, res) => {
  try {
    const session = resolveConfiguredSession(req.query.sessionId);
    if (!session) {
      return res.status(400).json({
        success: false,
        error: 'Indica sessionId de una sesión configurada'
      });
    }

    if (!forbidUnlessViewSession(session.id, req, res)) {
      return;
    }

    const chatId = decodeURIComponent(req.params.chatId || '');
    const messageId = decodeURIComponent(req.params.messageId || '');
    if (!chatId || !messageId) {
      return res.status(400).json({ success: false, error: 'chatId y messageId son obligatorios' });
    }

    const hit = await resolveMessageMedia(
      session.openwaSessionId,
      chatId,
      messageId,
      downloadMessageMedia
    );

    if (!hit || !hit.buffer || !hit.buffer.length) {
      return res.status(404).json({
        success: false,
        error: 'Media no disponible (puede haber expirado en WhatsApp)'
      });
    }

    res.setHeader('Content-Type', hit.mimetype || 'application/octet-stream');
    res.setHeader('Cache-Control', 'private, max-age=300');
    res.send(hit.buffer);
  } catch (error) {
    res.status(openwaHttpStatus(error)).json({ success: false, error: error.message });
  }
});

app.post('/api/conversations/mark-read', async (req, res) => {
  try {
    const session = resolveConfiguredSession(req.body.sessionId);
    if (!session) {
      return res.status(400).json({
        success: false,
        error: 'Indica sessionId de una sesión configurada'
      });
    }

    if (!forbidUnlessViewSession(session.id, req, res)) {
      return;
    }

    const chatId = String(req.body.chatId || '').trim();
    if (!chatId) {
      return res.status(400).json({ success: false, error: 'chatId es obligatorio' });
    }

    const result = await markChatRead(session.openwaSessionId, chatId);
    res.json({
      success: true,
      sessionId: session.id,
      chatId,
      marked: Boolean(result.success)
    });
  } catch (error) {
    console.error('[conversations] mark-read error:', error.message);
    res.status(openwaHttpStatus(error)).json({ success: false, error: error.message });
  }
});

app.post('/api/conversations/edit-message', async (req, res) => {
  try {
    const session = resolveConfiguredSession(req.body.sessionId);
    if (!session) {
      return res.status(400).json({
        success: false,
        error: 'Indica sessionId de una sesión configurada'
      });
    }
    if (!forbidUnlessControlSessions([session.id], req, res)) return;

    const chatId = String(req.body.chatId || '').trim();
    const messageId = String(req.body.messageId || '').trim();
    const body = String(req.body.body || req.body.text || '').trim();
    if (!chatId) return res.status(400).json({ success: false, error: 'chatId es obligatorio' });
    if (!messageId) {
      return res.status(400).json({ success: false, error: 'messageId es obligatorio' });
    }
    if (!body) {
      return res.status(400).json({ success: false, error: 'El mensaje no puede estar vacío' });
    }

    const result = await editMessage(session.openwaSessionId, { chatId, messageId, body });
    invalidateOpenWACache({
      openwaSessionId: session.openwaSessionId,
      chatId
    });
    res.json({
      success: true,
      sessionId: session.id,
      chatId,
      messageId: result.messageId,
      body
    });
  } catch (error) {
    console.error('[conversations] edit error:', error.message);
    res.status(openwaHttpStatus(error)).json({ success: false, error: error.message });
  }
});

app.post('/api/conversations/delete-message', async (req, res) => {
  try {
    const session = resolveConfiguredSession(req.body.sessionId);
    if (!session) {
      return res.status(400).json({
        success: false,
        error: 'Indica sessionId de una sesión configurada'
      });
    }
    if (!forbidUnlessControlSessions([session.id], req, res)) return;

    const chatId = String(req.body.chatId || '').trim();
    const messageId = String(req.body.messageId || '').trim();
    if (!chatId) return res.status(400).json({ success: false, error: 'chatId es obligatorio' });
    if (!messageId) {
      return res.status(400).json({ success: false, error: 'messageId es obligatorio' });
    }

    await deleteMessage(session.openwaSessionId, {
      chatId,
      messageId,
      forEveryone: req.body.forEveryone !== false
    });
    invalidateOpenWACache({
      openwaSessionId: session.openwaSessionId,
      chatId
    });
    res.json({ success: true, sessionId: session.id, chatId, messageId });
  } catch (error) {
    console.error('[conversations] delete error:', error.message);
    res.status(openwaHttpStatus(error)).json({ success: false, error: error.message });
  }
});

app.post('/api/conversations/delete-chat', async (req, res) => {
  try {
    const session = resolveConfiguredSession(req.body.sessionId);
    if (!session) {
      return res.status(400).json({
        success: false,
        error: 'Indica sessionId de una sesión configurada'
      });
    }
    if (!forbidUnlessControlSessions([session.id], req, res)) return;

    const chatId = String(req.body.chatId || '').trim();
    if (!chatId) {
      return res.status(400).json({ success: false, error: 'chatId es obligatorio' });
    }

    const result = await deleteChat(session.openwaSessionId, chatId);
    invalidateOpenWACache({
      openwaSessionId: session.openwaSessionId,
      chatId
    });

    const phone = contactHistory.normalizePhone(String(chatId).replace(/@.*$/, ''));
    let aiPaused = null;
    let inboxRemoved = 0;

    if (phone) {
      agendaOfferStore.clearOffer(phone);
      const inbox = incomingMessagesStore.removeByChatOrPhone({ chatId, telefono: phone });
      inboxRemoved = inbox.removed || 0;

      // Evita que la IA siga contestando tras limpiar el hilo
      if (contactHistory.mongoUriConfigured() && req.body.pauseAi !== false) {
        try {
          const pauseResult = await contactHistory.setContactAiPaused(phone, true);
          if (pauseResult.ok) aiPaused = true;
        } catch (err) {
          console.warn('[conversations] delete-chat aiPaused:', err.message);
        }
      }
    } else {
      const inbox = incomingMessagesStore.removeByChatOrPhone({ chatId });
      inboxRemoved = inbox.removed || 0;
    }

    res.json({
      success: true,
      sessionId: session.id,
      chatId,
      aiPaused,
      inboxRemoved,
      message: result.message
    });
  } catch (error) {
    console.error('[conversations] delete-chat error:', error.message);
    res.status(openwaHttpStatus(error)).json({ success: false, error: error.message });
  }
});

app.post('/api/conversations/block', async (req, res) => {
  try {
    const session = resolveConfiguredSession(req.body.sessionId);
    if (!session) {
      return res.status(400).json({
        success: false,
        error: 'Indica sessionId de una sesión configurada'
      });
    }
    if (!forbidUnlessControlSessions([session.id], req, res)) return;

    const chatId = String(req.body.chatId || req.body.contactId || '').trim();
    if (!chatId) {
      return res.status(400).json({ success: false, error: 'chatId es obligatorio' });
    }
    if (chatId.endsWith('@g.us')) {
      return res.status(400).json({
        success: false,
        error: 'No se pueden bloquear grupos desde aquí'
      });
    }

    const result = await blockContact(session.openwaSessionId, chatId);
    res.json({
      success: true,
      sessionId: session.id,
      chatId,
      isBlocked: true,
      message: result.message
    });
  } catch (error) {
    console.error('[conversations] block error:', error.message);
    res.status(500).json({ success: false, error: error.message });
  }
});

app.post('/api/conversations/unblock', async (req, res) => {
  try {
    const session = resolveConfiguredSession(req.body.sessionId);
    if (!session) {
      return res.status(400).json({
        success: false,
        error: 'Indica sessionId de una sesión configurada'
      });
    }
    if (!forbidUnlessControlSessions([session.id], req, res)) return;

    const chatId = String(req.body.chatId || req.body.contactId || '').trim();
    if (!chatId) {
      return res.status(400).json({ success: false, error: 'chatId es obligatorio' });
    }

    const result = await unblockContact(session.openwaSessionId, chatId);
    res.json({
      success: true,
      sessionId: session.id,
      chatId,
      isBlocked: false,
      message: result.message
    });
  } catch (error) {
    console.error('[conversations] unblock error:', error.message);
    res.status(500).json({ success: false, error: error.message });
  }
});

app.get('/api/auto-reply/status', (req, res) => {
  try {
    res.json({ success: true, ...autoReplyService.getStatus() });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

app.get('/api/auto-reply/config', (req, res) => {
  try {
    res.json({ success: true, config: autoReplyStore.getPublicConfig() });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

app.patch('/api/auto-reply/sessions', (req, res) => {
  try {
    const sessionId = String(req.body.sessionId || '').trim();
    if (!sessionId) {
      return res.status(400).json({ success: false, error: 'sessionId es obligatorio' });
    }
    if (typeof req.body.enabled !== 'boolean') {
      return res.status(400).json({
        success: false,
        error: 'enabled (boolean) es obligatorio'
      });
    }

    const session = sessionsStore.getSession(sessionId);
    if (!session) {
      return res.status(404).json({
        success: false,
        error: `Sesión no encontrada: ${sessionId}`
      });
    }
    if (!forbidUnlessControlSessions([sessionId], req, res)) return;

    const allSessionIds = sessionsStore.getAllSessions().map((s) => s.id);
    const result = autoReplyStore.setSessionEnabled(
      sessionId,
      req.body.enabled,
      allSessionIds
    );

    res.json({
      success: true,
      config: result.config,
      sessionId: result.sessionId,
      sessionEnabled: result.sessionEnabled
    });
  } catch (error) {
    res.status(400).json({ success: false, error: error.message });
  }
});

app.put('/api/auto-reply/config', requireSuper, (req, res) => {
  try {
    const config = autoReplyStore.updateConfig({
      enabled: req.body.enabled,
      basePrompt: req.body.basePrompt,
      rules: req.body.rules,
      enabledSessionIds: req.body.enabledSessionIds
    });
    res.json({ success: true, config });
  } catch (error) {
    res.status(400).json({ success: false, error: error.message });
  }
});

app.post('/api/auto-reply/activate', requireSuper, async (req, res) => {
  try {
    console.log(`[auto-reply] POST /activate by ${req.user?.username || 'unknown'}`);
    const status = autoReplyService.getStatus();
    if (!status.canListen) {
      return res.status(400).json({
        success: false,
        error:
          'No se puede activar: configura WEBHOOK_PUBLIC_URL y al menos una sesión. Sin URL pública OpenWA no puede enviar los mensajes a esta página.'
      });
    }
    const result = await autoReplyService.activateWebhooks();
    const ok = (result.results || []).filter((r) => r.success).length;
    const fail = (result.results || []).filter((r) => !r.success).length;
    console.log(`[auto-reply] POST /activate response ok=${ok} fail=${fail}`);
    res.json({ success: true, ...result });
  } catch (error) {
    console.error(`[auto-reply] POST /activate error: ${error.message}`);
    res.status(400).json({ success: false, error: error.message });
  }
});

app.post('/api/auto-reply/deactivate', requireSuper, async (req, res) => {
  try {
    console.log(`[auto-reply] POST /deactivate by ${req.user?.username || 'unknown'}`);
    const results = await autoReplyService.deactivateWebhooks();
    console.log(`[auto-reply] POST /deactivate done count=${results.length}`);
    res.json({ success: true, results });
  } catch (error) {
    console.error(`[auto-reply] POST /deactivate error: ${error.message}`);
    res.status(400).json({ success: false, error: error.message });
  }
});

app.post('/api/auto-reply/test', requireSuper, async (req, res) => {
  try {
    const openwaSessionId =
      req.body.openwaSessionId ||
      (sessionsStore.getAllSessions()[0] && sessionsStore.getAllSessions()[0].openwaSessionId);
    if (!openwaSessionId) {
      return res.status(400).json({ success: false, error: 'No hay sesión OpenWA configurada' });
    }

    const telefono = String(req.body.telefono || req.body.phone || '').trim();
    const normalizedPhone = contactHistory.normalizePhone(telefono);
    if (!normalizedPhone) {
      return res.status(400).json({ success: false, error: 'telefono es obligatorio para la prueba' });
    }

    const known = await contactHistory.isKnownContact(normalizedPhone);
    if (!known) {
      return res.status(400).json({
        success: false,
        error: 'El teléfono no está en el historial de contactos. Envía un mensaje masivo primero.'
      });
    }

    const chatId = req.body.chatId || formatPhoneToChatId(normalizedPhone);
    const incomingBody = String(req.body.message || req.body.body || 'Hola, me interesa').trim();

    const prevEnabled = autoReplyStore.getConfig().enabled;
    autoReplyStore.updateConfig({ enabled: true });

    const testPayload = {
      event: 'message.received',
      sessionId: openwaSessionId,
      data: {
        id: `test_${Date.now()}`,
        from: chatId,
        body: incomingBody,
        fromMe: false,
        isGroup: false
      }
    };

    autoReplyService.captureIncomingMessage({
      payload: testPayload,
      broadcastEvent,
      idempotencyKey: `test_inbox_${Date.now()}`
    });

    const result = await autoReplyService.handleIncomingWebhook({
      payload: testPayload,
      idempotencyKey: `test_${Date.now()}`,
      broadcastEvent,
      getCvContext: getCvContextForPhone,
      getLeadCv: getLeadCvForPhone,
      testMode: true
    });

    if (!prevEnabled) {
      autoReplyStore.updateConfig({ enabled: false });
    }

    res.json({ success: true, result });
  } catch (error) {
    res.status(400).json({ success: false, error: error.message });
  }
});

// Ruta para Server-Sent Events (notificaciones en tiempo real)
app.get('/events', (req, res) => {
  res.setHeader('Content-Type', 'text/event-stream; charset=utf-8');
  res.setHeader('Cache-Control', 'no-cache, no-transform');
  res.setHeader('Connection', 'keep-alive');
  // Evita que nginx bufferice el stream (causa ERR_INCOMPLETE_CHUNKED_ENCODING).
  res.setHeader('X-Accel-Buffering', 'no');
  res.setHeader('Access-Control-Allow-Origin', '*');
  if (typeof res.flushHeaders === 'function') {
    res.flushHeaders();
  }

  eventClients.push(res);
  ensureSseHeartbeat();

  try {
    res.write(`: connected ${Date.now()}\n\n`);
  } catch {
    // ignore
  }

  const cleanup = () => {
    const index = eventClients.indexOf(res);
    if (index > -1) {
      eventClients.splice(index, 1);
    }
  };

  req.on('close', cleanup);
  req.on('aborted', cleanup);
  res.on('error', cleanup);
});

// Servir archivos estáticos después de todas las rutas API
app.use(express.static(path.join(__dirname, 'public')));

// Middleware de manejo de errores
app.use((error, req, res, next) => {
  if (error instanceof multer.MulterError) {
    if (error.code === 'LIMIT_FILE_SIZE') {
      return res.status(400).json({
        error: 'Archivo demasiado grande. Máximo 10MB por archivo.'
      });
    }
    if (error.code === 'LIMIT_FILE_COUNT') {
      return res.status(400).json({
        error: 'Demasiados archivos. Máximo 100 archivos por carga.'
      });
    }
  }

  console.error('Error no manejado:', error);
  res.status(500).json({
    error: 'Error interno del servidor',
    message: error.message
  });
});

// Cerrar servicios locales al cerrar el servidor
process.on('SIGINT', async () => {
  console.log('\nCerrando servidor...');
  for (const [sessionId, service] of whatsappServices) {
    await service.close();
    console.log(`Sesión ${sessionId} desvinculada`);
  }
  process.exit(0);
});

process.on('SIGTERM', async () => {
  console.log('\nCerrando servidor...');
  for (const [sessionId, service] of whatsappServices) {
    await service.close();
    console.log(`Sesión ${sessionId} desvinculada`);
  }
  process.exit(0);
});

// Iniciar servidor
sessionsStore.migrateFromEnvIfEmpty();
{
  const recovered = sendQueueStore.recoverOrphanSending();
  if (recovered > 0) {
    console.log(
      `⚠️ Cola: ${recovered} lote(s) en sending sin job vivo → marcados como sent (huérfanos)`
    );
  }
}
armSendQueueTimer();

app.listen(PORT, () => {
  console.log(`🚀 Servidor iniciado en http://localhost:${PORT}`);
  console.log(`📁 Interfaz web disponible en http://localhost:${PORT}`);
  console.log(`📋 Sesiones WhatsApp: data/sessions.json (${sessionsStore.getAllSessions().length} configurada(s))`);
  console.log(`📋 Asegúrate de configurar DEEPSEEK_API_KEY y OPENWA_API_KEY en el archivo .env`);
  if (isAuthEnabled()) {
    console.log('🔐 Autenticación activa (AUTH_USERNAME / AUTH_PASSWORD en .env)');
  } else {
    console.log('⚠️  Autenticación desactivada: define AUTH_USERNAME y AUTH_PASSWORD en .env para proteger la interfaz');
  }
});

module.exports = app;
