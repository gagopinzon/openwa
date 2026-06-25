const { resolveOpenWASessionId } = require('./sessionsStore');
const {
  formatPhoneToChatId,
  getSessionStatus,
  sendTextMessage
} = require('./openwaClient');

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
   * @returns {Promise<boolean>}
   */
  async sendMessage(phone, message) {
    if (!this.isInitialized || !this.openwaSessionId) {
      throw new Error('WhatsApp no está inicializado. Llama a initWhatsApp() primero.');
    }

    try {
      console.log(`Enviando mensaje a ${phone} vía OpenWA...`);

      const chatId = formatPhoneToChatId(phone);

      const humanDelayMs = Math.floor(3000 + Math.random() * 7000);
      console.log(
        `Esperando ${(humanDelayMs / 1000).toFixed(1)} segundos antes de enviar (delay humano)...`
      );
      await new Promise((resolve) => setTimeout(resolve, humanDelayMs));

      const result = await sendTextMessage(this.openwaSessionId, chatId, message);
      console.log(`Mensaje enviado a ${phone} (id: ${result.messageId || 'n/a'})`);
      return true;
    } catch (error) {
      const msg = error.message || String(error);
      if (/invalid|inválido|not on whatsapp|no está en whatsapp/i.test(msg)) {
        console.log(`Número inválido o sin WhatsApp: ${phone} — ${msg}`);
      } else {
        console.error(`Error enviando mensaje a ${phone}:`, msg);
      }
      return false;
    }
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
    onMessageResult = null
  ) {
    if (!this.isInitialized) {
      throw new Error('WhatsApp no está inicializado. Llama a initWhatsApp() primero.');
    }

    const results = [];

    console.log(
      `Iniciando envío masivo de ${contacts.length} mensajes con delay aleatorio de 1-5 minutos`
    );

    for (let i = 0; i < contacts.length; i++) {
      const contact = contacts[i];

      if (checkControls) {
        const controls = checkControls();
        if (controls.aborted) {
          console.log('Envío abortado por el usuario');
          break;
        }

        while (controls.paused && !controls.aborted) {
          console.log('Envío pausado, esperando...');
          await new Promise((resolve) => setTimeout(resolve, 5000));
          if (checkControls) {
            const newControls = checkControls();
            if (newControls.aborted) break;
            controls.paused = newControls.paused;
          }
        }

        if (controls.aborted) {
          console.log('Envío abortado por el usuario');
          break;
        }
      }

      const mensajePreview =
        contact.mensajeIA.length > 100
          ? contact.mensajeIA.substring(0, 100) + '...'
          : contact.mensajeIA;

      console.log(
        `Enviando mensaje ${i + 1}/${contacts.length} a ${contact.nombre} (${contact.telefono})`
      );
      console.log(`Mensaje: ${mensajePreview}`);

      if (onProgress) {
        onProgress({
          readyToSend: true,
          current: i + 1,
          total: contacts.length,
          nombre: contact.nombre,
          telefono: contact.telefono,
          mensajeIA: contact.mensajeIA
        });
      }

      try {
        const success = await this.sendMessage(contact.telefono, contact.mensajeIA);

        const rowSuccess = {
          index: i,
          nombre: contact.nombre,
          telefono: contact.telefono,
          mensajeIA: contact.mensajeIA,
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
            nombre: contact.nombre,
            telefono: contact.telefono,
            mensajeIA: contact.mensajeIA,
            success
          });
        }

        if (i < contacts.length - 1) {
          const minSeconds = 60;
          const maxSeconds = 300;
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

          while (remainingTime > 0) {
            if (checkControls) {
              const controls = checkControls();

              if (controls.aborted) {
                console.log('Envío abortado durante la espera');
                return results;
              }

              if (controls.skipWait) {
                console.log('Saltando espera - enviando siguiente mensaje inmediatamente');
                remainingTime = 0;
                break;
              }

              while (controls.timePaused && !controls.aborted && !controls.skipWait) {
                console.log('Tiempo de espera pausado...');
                await new Promise((resolve) => setTimeout(resolve, 1000));

                if (checkControls) {
                  const newControls = checkControls();
                  if (newControls.aborted) return results;

                  if (newControls.skipWait) {
                    console.log('Saltando espera desde pausa de tiempo');
                    remainingTime = 0;
                    break;
                  }

                  controls.timePaused = newControls.timePaused;
                }
              }

              while (controls.paused && !controls.aborted && !controls.timePaused) {
                console.log('Envío pausado durante la espera...');
                await new Promise((resolve) => setTimeout(resolve, 5000));

                if (checkControls) {
                  const newControls = checkControls();
                  if (newControls.aborted) return results;

                  if (newControls.skipWait) {
                    console.log('Saltando espera desde modo pausa');
                    remainingTime = 0;
                    break;
                  }

                  controls.paused = newControls.paused;
                }
              }
            }

            if (remainingTime === 0) break;

            if (checkControls) {
              const controls = checkControls();
              if (controls.timePaused) {
                await new Promise((resolve) => setTimeout(resolve, 1000));
                continue;
              }
            }

            const waitTime = Math.min(remainingTime, checkInterval);
            await new Promise((resolve) => setTimeout(resolve, waitTime));
            remainingTime -= waitTime;
          }
        }
      } catch (error) {
        console.error(`Error procesando contacto ${i + 1}:`, error.message);
        const rowFail = {
          index: i,
          nombre: contact.nombre,
          telefono: contact.telefono,
          mensajeIA: contact.mensajeIA,
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

module.exports = OpenWAWhatsAppService;
