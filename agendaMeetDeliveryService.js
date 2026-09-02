const agendaPendingStore = require('./agendaPendingStore');
const agendaConfirmService = require('./agendaConfirmService');
const sessionsStore = require('./sessionsStore');
const { sendTextMessage } = require('./openwaClient');
const { extractMeetUrlFromPanel, isRetryablePanelError, sleep } = require('./panelMeetUtils');

const scheduled = new Map();

function retryDelayMs(attempt) {
  const base = Number(process.env.AGENDA_MEET_RETRY_MS || 15000);
  return Math.min(base * attempt, 90000);
}

function maxRetryAttempts() {
  const raw = Number(process.env.AGENDA_MEET_RETRY_MAX || 6);
  return Number.isFinite(raw) && raw > 0 ? Math.floor(raw) : 6;
}

/**
 * @param {object} pending
 * @param {{ contactName?: string, fecha?: string, horaInicio?: string, urlReunion?: string|null, senderName?: string }} params
 */
function buildMeetLinkMessage(pending, params = {}) {
  const name = String(params.contactName || pending.contactName || 'contacto').split(/\s+/)[0] || 'contacto';
  const fecha = params.fecha || pending.fecha;
  const horaInicio = params.horaInicio || pending.horaInicio;
  const url = params.urlReunion || pending.urlReunion;
  if (!url) {
    return `Listo, ${name}. Tu sesión quedó el ${fecha} a las ${horaInicio}. Te enviaremos la liga en un momento.`;
  }
  return (
    `Listo, ${name}. Tu sesión quedó el ${fecha} a las ${horaInicio}.\n` +
    `Liga para unirte: ${url}\n\n¡Nos vemos! ☺️`
  );
}

/**
 * Reintenta confirmar en el panel y envía la liga por WhatsApp cuando esté lista.
 * @param {object} pending
 * @param {{ openwaSessionId: string, chatId: string, logicalSessionId?: string|null }} notify
 */
function scheduleMeetLinkDelivery(pending, notify = {}) {
  if (!pending || !pending.id) return;
  const openwaSessionId = String(notify.openwaSessionId || pending.openwaSessionId || '').trim();
  const chatId = String(notify.chatId || pending.chatId || '').trim();
  if (!openwaSessionId || !chatId) {
    console.warn('[agenda-meet] sin openwaSessionId/chatId; no se puede enviar la liga');
    return;
  }
  if (scheduled.has(pending.id)) return;

  let attempt = 0;
  const maxAttempts = maxRetryAttempts();

  const run = async () => {
    attempt += 1;
    try {
      const fresh = agendaPendingStore.getById(pending.id);
      if (!fresh) {
        scheduled.delete(pending.id);
        return;
      }
      if (fresh.status === agendaPendingStore.STATUS.CONFIRMED && fresh.urlReunion) {
        const text = buildMeetLinkMessage(fresh, {
          contactName: fresh.contactName,
          urlReunion: fresh.urlReunion,
          senderName: fresh.logicalSessionId
            ? sessionsStore.getSessionSenderName(fresh.logicalSessionId)
            : 'Pro Talent'
        });
        await sendTextMessage(openwaSessionId, chatId, text);
        console.log(`[agenda-meet] liga enviada pending=${fresh.id}`);
        scheduled.delete(pending.id);
        return;
      }
      if (fresh.status !== agendaPendingStore.STATUS.PENDING_LINK) {
        scheduled.delete(pending.id);
        return;
      }

      const confirmed = await agendaConfirmService.confirmPendingInPanel(fresh);
      const url =
        confirmed.urlReunionLead ||
        extractMeetUrlFromPanel(confirmed.panel) ||
        fresh.urlReunion ||
        null;

      if (url) {
        const text = buildMeetLinkMessage(confirmed.confirmed || fresh, {
          contactName: fresh.contactName,
          fecha: fresh.fecha,
          horaInicio: fresh.horaInicio,
          urlReunion: url,
          senderName: fresh.logicalSessionId
            ? sessionsStore.getSessionSenderName(fresh.logicalSessionId)
            : 'Pro Talent'
        });
        await sendTextMessage(openwaSessionId, chatId, text);
        console.log(`[agenda-meet] liga enviada tras reintento pending=${fresh.id}`);
        scheduled.delete(pending.id);
        return;
      }

      if (attempt < maxAttempts) {
        const delay = retryDelayMs(attempt);
        console.log(
          `[agenda-meet] sin liga aún pending=${fresh.id}; reintento ${attempt + 1}/${maxAttempts} en ${delay}ms`
        );
        scheduled.set(pending.id, setTimeout(run, delay));
        return;
      }

      console.warn(`[agenda-meet] agotados reintentos pending=${fresh.id}`);
      scheduled.delete(pending.id);
    } catch (error) {
      if (attempt < maxAttempts && isRetryablePanelError(error)) {
        const delay = retryDelayMs(attempt);
        console.warn(
          `[agenda-meet] error pending=${pending.id} (${error.message}); reintento en ${delay}ms`
        );
        scheduled.set(pending.id, setTimeout(run, delay));
        return;
      }
      console.warn(`[agenda-meet] falló pending=${pending.id}:`, error.message);
      scheduled.delete(pending.id);
    }
  };

  const initialDelay = retryDelayMs(1);
  scheduled.set(pending.id, setTimeout(run, initialDelay));
  console.log(`[agenda-meet] programado pending=${pending.id} primer intento en ${initialDelay}ms`);
}

module.exports = {
  scheduleMeetLinkDelivery,
  buildMeetLinkMessage
};
