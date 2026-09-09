const agendaIntent = require('./agendaIntent');
const agendaAvailability = require('./agendaAvailability');
const agendaWaitlistStore = require('./agendaWaitlistStore');
const agendaPendingStore = require('./agendaPendingStore');
const agendaOfferStore = require('./agendaOfferStore');
const autoReplyStore = require('./autoReplyStore');
const contactHistory = require('./contactHistoryStore');
const {
  buildWaitlistSavedReply,
  buildWaitlistSlotsReply,
  buildWaitlistEmptyNudgeReply
} = require('./agendaMeetMessages');
const { sendTextMessage } = require('./openwaClient');
const { logAgenda, warnAgenda } = require('./agendaDebug');

const POLL_INTERVAL_MS = 5 * 60 * 60 * 1000;
const STARTUP_DELAY_MS = 15 * 1000;

let pollTimer = null;
let startupTimer = null;
let ticking = false;

function shouldEnqueueWaitlist(range, today, slots) {
  if (!range || range.fechaInicio !== range.fechaFin) return false;
  const day = String(range.fechaInicio || '').trim();
  const hoy = String(today || '').trim();
  if (!day || !hoy || day < hoy) return false;
  return !(Array.isArray(slots) && slots.length);
}

function enqueuePinnedDayIfEmpty(params = {}) {
  const today = String(params.today || agendaIntent.todayYmd()).trim();
  if (!shouldEnqueueWaitlist(params.range, today, params.slots)) return null;
  const fecha = params.range.fechaInicio;
  const label = agendaIntent.relativeDayLabel(fecha, today);
  const item = agendaWaitlistStore.upsertWaiting({
    telefono: params.telefono,
    fecha,
    label,
    chatId: params.chatId,
    openwaSessionId: params.openwaSessionId,
    logicalSessionId: params.logicalSessionId,
    contactName: params.contactName,
    cvId: params.cvId,
    createdYmd: today
  });
  if (!item) return null;
  return {
    replyText: buildWaitlistSavedReply({
      contactName: params.contactName,
      fecha,
      label,
      today
    }),
    agendaMeta: {
      reason: 'waitlist_saved',
      fecha,
      waitlistId: item.id
    }
  };
}

/**
 * @returns {'expire'|'booked'|'offer_slots'|'empty_nudge'|'skip'}
 */
function decideWaitlistAction(entry, opts = {}) {
  const today = String(opts.today || '');
  const fecha = String((entry && entry.fecha) || '');
  if (!fecha || !today || fecha < today) return 'expire';
  if (opts.pendingFecha && String(opts.pendingFecha) === fecha) return 'booked';
  if (opts.confirmedFecha && String(opts.confirmedFecha) === fecha) return 'booked';

  const slots = Array.isArray(opts.slots) ? opts.slots : [];
  const daySlots = slots.filter((s) => String(s.fecha) === fecha);
  if (daySlots.length && !(entry && entry.notifiedSlotsAt)) return 'offer_slots';

  const createdYmd = String(
    opts.createdYmd || (entry && entry.createdYmd) || ''
  ).trim();
  const daysUntil = agendaIntent.daysBetweenYmd(today, fecha);
  const daysUntilAtSignup = createdYmd
    ? agendaIntent.daysBetweenYmd(createdYmd, fecha)
    : daysUntil;
  if (
    !daySlots.length &&
    daysUntil <= 2 &&
    daysUntilAtSignup > 2 &&
    !(entry && entry.notifiedEmptyAt)
  ) {
    return 'empty_nudge';
  }
  return 'skip';
}

function slotsForDay(slots, fecha) {
  return (Array.isArray(slots) ? slots : []).filter(
    (s) => String(s.fecha) === String(fecha)
  );
}

async function defaultGetSlots(fecha) {
  return agendaAvailability.getAggregatedSlotsCached({
    fechaInicio: fecha,
    fechaFin: fecha
  });
}

async function tickWaitlist(deps = {}) {
  const today = String(deps.today || agendaIntent.todayYmd());
  const getSlots = deps.getSlots || defaultGetSlots;
  const sendText = deps.sendText || sendTextMessage;
  const rememberOffer = deps.rememberOffer || agendaOfferStore.rememberOffer;
  const findPendingFecha =
    deps.findPendingFecha ||
    ((phone) => {
      const p = agendaPendingStore.findPendingByPhone(phone);
      return p ? p.fecha : null;
    });
  const findConfirmedFecha =
    deps.findConfirmedFecha ||
    ((phone) => {
      const p = agendaPendingStore.findConfirmedByPhone(phone);
      return p ? p.fecha : null;
    });
  const isAiPaused =
    deps.isAiPaused || ((phone) => contactHistory.isContactAiPaused(phone));
  const isSessionEnabled =
    deps.isSessionEnabled ||
    ((logicalSessionId) =>
      autoReplyStore.isSessionEnabled(logicalSessionId, autoReplyStore.getConfig()));

  agendaWaitlistStore.expirePast(today);

  const summary = { sentSlots: 0, sentEmpty: 0, booked: 0, expired: 0, skipped: 0, errors: 0 };
  const items = agendaWaitlistStore.listWaiting();

  for (const entry of items) {
    try {
      if (await isAiPaused(entry.telefono)) {
        summary.skipped += 1;
        continue;
      }
      if (entry.logicalSessionId && !isSessionEnabled(entry.logicalSessionId)) {
        summary.skipped += 1;
        continue;
      }

      let slots = [];
      try {
        const aggregated = await getSlots(entry.fecha);
        slots = (aggregated && aggregated.slots) || [];
      } catch (err) {
        warnAgenda('agenda-waitlist.slotsError', {
          id: entry.id,
          message: err && err.message
        });
        summary.errors += 1;
        continue;
      }

      const action = decideWaitlistAction(entry, {
        today,
        slots,
        pendingFecha: findPendingFecha(entry.telefono),
        confirmedFecha: findConfirmedFecha(entry.telefono),
        createdYmd: entry.createdYmd
      });

      if (action === 'expire') {
        agendaWaitlistStore.expirePast(today);
        summary.expired += 1;
        continue;
      }
      if (action === 'booked') {
        agendaWaitlistStore.cancelByPhone(entry.telefono, 'booked');
        summary.booked += 1;
        continue;
      }
      if (action === 'skip') {
        summary.skipped += 1;
        continue;
      }

      const openwaSessionId = String(entry.openwaSessionId || '').trim();
      const chatId = String(entry.chatId || '').trim();
      if (!openwaSessionId || !chatId) {
        warnAgenda('agenda-waitlist.sinDestino', { id: entry.id });
        summary.skipped += 1;
        continue;
      }

      const daySlots = slotsForDay(slots, entry.fecha);
      const label = entry.label || agendaIntent.relativeDayLabel(entry.fecha, today);
      let text = '';
      if (action === 'offer_slots') {
        const slotsText = agendaAvailability.formatSlotsForLead(daySlots, 1, today);
        text = buildWaitlistSlotsReply({
          contactName: entry.contactName,
          fecha: entry.fecha,
          label,
          today,
          slotsText
        });
        rememberOffer(entry.telefono, daySlots);
        await sendText(openwaSessionId, chatId, text);
        agendaWaitlistStore.markNotifiedSlots(entry.id);
        summary.sentSlots += 1;
        logAgenda('agenda-waitlist.slotsEnviados', {
          id: entry.id,
          telefono: entry.telefono,
          fecha: entry.fecha
        });
      } else if (action === 'empty_nudge') {
        text = buildWaitlistEmptyNudgeReply({
          contactName: entry.contactName,
          fecha: entry.fecha,
          label,
          today
        });
        await sendText(openwaSessionId, chatId, text);
        agendaWaitlistStore.markNotifiedEmpty(entry.id);
        summary.sentEmpty += 1;
        logAgenda('agenda-waitlist.nudgeVacio', {
          id: entry.id,
          telefono: entry.telefono,
          fecha: entry.fecha
        });
      }
    } catch (err) {
      summary.errors += 1;
      warnAgenda('agenda-waitlist.tickError', {
        id: entry && entry.id,
        message: err && err.message
      });
    }
  }

  return summary;
}

async function runTickSafe() {
  if (ticking) return;
  ticking = true;
  try {
    const summary = await tickWaitlist();
    if (summary.sentSlots || summary.sentEmpty || summary.errors) {
      console.log(
        `[agenda-waitlist] tick slots=${summary.sentSlots} empty=${summary.sentEmpty} errors=${summary.errors}`
      );
    }
  } catch (err) {
    console.warn('[agenda-waitlist] tick:', err.message);
  } finally {
    ticking = false;
  }
}

function startWaitlistPoller(opts = {}) {
  stopWaitlistPoller();
  const intervalMs = Number.isFinite(opts.intervalMs)
    ? opts.intervalMs
    : POLL_INTERVAL_MS;
  const startupDelayMs = Number.isFinite(opts.startupDelayMs)
    ? opts.startupDelayMs
    : STARTUP_DELAY_MS;
  startupTimer = setTimeout(() => {
    startupTimer = null;
    runTickSafe();
  }, startupDelayMs);
  pollTimer = setInterval(() => {
    runTickSafe();
  }, intervalMs);
  if (pollTimer.unref) pollTimer.unref();
  if (startupTimer.unref) startupTimer.unref();
  console.log(
    `[agenda-waitlist] poller cada ${Math.round(intervalMs / 3600000)}h (primer tick en ${Math.round(startupDelayMs / 1000)}s)`
  );
}

function stopWaitlistPoller() {
  if (pollTimer) {
    clearInterval(pollTimer);
    pollTimer = null;
  }
  if (startupTimer) {
    clearTimeout(startupTimer);
    startupTimer = null;
  }
}

module.exports = {
  POLL_INTERVAL_MS,
  STARTUP_DELAY_MS,
  shouldEnqueueWaitlist,
  enqueuePinnedDayIfEmpty,
  decideWaitlistAction,
  tickWaitlist,
  startWaitlistPoller,
  stopWaitlistPoller
};
