const express = require('express');
const multer = require('multer');
const path = require('path');
const fs = require('fs');
require('dotenv').config();

const { extractTextFromPDF, extractCVData } = require('./pdfProcessor');
const { generateBulkMessages } = require('./aiService');
const WhatsAppService = require('./openwaWhatsAppService');
const {
  resolveOpenWASessionId,
  getSessionStatus
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

/** Sesiones en paralelo (alineado con `sessionSelect` / checkboxes en la UI). */
const PARALLEL_SESSION_IDS = ['session1', 'session2', 'session3'];

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
  }
}

const sessionStates = new Map(); // Map<sessionId, SessionState>

function getSessionState(sessionId) {
  if (!sessionStates.has(sessionId)) {
    sessionStates.set(sessionId, new SessionState());
  }
  return sessionStates.get(sessionId);
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
    message: TEST_MODE
      ? 'Sistema en modo de prueba - los mensajes se simularán'
      : 'Sistema en modo producción - se enviarán mensajes reales vía OpenWA'
  });
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

    const sessionId = req.body.sessionId || 'default';

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
        const selectedSessions = Array.isArray(req.body.selectedSessions) && req.body.selectedSessions.length > 0
          ? req.body.selectedSessions
          : null;

        if (selectedSessions && selectedSessions.length >= 1) {
          // Envío con una o más sesiones seleccionadas (distribución entre las marcadas)
          const sessionIds = selectedSessions;
          const N = sessionIds.length;
          console.log(`🔄 Iniciando envío con sesiones: ${sessionIds.join(', ')}`);

          const services = sessionIds.map(sId => {
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

          const contactLists = sessionIds.map(() => []);

          finalCvsToSend.forEach((cv, index) => {
            const contact = {
              nombre: cv.nombre,
              telefono: cv.telefono,
              mensajeIA: cv.mensajeIA
            };
            contactLists[index % N].push(contact);
          });

          const distLog = contactLists.map((list, i) => `${list.length} (${sessionIds[i]})`).join(', ');
          console.log(`📊 Distribución: ${distLog}`);

          if (!TEST_MODE) {
            sessionIds.forEach(sId => {
              const st = getSessionState(sId);
              st.sendingInProgress = true;
              st.sendingPaused = false;
              st.sendingAborted = false;
            });
          }

          const createCheckControls = (sId) => () => {
            const currentState = getSessionState(sId);
            const shouldSkip = currentState.skipWait;
            if (shouldSkip) currentState.skipWait = false;
            return {
              paused: currentState.sendingPaused,
              aborted: currentState.sendingAborted,
              skipWait: shouldSkip,
              timePaused: currentState.timePaused
            };
          };

          const createOnProgress = (sId) => (progressData) => {
            if (progressData.readyToSend) {
              broadcastEvent('readyToSend', {
                current: progressData.current,
                total: progressData.total,
                nombre: progressData.nombre,
                telefono: progressData.telefono,
                sessionId: sId
              });
            }
          };

          const resetSessionState = (sId) => {
            const finalState = getSessionState(sId);
            finalState.sendingInProgress = false;
            finalState.sendingPaused = false;
            finalState.sendingAborted = false;
            finalState.skipWait = false;
            finalState.timePaused = false;
          };

          sessionIds.forEach((sId, i) => {
            services[i]
              .sendBulkMessages(contactLists[i], 2, createOnProgress(sId), createCheckControls(sId), mongoRecordHook)
              .finally(() => resetSessionState(sId));
          });

          const countMsg = contactLists.map((list, i) => `${sessionIds[i]}: ${list.length}`).join(', ');
          return res.json({
            success: true,
            message: `Envío iniciado con ${N} sesión(es): ${countMsg}`,
            distributed: N > 1,
            selectedSessions: sessionIds,
            counts: contactLists.map(l => l.length),
            skippedAlreadyContacted
          });

        } else {
          // Una sola sesión (selector o sin checkboxes marcados)
          if (!TEST_MODE) {
            const sessionState = getSessionState(sessionId);
            sessionState.sendingInProgress = true;
            sessionState.sendingPaused = false;
            sessionState.sendingAborted = false;
          }

          // Obtener o inicializar el servicio de WhatsApp para esta sesión
          let whatsappService = whatsappServices.get(sessionId);

          if (!whatsappService) {
            whatsappService = new WhatsAppService(sessionId);
            whatsappServices.set(sessionId, whatsappService);
            await whatsappService.initWhatsApp();
          } else if (!whatsappService.isReady()) {
            await whatsappService.initWhatsApp();
          }

          // Preparar datos para envío
          const contactsToSend = finalCvsToSend.map(cv => ({
            nombre: cv.nombre,
            telefono: cv.telefono,
            mensajeIA: cv.mensajeIA
          }));

          // Función para verificar controles
          const checkControls = () => {
            const currentState = getSessionState(sessionId);
            const shouldSkip = currentState.skipWait;
            // Resetear skipWait después de leerlo (para que solo afecte un ciclo)
            if (shouldSkip) {
              currentState.skipWait = false;
            }
            return {
              paused: currentState.sendingPaused,
              aborted: currentState.sendingAborted,
              skipWait: shouldSkip,
              timePaused: currentState.timePaused
            };
          };

          // Callback para notificar progreso y eventos
          const onProgress = (progressData) => {
            // Emitir evento cuando está listo para enviar el siguiente mensaje
            if (progressData.readyToSend) {
              broadcastEvent('readyToSend', {
                current: progressData.current,
                total: progressData.total,
                nombre: progressData.nombre,
                telefono: progressData.telefono,
                sessionId: sessionId
              });
            }
          };

          // Iniciar envío masivo (delay aleatorio de 1-5 minutos entre mensajes)
          results = await whatsappService.sendBulkMessages(contactsToSend, 2, onProgress, checkControls, mongoRecordHook);

          // Marcar que el envío terminó (esto estaba en finally antes, pero ahora necesitamos manejar el return temprano del modo distribuido)
          const finalState = getSessionState(sessionId);
          finalState.sendingInProgress = false;
          finalState.sendingPaused = false;
          finalState.sendingAborted = false;
          finalState.skipWait = false;
          finalState.timePaused = false;
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
    if (openAllSessions) {
      sessionIds = [...PARALLEL_SESSION_IDS];
    } else if (Array.isArray(req.body.sessionIds) && req.body.sessionIds.length > 0) {
      sessionIds = req.body.sessionIds.map((id) => String(id)).filter(Boolean);
    } else {
      sessionIds = [req.body.sessionId || 'session1'];
    }

    /** @returns {Promise<{ sessionId: string, success: boolean, skippedAlreadyOpen?: boolean, message?: string, openwaSessionId?: string, status?: string }>} */
    const checkOneSession = async (logicalSessionId) => {
      let openwaSessionId;
      try {
        openwaSessionId = resolveOpenWASessionId(logicalSessionId);
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
  const sessionState = getSessionState(sessionId);

  if (!sessionState.sendingInProgress) {
    return res.status(400).json({
      error: 'No hay envíos en progreso para esta sesión'
    });
  }

  sessionState.skipWait = true;
  sessionState.timePaused = false; // Reanudar el tiempo si estaba pausado al saltar
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
app.listen(PORT, () => {
  console.log(`🚀 Servidor iniciado en http://localhost:${PORT}`);
  console.log(`📁 Interfaz web disponible en http://localhost:${PORT}`);
  console.log(`📋 Asegúrate de configurar DEEPSEEK_API_KEY en el archivo .env`);
});

module.exports = app;
