/**
 * Reagenda una cita CONFIRMADA: slot → mismo vendedor si cabe → PATCH Panel → store.
 */

const agendaPendingStore = require('./agendaPendingStore');
const agendaAvailability = require('./agendaAvailability');
const agendaIntent = require('./agendaIntent');
const agendaPreferredTime = require('./agendaPreferredTime');
const agendaOfferStore = require('./agendaOfferStore');
const panelMsgClient = require('./panelMsgClient');
const panelMeetUtils = require('./panelMeetUtils');
const {
  buildRescheduledMeetingReply,
  buildNoSlotAtTimeReply
} = require('./agendaMeetMessages');
const { logAgenda, warnAgenda } = require('./agendaDebug');

function slotStartKey(item) {
  if (!item) return '';
  const fecha = String(item.fecha || '').trim();
  const hora = String(item.horaInicio || '').trim().slice(0, 5);
  if (!fecha || !hora) return '';
  return `${fecha}|${hora}`;
}

/**
 * @param {object|null|undefined} confirmed
 * @param {object|null|undefined} slot
 */
function isSameConfirmedSlot(confirmed, slot) {
  const a = slotStartKey(confirmed);
  const b = slotStartKey(slot);
  return Boolean(a && b && a === b);
}

/**
 * Repite la hora ya confirmada (a veces con el mismo día), sin pedir otro horario.
 * @param {string} body
 * @param {object} confirmed
 */
function echoingConfirmedTime(body, confirmed) {
  const times = agendaIntent.extractTimesFromMessage(body);
  if (!times.length) return false;
  const confirmedHhmm = String(confirmed && confirmed.horaInicio ? confirmed.horaInicio : '')
    .trim()
    .slice(0, 5);
  if (!confirmedHhmm || !times.includes(confirmedHhmm)) return false;
  const range = agendaIntent.resolveDateRangeFromMessage(body);
  if (!range || range.fechaInicio !== range.fechaFin) return true;
  const confirmedFecha = String(confirmed && confirmed.fecha ? confirmed.fecha : '').trim();
  return Boolean(confirmedFecha) && range.fechaInicio === confirmedFecha;
}

function offerCreatedAfterConfirm(priorOffer, confirmed) {
  const offerAt = Date.parse(priorOffer && priorOffer.createdAt) || 0;
  const confirmedAt = Date.parse(confirmed && (confirmed.confirmedAt || confirmed.createdAt)) || 0;
  return Boolean(offerAt && confirmedAt && offerAt >= confirmedAt);
}

/**
 * Tras una cita confirmada, solo se mueve si el lead pide otro horario
 * (no un "ok" / "perfecto" ni repetir la hora ya agendada).
 * @param {string} body
 * @param {object|null|undefined} confirmed
 * @param {{ priorOffer?: object|null }} [opts]
 */
function shouldAttemptReschedule(body, confirmed, opts = {}) {
  if (!confirmed || confirmed.status !== agendaPendingStore.STATUS.CONFIRMED) {
    return false;
  }

  const wantsMove = agendaIntent.wantsRescheduleMeeting(body);
  const hasTime = agendaIntent.hasExplicitTimeChoice(body);
  const confirmingYes = agendaIntent.looksLikeTimeConfirmYes(body);
  const priorOffer = opts.priorOffer || null;
  const offerOpen = Boolean(
    priorOffer && Array.isArray(priorOffer.slots) && priorOffer.slots.length
  );
  const proposed = priorOffer && priorOffer.proposedSlot;
  const rescheduleOffer = offerOpen && offerCreatedAfterConfirm(priorOffer, confirmed);

  if (echoingConfirmedTime(body, confirmed) && !wantsMove) return false;
  if (wantsMove) return true;
  if (rescheduleOffer && hasTime) return true;
  if (
    rescheduleOffer &&
    confirmingYes &&
    proposed &&
    !isSameConfirmedSlot(confirmed, proposed)
  ) {
    return true;
  }
  if (hasTime && !echoingConfirmedTime(body, confirmed)) return true;
  return false;
}

/**
 * Ordena candidatos poniendo primero al vendedor preferido.
 * @param {Array<{ vendedorId: string, gerenteEmail?: string, nombre?: string|null }>} candidates
 * @param {string|null|undefined} preferredVendedorId
 */
function preferSameVendor(candidates, preferredVendedorId) {
  const list = Array.isArray(candidates) ? candidates.slice() : [];
  const pref = String(preferredVendedorId || '').trim();
  if (!pref || !list.length) return list;
  const preferred = [];
  const rest = [];
  for (const c of list) {
    if (String(c.vendedorId || '').trim() === pref) preferred.push(c);
    else rest.push(c);
  }
  return preferred.concat(rest);
}

/**
 * @param {object} confirmed
 * @param {object} chosen slot con candidates
 * @param {{ testMode?: boolean }} [opts]
 */
async function applyRescheduleToPanel(confirmed, chosen, opts = {}) {
  const reunionId = String(confirmed.panelReunionId || '').trim();
  if (!reunionId) {
    const err = new Error('La cita no tiene id de reunión en Panel');
    err.status = 409;
    err.code = 'missing_panel_reunion_id';
    throw err;
  }
  if (!panelMsgClient.isConfigured()) {
    const err = new Error('Integración con panel no configurada');
    err.status = 503;
    throw err;
  }

  const ordered = preferSameVendor(
    chosen.candidates || confirmed.candidateVendors || [],
    confirmed.vendedorId
  );
  if (!ordered.length) {
    const err = new Error('No hay vendedor disponible para ese horario');
    err.status = 409;
    throw err;
  }

  if (opts.testMode) {
    const vendor = ordered[0];
    const updated = agendaPendingStore.rescheduleConfirmed(confirmed.id, {
      fecha: chosen.fecha,
      horaInicio: chosen.horaInicio,
      horaFin: chosen.horaFin,
      label: chosen.label || null,
      vendedorId: vendor.vendedorId,
      gerenteEmail: vendor.gerenteEmail || confirmed.gerenteEmail,
      candidateVendors: ordered
    });
    return { updated, panel: null, vendor, testMode: true };
  }

  let lastError = null;
  let panelData = null;
  let usedVendor = null;
  for (const vendor of ordered) {
    try {
      panelData = await panelMsgClient.actualizarReunion({
        reunionId,
        gerenteEmail: vendor.gerenteEmail || confirmed.gerenteEmail,
        fecha: chosen.fecha,
        horaInicio: chosen.horaInicio,
        horaFin: chosen.horaFin,
        vendedorId: vendor.vendedorId
      });
      usedVendor = vendor;
      break;
    } catch (error) {
      lastError = error;
      warnAgenda('agenda-reschedule.vendedorError', {
        pendingId: confirmed.id,
        reunionId,
        vendedorId: vendor.vendedorId,
        status: error.status || null,
        message: error.message
      });
      if (error.status === 409) continue;
      throw error;
    }
  }

  if (!panelData || !usedVendor) {
    throw lastError || new Error('No se pudo reagendar la reunión en el panel');
  }

  const urlFromPanel = panelMeetUtils.extractMeetUrlFromPanel(panelData);
  const updated = agendaPendingStore.rescheduleConfirmed(confirmed.id, {
    fecha: chosen.fecha,
    horaInicio: chosen.horaInicio,
    horaFin: chosen.horaFin,
    label: chosen.label || null,
    vendedorId: usedVendor.vendedorId,
    gerenteEmail: usedVendor.gerenteEmail || confirmed.gerenteEmail,
    urlReunion: urlFromPanel || undefined,
    candidateVendors: ordered
  });

  return { updated, panel: panelData, vendor: usedVendor };
}

/**
 * Intenta reagendar según el mensaje del lead.
 * @returns {Promise<{
 *   handled: boolean,
 *   replyText?: string|null,
 *   agendaMeta?: object|null,
 *   agendaContext?: string|null,
 *   reason?: string
 * }>}
 */
async function handleReschedule({
  confirmed,
  body,
  contactName,
  broadcastEvent = null,
  testMode = false,
  priorOffer = null,
  slotMatchOpts = {}
} = {}) {
  if (!confirmed || confirmed.status !== agendaPendingStore.STATUS.CONFIRMED) {
    return { handled: false, reason: 'no_confirmed' };
  }

  if (!shouldAttemptReschedule(body, confirmed, { priorOffer })) {
    return { handled: false, reason: 'no_reschedule_intent' };
  }

  const wantsMove = agendaIntent.wantsRescheduleMeeting(body);
  const hasTime = agendaIntent.hasExplicitTimeChoice(body);
  const fromOffer =
    priorOffer &&
    Array.isArray(priorOffer.slots) &&
    priorOffer.slots.length &&
    offerCreatedAfterConfirm(priorOffer, confirmed) &&
    (hasTime || agendaIntent.looksLikeTimeConfirmYes(body));

  if (!String(confirmed.panelReunionId || '').trim()) {
    return {
      handled: true,
      replyText:
        'Tu cita ya está anotada, pero para moverla necesito que un asesor la actualice en el sistema. Te aviso en cuanto la movamos. ☺️',
      agendaMeta: {
        reason: 'reschedule_missing_panel_id',
        pendingId: confirmed.id
      }
    };
  }

  let chosen = null;

  if (fromOffer) {
    if (
      agendaIntent.looksLikeTimeConfirmYes(body) &&
      priorOffer.proposedSlot &&
      priorOffer.proposedSlot.horaInicio
    ) {
      chosen = priorOffer.proposedSlot;
    } else {
      chosen = agendaIntent.matchSlotFromMessage(
        body,
        priorOffer.slots,
        slotMatchOpts
      );
    }
  }

  if (!chosen) {
    const today = agendaIntent.todayYmd();
    const tomorrow = agendaIntent.addDaysYmd(today, 1);
    const range =
      agendaIntent.resolveDateRangeFromMessage(body) || {
        fechaInicio: today,
        fechaFin: tomorrow
      };
    let aggregated = await agendaAvailability.getAggregatedSlots({
      fechaInicio: range.fechaInicio,
      fechaFin: range.fechaFin,
      skipCache: true
    });
    let slots = aggregated.slots || [];

    if (hasTime || wantsMove) {
      const decision = agendaPreferredTime.resolvePreferredTimeOffer(body, slots, {
        today,
        tomorrow
      });
      if (decision.action === 'confirm' && decision.slot) {
        chosen = decision.slot;
      }
    }

    if (!chosen) {
      const matched = agendaIntent.matchSlotFromMessage(body, slots, slotMatchOpts);
      if (matched) chosen = matched;
    }

    if (!chosen) {
      if (!slots.length) {
        aggregated = await agendaAvailability.getAggregatedSlots({
          fechaInicio: range.fechaInicio <= today ? tomorrow : range.fechaInicio,
          fechaFin: agendaIntent.addDaysYmd(
            range.fechaInicio <= today ? tomorrow : range.fechaInicio,
            6
          ),
          skipCache: true
        });
        slots = aggregated.slots || [];
      }

      const phone = confirmed.telefono;
      if (slots.length && phone) {
        agendaOfferStore.rememberOffer(phone, slots);
      }
      const publicList = agendaAvailability.publicSlots(slots, 6);
      const slotsText = agendaAvailability.formatSlotsForLead(publicList, 3);
      const times = agendaIntent.extractTimesFromMessage(body);
      const requestedHint = times && times.length ? times[0] : '';

      logAgenda('agenda-reschedule.noSlot', {
        pendingId: confirmed.id,
        requestedHint,
        slots: publicList.length
      });

      return {
        handled: true,
        replyText: buildNoSlotAtTimeReply({
          contactName,
          requestedHint,
          slotsText
        }),
        agendaMeta: {
          reason: 'reschedule_no_slot',
          pendingId: confirmed.id,
          offered: publicList.length
        }
      };
    }
  }

  if (isSameConfirmedSlot(confirmed, chosen)) {
    return { handled: false, reason: 'same_slot' };
  }

  try {
    const result = await applyRescheduleToPanel(confirmed, chosen, { testMode });
    if (typeof broadcastEvent === 'function') {
      try {
        broadcastEvent('agendaPendingConfirmed', result.updated);
      } catch (err) {
        warnAgenda('agenda-reschedule.broadcast', { message: err.message });
      }
    }
    if (confirmed.telefono) {
      agendaOfferStore.clearOffer(confirmed.telefono);
    }
    const replyText = buildRescheduledMeetingReply({
      contactName,
      fecha: result.updated.fecha,
      horaInicio: result.updated.horaInicio,
      slotLabel: result.updated.label,
      urlReunion: result.updated.urlReunion
    });
    // WhatsApp lo envía Msg (auto-reply), no el Panel.
    logAgenda('agenda-reschedule.ok', {
      pendingId: confirmed.id,
      panelReunionId: confirmed.panelReunionId,
      vendedorId: result.vendor && result.vendor.vendedorId,
      sameVendor:
        String(confirmed.vendedorId || '') ===
        String((result.vendor && result.vendor.vendedorId) || ''),
      slot: `${chosen.fecha} ${chosen.horaInicio}`
    });
    return {
      handled: true,
      replyText,
      agendaMeta: {
        reason: 'rescheduled',
        pendingId: confirmed.id,
        panelReunionId: confirmed.panelReunionId,
        vendedorId: result.vendor && result.vendor.vendedorId
      }
    };
  } catch (error) {
    warnAgenda('agenda-reschedule.fail', {
      pendingId: confirmed.id,
      message: error.message,
      status: error.status || null
    });
    return {
      handled: true,
      replyText:
        'Intenté mover tu cita pero no pude confirmar el nuevo horario ahora. ¿Probamos con otra hora? ☺️',
      agendaMeta: {
        reason: 'reschedule_panel_error',
        pendingId: confirmed.id,
        error: error.message
      }
    };
  }
}

module.exports = {
  preferSameVendor,
  isSameConfirmedSlot,
  shouldAttemptReschedule,
  applyRescheduleToPanel,
  handleReschedule
};
