/**
 * Mensajes de confirmación y entrega de liga Meet (WhatsApp).
 * @param {string} contactName
 */
function meetingFirstName(contactName) {
  return String(contactName || 'contacto').split(/\s+/)[0] || 'contacto';
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

  if (!url) {
    return (
      `Listo, ${name}. Tu sesión con uno de nuestros asesores quedó para ${when}. ` +
      `En un momento te envío la liga por aquí.\n\n` +
      `Cuando la recibas, te sugiero conectarte unos 5 minutos antes para revisar audio y video sin prisa. ` +
      `Será un espacio cercano: siéntete en confianza para preguntar todo lo que necesites sobre tu carrera. ☺️`
    );
  }

  return (
    `Listo, ${name}. Tu sesión con uno de nuestros asesores quedó para ${when}.\n` +
    `Liga para unirte: ${url}\n\n` +
    `Te recomiendo conectarte unos 5 minutos antes para revisar audio y video sin prisa. ` +
    `Es un espacio tranquilo: siéntete en total confianza para preguntar lo que necesites; estamos para ayudarte.\n\n` +
    `¡Nos vemos pronto! ☺️`
  );
}

module.exports = {
  meetingFirstName,
  formatMeetingWhen,
  buildConfirmedMeetingReply
};
