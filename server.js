const express = require('express');
const multer = require('multer');
const path = require('path');
const fs = require('fs');
require('dotenv').config();

const { extractTextFromPDF, extractCVData } = require('./pdfProcessor');
const { generateBulkMessages } = require('./aiService');
const WhatsAppService = require('./openwaWhatsAppService');
const { sendRoundRobinBulk, ROUND_ROBIN_CONTROL_ID } = WhatsAppService;
const sessionsStore = require('./sessionsStore');
const {
  getSessionStatus,
  listOpenWASessions,
  isConnectedStatus
} = require('./openwaClient');
const contactHistory = require('./contactHistoryStore');

const app = express();
const PORT = process.env.PORT || 3445;

// Middleware
app.use(express.json({ limit: '1mb' }));
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
    console.log(`📱 Mensaje: ${mensajePreview}`);

    // Simular éxito en 90% de los casos
    const success = Math.random() > 0.1;

    const result = {
      index: i,
      nombre: cv.nombre,
      telefono: cv.telefono,
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

// Ruta para generar mensajes con IA
app.post('/generate-messages', async (req, res) => {
  try {
    if (cvsData.length === 0) {
      return res.status(400).json({
        error: 'No hay CVs procesados. Sube archivos PDF primero.'
      });
    }

    console.log(`Generando mensajes de IA para ${cvsData.length} CVs...`);

    // Filtrar solo CVs procesados exitosamente
    const validCVs = cvsData.filter(cv => cv.procesado && cv.nombre !== 'Error al procesar');

    if (validCVs.length === 0) {
      return res.status(400).json({
        error: 'No hay CVs válidos para generar mensajes'
      });
    }

    // Generar mensajes con IA
    const cvsWithMessages = await generateBulkMessages(validCVs);

    // Actualizar los datos en memoria
    cvsWithMessages.forEach(cvWithMessage => {
      const index = cvsData.findIndex(cv => cv.archivoOriginal === cvWithMessage.archivoOriginal);
      if (index !== -1) {
        cvsData[index].mensajeIA = cvWithMessage.mensajeIA;
      }
    });

    console.log(`Mensajes generados exitosamente para ${cvsWithMessages.length} CVs`);

    res.json({
      success: true,
      message: `Se generaron mensajes de IA para ${cvsWithMessages.length} CVs`,
      cvs: cvsData
    });

  } catch (error) {
    console.error('Error generando mensajes:', error);
    res.status(500).json({
      error: 'Error generando mensajes con IA',
      message: error.message
    });
  }
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

app.post('/api/sessions', (req, res) => {
  try {
    const session = sessionsStore.addSession({
      openwaSessionId: req.body.openwaSessionId,
      label: req.body.label
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
      openwaSessionId: req.body.openwaSessionId
    });
    res.json({ success: true, session });
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
            contactHistory
              .recordSuccessfulContact({
                normalizedPhone: contactHistory.normalizePhone(row.telefono),
                name: row.nombre
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

    console.log(`Iniciando envío de ${finalCvsToSend.length} mensajes por WhatsApp (${duplicates.length} duplicados eliminados)...`);
    console.log(`Modo de prueba: ${TEST_MODE ? 'ACTIVADO (simulando envíos)' : 'DESACTIVADO (enviando real)'}`);

    if (TEST_MODE) {
      const results = await simulateWhatsAppSending(finalCvsToSend);
      return res.status(200).json({
        success: true,
        message: `Envío completado: ${results.filter((r) => r.success).length}/${results.length} mensajes enviados (modo prueba)`,
        results,
        skippedAlreadyContacted,
        testMode: true
      });
    }

    let results;

    try {
        const configuredIds = getConfiguredSessionIds();
        const selectedSessions =
          Array.isArray(req.body.selectedSessions) && req.body.selectedSessions.length > 0
            ? req.body.selectedSessions.map((id) => String(id)).filter(Boolean)
            : configuredIds.length > 0
              ? configuredIds
              : null;

        if (selectedSessions && selectedSessions.length >= 1) {
          const sessionIds = selectedSessions;
          const N = sessionIds.length;
          const controlId = getBulkControlId(sessionIds);
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
            mensajeIA: cv.mensajeIA
          }));

          const distribution = sessionIds.map((sId, i) => {
            const count = contactsToSend.filter((_, idx) => idx % N === i).length;
            return `${sId}: ${count}`;
          });
          console.log(`📊 Distribución round-robin → ${distribution.join(', ')}`);

          initSessionSendingState(controlId);
          for (const sId of sessionIds) {
            initSessionSendingState(sId);
          }

          const checkControlsBySession = (sId) =>
            makeSessionCheckControls(sId, controlId);

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
                onWaitProgressBySession
              );
            }
          } finally {
            resetBulkControlState(controlId, sessionIds);
          }

        } else {
          return res.status(400).json({
            success: false,
            error: 'No hay sesiones configuradas. Agrega sesiones en la interfaz web.'
          });
        }
      } catch (error) {
        console.error('Error enviando mensajes por WhatsApp:', error);
        return res.status(500).json({
          error: 'Error enviando mensajes por WhatsApp',
          message: error.message
        });
      }

      console.log(`Envío completado. ${results.filter(r => r.success).length}/${results.length} mensajes enviados exitosamente`);

      return res.status(200).json({
        success: true,
        message: `Envío completado: ${results.filter(r => r.success).length}/${results.length} mensajes enviados`,
        results,
        skippedAlreadyContacted,
        testMode: false
      });
  } catch (error) {
    console.error('Error enviando mensajes por WhatsApp:', error);
    res.status(500).json({
      error: 'Error enviando mensajes por WhatsApp',
      message: error.message
    });
  }
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

// Ruta para Server-Sent Events (notificaciones en tiempo real)
app.get('/events', (req, res) => {
  // Configurar headers para SSE
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.setHeader('Access-Control-Allow-Origin', '*');

  // Agregar este cliente a la lista
  eventClients.push(res);

  // Enviar conexión inicial
  res.write(': connected\n\n');

  // Limpiar cuando el cliente se desconecta
  req.on('close', () => {
    const index = eventClients.indexOf(res);
    if (index > -1) {
      eventClients.splice(index, 1);
    }
  });
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
});

module.exports = app;
