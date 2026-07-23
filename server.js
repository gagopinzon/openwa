const express = require('express');
const multer = require('multer');
const path = require('path');
const fs = require('fs');
require('dotenv').config();

const { extractTextFromPDF, extractCVData } = require('./pdfProcessor');
const { generateBulkMessages } = require('./aiService');
const WhatsAppService = require('./openwaWhatsAppService');
const { sendRoundRobinBulk, ROUND_ROBIN_CONTROL_ID } = WhatsAppService;
const { previewDistribution } = require('./sessionDistribution');
const sessionsStore = require('./sessionsStore');
const {
  getSessionStatus,
  listOpenWASessions,
  isConnectedStatus,
  extractProfileName,
  formatPhoneToChatId,
  listChats,
  getChatHistory
} = require('./openwaClient');
const contactHistory = require('./contactHistoryStore');
const autoReplyService = require('./autoReplyService');
const autoReplyStore = require('./autoReplyStore');
const incomingMessagesStore = require('./incomingMessagesStore');
const {
  isAuthEnabled,
  authMiddleware,
  validateCredentials,
  createSessionToken,
  isAuthenticated,
  setAuthCookie,
  clearAuthCookie
} = require('./auth');

const app = express();
const PORT = process.env.PORT || 3445;

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

// Almacenar datos de CVs en memoria
let cvsData = [];
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

/** @type {{ inProgress: boolean, total: number, sessionIds: string[], startedAt: number|null, completedAt: number|null, error: string|null, message: string|null, results: Array|null, skippedAlreadyContacted: Array, testMode: boolean }} */
let lastSendJob = {
  inProgress: false,
  total: 0,
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
        success: progressData.success
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
  testMode
}) {
  const controlId = getBulkControlId(sessionIds);
  const N = sessionIds.length;

  lastSendJob.inProgress = true;
  lastSendJob.total = finalCvsToSend.length;
  lastSendJob.sessionIds = sessionIds;
  lastSendJob.startedAt = Date.now();
  lastSendJob.completedAt = null;
  lastSendJob.error = null;
  lastSendJob.message = null;
  lastSendJob.results = null;
  lastSendJob.skippedAlreadyContacted = skippedAlreadyContacted;
  lastSendJob.testMode = testMode;

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
      });

      resetBulkControlState(controlId, sessionIds);
      lastSendJob.results = results;
      lastSendJob.message = `Envío completado: ${results.filter((r) => r.success).length}/${results.length} mensajes enviados (modo prueba)`;
    } else {
      console.log(`📱 Envío paralelo con ${N} sesión(es): ${sessionIds.join(', ')}`);

      const services = sessionIds.map((sId) => {
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

      const servicesBySessionId = new Map(sessionIds.map((sId, i) => [sId, services[i]]));
      const contactsToSend = finalCvsToSend.map((cv) => ({
        nombre: cv.nombre,
        telefono: cv.telefono,
        saludo: cv.saludo,
        mensajeIA: cv.mensajeIA
      }));

      const distribution = previewDistribution(
        sessionIds,
        sessionWeights,
        contactsToSend.length
      );
      const distributionLog = sessionIds.map((sId, i) => {
        const pct = Math.round(distribution.proportions[i] * 1000) / 10;
        return `${sId}: ${distribution.counts[i]} (${pct}%)`;
      });
      console.log(`📊 Distribución ponderada → ${distributionLog.join(', ')}`);

      initSessionSendingState(controlId);
      for (const sId of sessionIds) {
        initSessionSendingState(sId);
      }

      const { onProgress, onWaitProgressBySession } = buildSendProgressHandlers(controlId);
      const checkControlsBySession = (sId) => makeSessionCheckControls(sId, controlId);

      let results;
      try {
        if (N === 1) {
          const singleCheck = makeSessionCheckControls(sessionIds[0], null);
          const onWaitProgress = onWaitProgressBySession(sessionIds[0]);
          results = await services[0].sendBulkMessages(
            contactsToSend,
            2,
            onProgress,
            singleCheck,
            mongoRecordHook,
            onWaitProgress
          );
        } else {
          results = await sendRoundRobinBulk(
            servicesBySessionId,
            sessionIds,
            contactsToSend,
            onProgress,
            checkControlsBySession,
            mongoRecordHook,
            onWaitProgressBySession,
            sessionWeights
          );
        }
      } finally {
        resetBulkControlState(controlId, sessionIds);
      }

      lastSendJob.results = results;
      lastSendJob.message = `Envío completado: ${results.filter((r) => r.success).length}/${results.length} mensajes enviados`;
    }

    lastSendJob.completedAt = Date.now();
    console.log(`Envío completado. ${lastSendJob.message}`);

    broadcastEvent('sendComplete', {
      message: lastSendJob.message,
      total: finalCvsToSend.length,
      successCount: lastSendJob.results.filter((r) => r.success).length,
      testMode
    });
  } catch (error) {
    console.error('Error en envío en segundo plano:', error);
    lastSendJob.error = error.message;
    resetBulkControlState(controlId, sessionIds);
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
    console.log(`👋 Saludo: ${cv.saludo || '(auto)'}`);
    console.log(`📱 Mensaje: ${mensajePreview}`);
    console.log('🧪 Simulando pausa 2-3s entre saludo y mensaje principal...');

    // Simular éxito en 90% de los casos
    const success = Math.random() > 0.1;

    const result = {
      index: i,
      nombre: cv.nombre,
      telefono: cv.telefono,
      saludo: cv.saludo,
      mensajeIA: cv.mensajeIA,
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
        success: success
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

  if (!validateCredentials(username, password)) {
    return res.status(401).json({ success: false, error: 'Usuario o contraseña incorrectos' });
  }

  setAuthCookie(res, createSessionToken());
  res.json({ success: true });
});

app.post('/api/auth/logout', (req, res) => {
  clearAuthCookie(res);
  res.json({ success: true });
});

app.get('/api/auth/status', (req, res) => {
  res.json({
    success: true,
    authEnabled: isAuthEnabled(),
    authenticated: isAuthenticated(req)
  });
});

app.use(authMiddleware);

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

    // Limpiar datos anteriores
    cvsData = [];

    // Procesar cada archivo PDF
    for (let i = 0; i < req.files.length; i++) {
      const file = req.files[i];
      console.log(`Procesando archivo ${i + 1}/${req.files.length}: ${file.originalname}`);

      try {
        // Extraer texto del PDF
        const text = await extractTextFromPDF(file.buffer);

        // Extraer datos estructurados
        const cvData = extractCVData(text);

        // Agregar información del archivo
        const processedCV = {
          ...cvData,
          archivoOriginal: file.originalname,
          saludo: '',
          mensajeIA: '', // Se llenará después
          procesado: true
        };

        cvsData.push(processedCV);

      } catch (error) {
        console.error(`Error procesando ${file.originalname}:`, error.message);
        cvsData.push({
          nombre: 'Error al procesar',
          telefono: 'N/A',
          experiencia: 'Error al extraer texto del PDF',
          archivoOriginal: file.originalname,
          saludo: '',
          mensajeIA: '',
          procesado: false,
          error: error.message
        });
      }
    }

    console.log(`Procesamiento completado. ${cvsData.length} CVs procesados.`);

    res.json({
      success: true,
      message: `Se procesaron ${cvsData.length} CVs exitosamente`,
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

    const validCVs = cvsData.filter(cv => cv.procesado && cv.nombre !== 'Error al procesar');

    if (validCVs.length === 0) {
      return res.status(400).json({
        error: 'No hay CVs válidos para generar mensajes'
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
      message: `Generación iniciada para ${validCVs.length} CVs`
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

        console.log(`Mensajes generados exitosamente para ${cvsWithMessages.length} CVs`);

        generationState.inProgress = false;
        generationState.completedAt = Date.now();
        generationState.current = validCVs.length;

        broadcastEvent('generationComplete', {
          total: cvsWithMessages.length,
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

// Ruta para obtener configuración del sistema
app.get('/config', (req, res) => {
  res.json({
    success: true,
    testMode: TEST_MODE,
    whatsappProvider: 'openwa',
    sessions: sessionsStore.getAllSessions(),
    autoReply: autoReplyService.getStatus(),
    message: TEST_MODE
      ? 'Sistema en modo de prueba - los mensajes se simularán'
      : 'Sistema en modo producción - se enviarán mensajes reales vía OpenWA'
  });
});

// --- Gestión de sesiones WhatsApp (persistidas en data/sessions.json) ---

app.get('/api/sessions', (req, res) => {
  try {
    res.json({ success: true, sessions: sessionsStore.getAllSessions() });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

app.post('/api/sessions', async (req, res) => {
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

app.put('/api/sessions/:id', (req, res) => {
  try {
    const session = sessionsStore.updateSession(req.params.id, {
      label: req.body.label,
      openwaSessionId: req.body.openwaSessionId,
      senderName: req.body.senderName
    });
    res.json({ success: true, session });
  } catch (error) {
    res.status(400).json({ success: false, error: error.message });
  }
});

app.post('/api/sessions/:id/sync-sender-name', async (req, res) => {
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

app.delete('/api/sessions/:id', (req, res) => {
  try {
    const logicalId = req.params.id;
    sessionsStore.removeSession(logicalId);
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

app.get('/api/openwa/sessions', async (req, res) => {
  try {
    const status = req.query.status ? String(req.query.status) : undefined;
    const sessions = await listOpenWASessions({ status, limit: 100 });
    res.json({ success: true, sessions });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

app.post('/api/sessions/import-connected', async (req, res) => {
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

// Ruta para enviar mensajes por WhatsApp
app.post('/send-whatsapp', async (req, res) => {
  try {
    // Si el cliente envía CVs editados, usar esos; si no, usar los del servidor
    let cvsToProcess = cvsData;
    if (req.body && req.body.cvs && Array.isArray(req.body.cvs)) {
      console.log('📝 Recibiendo CVs editados del cliente...');
      cvsToProcess = req.body.cvs;
      // Actualizar también cvsData en el servidor con los mensajes editados
      cvsToProcess.forEach(editedCv => {
        const index = cvsData.findIndex(cv => cv.archivoOriginal === editedCv.archivoOriginal);
        if (index !== -1) {
          if (editedCv.saludo != null) cvsData[index].saludo = editedCv.saludo;
          cvsData[index].mensajeIA = editedCv.mensajeIA;
        }
      });
    }

    if (cvsToProcess.length === 0) {
      return res.status(400).json({
        error: 'No hay CVs procesados. Sube archivos PDF primero.'
      });
    }

    // Filtrar CVs que tienen mensaje de IA generado
    const cvsToSend = cvsToProcess.filter(cv =>
      cv.procesado &&
      cv.mensajeIA &&
      cv.mensajeIA.trim() !== '' &&
      cv.telefono !== 'No encontrado'
    );

    if (cvsToSend.length === 0) {
      return res.status(400).json({
        error: 'No hay CVs con mensajes de IA generados y números de teléfono válidos'
      });
    }

    // Deduplicar por teléfono - mantener solo el primer CV de cada número
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
      console.log(`⚠️ Se encontraron ${duplicates.length} CVs duplicados (mismo teléfono). Se enviará solo un mensaje por número.`);
      duplicates.forEach(dup => {
        console.log(`  - Duplicado: ${dup.nombre} (${dup.telefono}) - Archivo: ${dup.archivoOriginal}`);
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
        console.log(`📇 ${skippedAlreadyContacted.length} contacto(s) ya en historial; no se reenvían.`);
      }
    }

    const mongoRecordHook =
      !TEST_MODE && contactHistory.mongoUriConfigured()
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
                openwaSessionId
              })
              .catch((err) => console.error('contactHistory:', err.message));
          }
        : null;

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

    if (isAnySendingInProgress()) {
      return res.status(409).json({
        error: 'Ya hay un envío de mensajes en curso',
        sendJob: {
          total: lastSendJob.total,
          sessionIds: lastSendJob.sessionIds
        }
      });
    }

    const configuredIds = getConfiguredSessionIds();
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

    const sessionIds = TEST_MODE
      ? (selectedSessions && selectedSessions.length > 0 ? selectedSessions : ['default'])
      : selectedSessions;

    console.log(`Iniciando envío de ${finalCvsToSend.length} mensajes por WhatsApp (${duplicates.length} duplicados eliminados)...`);
    console.log(`Modo de prueba: ${TEST_MODE ? 'ACTIVADO (simulando envíos)' : 'DESACTIVADO (enviando real)'}`);

    const sessionWeights =
      req.body.sessionWeights && typeof req.body.sessionWeights === 'object'
        ? req.body.sessionWeights
        : null;

    res.status(202).json({
      success: true,
      started: true,
      total: finalCvsToSend.length,
      sessionIds,
      skippedAlreadyContacted,
      testMode: TEST_MODE,
      message: `Envío iniciado para ${finalCvsToSend.length} mensajes`
    });

    runWhatsAppSendJob({
      finalCvsToSend,
      sessionIds,
      sessionWeights,
      skippedAlreadyContacted,
      mongoRecordHook,
      testMode: TEST_MODE
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
    const configuredIds = getConfiguredSessionIds();
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
  console.log('Datos de CVs limpiados');

  res.json({
    success: true,
    message: 'Datos limpiados correctamente'
  });
});

// Ruta para pausar envíos (solo en producción)
app.post('/pause-sending', (req, res) => {
  if (TEST_MODE) {
    return res.status(400).json({
      error: 'No se puede pausar en modo de prueba'
    });
  }

  const sessionId = req.body.sessionId || 'default';

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
  const norm = contactHistory.normalizePhone(phone);
  const cv = cvsData.find((c) => contactHistory.normalizePhone(c.telefono) === norm);
  if (!cv) return null;
  const exp = String(cv.experiencia || '').slice(0, 500);
  return `Nombre: ${cv.nombre}\nExperiencia: ${exp}`;
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
      testMode: TEST_MODE
    });

    if (inboxRecord && replyResult) {
      incomingMessagesStore.update(inboxRecord.id, {
        autoReplyHandled: Boolean(replyResult.handled),
        autoReplyReason: replyResult.handled ? 'replied' : replyResult.reason || null,
        replyMessage: replyResult.replyMessage || null
      });
    }
  } catch (err) {
    console.error('Webhook OpenWA error:', err.message);
  }
});

app.get('/api/incoming-messages', (req, res) => {
  try {
    const messages = incomingMessagesStore.list({
      limit: req.query.limit,
      sessionId: req.query.sessionId
    });
    res.json({ success: true, messages, total: messages.length });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

app.delete('/api/incoming-messages', (req, res) => {
  try {
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

app.get('/api/conversations', async (req, res) => {
  try {
    const session = resolveConfiguredSession(req.query.sessionId);
    if (!session) {
      return res.status(400).json({
        success: false,
        error: 'Indica sessionId de una sesión configurada'
      });
    }

    const limit = req.query.limit || 100;
    const offset = req.query.offset || 0;
    const includeGroups = String(req.query.includeGroups || '') === '1';

    let chats = await listChats(session.openwaSessionId, { limit, offset });
    if (!includeGroups) {
      chats = chats.filter((c) => !c.isGroup);
    }

    res.json({
      success: true,
      sessionId: session.id,
      openwaSessionId: session.openwaSessionId,
      label: session.label,
      chats
    });
  } catch (error) {
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

    const chatId = decodeURIComponent(req.params.chatId || '');
    if (!chatId) {
      return res.status(400).json({ success: false, error: 'chatId es obligatorio' });
    }

    const messages = await getChatHistory(session.openwaSessionId, chatId, {
      limit: req.query.limit || 50
    });

    // OpenWA suele devolver más antiguos primero; normalizamos a cronológico.
    const sorted = [...messages].sort((a, b) => {
      const ta = a.timestamp || 0;
      const tb = b.timestamp || 0;
      return ta - tb;
    });

    res.json({
      success: true,
      sessionId: session.id,
      openwaSessionId: session.openwaSessionId,
      chatId,
      messages: sorted
    });
  } catch (error) {
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

app.put('/api/auto-reply/config', (req, res) => {
  try {
    const config = autoReplyStore.updateConfig({
      enabled: req.body.enabled,
      basePrompt: req.body.basePrompt,
      rules: req.body.rules
    });
    res.json({ success: true, config });
  } catch (error) {
    res.status(400).json({ success: false, error: error.message });
  }
});

app.post('/api/auto-reply/activate', async (req, res) => {
  try {
    const status = autoReplyService.getStatus();
    if (!status.canListen) {
      return res.status(400).json({
        success: false,
        error:
          'No se puede activar: configura WEBHOOK_PUBLIC_URL y al menos una sesión. Sin URL pública OpenWA no puede enviar los mensajes a esta página.'
      });
    }
    const result = await autoReplyService.activateWebhooks();
    res.json({ success: true, ...result });
  } catch (error) {
    res.status(400).json({ success: false, error: error.message });
  }
});

app.post('/api/auto-reply/deactivate', async (req, res) => {
  try {
    const results = await autoReplyService.deactivateWebhooks();
    res.json({ success: true, results });
  } catch (error) {
    res.status(400).json({ success: false, error: error.message });
  }
});

app.post('/api/auto-reply/test', async (req, res) => {
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
