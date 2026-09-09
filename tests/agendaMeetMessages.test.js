const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const {
  buildConfirmedMeetingReply,
  buildNoSlotAtTimeReply,
  buildWaitlistSavedReply,
  buildWaitlistSlotsReply,
  buildWaitlistEmptyNudgeReply
} = require('../agendaMeetMessages');

describe('agendaMeetMessages', () => {
  it('con liga incluye recomendación de conectarse 5 min antes', () => {
    const text = buildConfirmedMeetingReply({
      contactName: 'Gago',
      fecha: '2026-09-03',
      horaInicio: '17:00',
      urlReunion: 'https://meet.google.com/abc-defg-hij'
    });
    assert.match(text, /5 minutos antes/i);
    assert.match(text, /15 minutos/i);
    assert.match(text, /confianza/i);
    assert.match(text, /meet\.google\.com/);
    assert.match(text, /asesor/i);
  });

  it('sin liga aún explica qué esperar de la sesión', () => {
    const text = buildConfirmedMeetingReply({
      contactName: 'Ana',
      fecha: '2026-09-04',
      horaInicio: '10:00'
    });
    assert.match(text, /en un momento te envío la liga/i);
    assert.match(text, /15 minutos/i);
    assert.match(text, /5 minutos antes/i);
    assert.doesNotMatch(text, /¡Nos vemos!$/);
  });

  it('no envía al lead las notas internas de horarios', () => {
    const text = buildNoSlotAtTimeReply({
      contactName: 'Jeisler',
      slotsText:
        'HOY (MIÉRCOLES 9 sep): libres 11:30, 12:30, 13:30\n' +
        '(La sesión dura 15 minutos. Ofrece solo las horas listadas arriba; no inventes otras. ' +
        'Respeta la etiqueta del día (HOY / MAÑANA / nombre del día); no digas "mañana" si el bloque no es MAÑANA. ' +
        'Tramos reales (para si el lead pide algo entre dos horas): HOY (MIÉRCOLES 9 sep): de 11:30 a 14:15. ' +
        'Si pregunta p.ej. "¿tienes entre las 10 y las 11?", sugiere la media hora libre dentro del tramo (ej. "¿te queda a las 10:30?").)'
    });
    assert.match(text, /Entiendo, Jeisler/);
    assert.match(text, /libres 11:30, 12:30, 13:30/);
    assert.doesNotMatch(text, /Ofrece solo las horas/);
    assert.doesNotMatch(text, /no inventes otras/);
    assert.doesNotMatch(text, /Tramos reales/);
    assert.doesNotMatch(text, /para si el lead pide/);
  });

  it('waitlist: avisa sin listar horas de esta semana', () => {
    const text = buildWaitlistSavedReply({
      contactName: 'Jhonatan',
      fecha: '2026-09-17',
      today: '2026-09-09'
    });
    assert.match(text, /Entiendo, Jhonatan/);
    assert.match(text, /jueves 17/i);
    assert.match(text, /todavía no tenemos horarios/i);
    assert.doesNotMatch(text, /08:00/);
    assert.doesNotMatch(text, /jueves 10/i);
  });

  it('waitlist: oferta de huecos y nudge vacío', () => {
    const slots = buildWaitlistSlotsReply({
      contactName: 'Jhonatan',
      fecha: '2026-09-17',
      today: '2026-09-09',
      slotsText: 'JUEVES 17 sep: libres 10:00, 17:00\n(La sesión dura 15 minutos. no inventes otras.)'
    });
    assert.match(slots, /Ya tenemos horarios/);
    assert.match(slots, /10:00/);
    assert.doesNotMatch(slots, /no inventes otras/);

    const nudge = buildWaitlistEmptyNudgeReply({
      contactName: 'Jhonatan',
      fecha: '2026-09-17',
      today: '2026-09-15'
    });
    assert.match(nudge, /todavía no veo horarios/i);
  });
});
