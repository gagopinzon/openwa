const { preferredFirstName, phraseWithName } = require('./preferredContactName');

/**
 * Mensajes de confirmación y entrega de liga Meet (WhatsApp).
 * @param {string} contactName
 */
function meetingFirstName(contactName) {
  return preferredFirstName(contactName);
}

/**
 * @param {{ fecha?: string, horaInicio?: string, slotLabel?: string }} params
 */
function formatMeetingWhen(params = {}) {
  const slotLabel = String(params.slotLabel || '').trim();
  if (slotLabel) return slotLabel;
  const fecha = String(params.fecha || '').trim();
  const horaInicio = String(params.horaInicio || '').trim();
  if (fecha && horaInicio) return `${fecha} a las ${horaInicio}`;
  return fecha || horaInicio || 'la fecha acordada';
}

/**
 * @param {{ contactName?: string, fecha?: string, horaInicio?: string, urlReunion?: string|null, slotLabel?: string }} params
 */
function buildConfirmedMeetingReply(params = {}) {
  const name = meetingFirstName(params.contactName);
  const when = formatMeetingWhen(params);
  const url = String(params.urlReunion || '').trim();
  const lead = phraseWithName('Listo', name);

  if (!url) {
    return (
      `${lead}. Tu sesión con uno de nuestros asesores quedó para ${when}. ` +
      `Dura unos 15 minutos. En un momento te envío la liga por aquí.\n\n` +
      `Cuando la recibas, te sugiero conectarte unos 5 minutos antes para revisar audio y video sin prisa. ` +
      `Será un espacio cercano: siéntete en confianza para preguntar todo lo que necesites sobre tu carrera. ☺️`
    );
  }

  return (
    `${lead}. Tu sesión con uno de nuestros asesores quedó para ${when}. ` +
    `Dura unos 15 minutos.\n` +
    `Liga para unirte: ${url}\n\n` +
    `Te recomiendo conectarte unos 5 minutos antes para revisar audio y video sin prisa. ` +
    `Es un espacio tranquilo: siéntete en total confianza para preguntar lo que necesites; estamos para ayudarte.\n\n` +
    `¡Nos vemos pronto! ☺️`
  );
}

/**
 * Confirmación tras mover una cita ya existente.
 * @param {{ contactName?: string, fecha?: string, horaInicio?: string, urlReunion?: string|null, slotLabel?: string }} params
 */
function buildRescheduledMeetingReply(params = {}) {
  const name = meetingFirstName(params.contactName);
  const when = formatMeetingWhen(params);
  const url = String(params.urlReunion || '').trim();
  const lead = phraseWithName('Listo', name);

  if (!url) {
    return (
      `${lead}. Movimos tu sesión a ${when}. ` +
      `Si cambia la liga de Meet, te la envío por aquí en cuanto esté lista. ☺️`
    );
  }

  return (
    `${lead}. Movimos tu sesión a ${when}.\n` +
    `Liga para unirte: ${url}\n\n` +
    `Te recomiendo conectarte unos 5 minutos antes. ¡Nos vemos! ☺️`
  );
}

/**
 * No había cupo a la hora pedida; se ofrecen alternativas.
 * @param {{ contactName?: string, requestedHint?: string, slotsText?: string }} params
 */
function buildNoSlotAtTimeReply(params = {}) {
  const name = meetingFirstName(params.contactName);
  const lead = phraseWithName('Entiendo', name);
  const hint = String(params.requestedHint || '').trim();
  const slotsText = String(params.slotsText || '').trim();
  const whenPart = hint ? ` a las ${hint}` : ' a esa hora';
  if (slotsText) {
    return (
      `${lead}. No tenemos disponibilidad${whenPart}. ` +
      `¿Te acomoda alguno de estos horarios?\n${slotsText}`
    );
  }
  return (
    `${lead}. No tenemos disponibilidad${whenPart} por ahora. ` +
    `¿Qué otro día o franja te funcionaría?`
  );
}

module.exports = {
  meetingFirstName,
  formatMeetingWhen,
  buildConfirmedMeetingReply,
  buildRescheduledMeetingReply,
  buildNoSlotAtTimeReply
};
