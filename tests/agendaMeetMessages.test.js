const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { buildConfirmedMeetingReply } = require('../agendaMeetMessages');

describe('agendaMeetMessages', () => {
  it('con liga incluye recomendación de conectarse 5 min antes', () => {
    const text = buildConfirmedMeetingReply({
      contactName: 'Gago',
      fecha: '2026-09-03',
      horaInicio: '17:00',
      urlReunion: 'https://meet.google.com/abc-defg-hij'
    });
    assert.match(text, /5 minutos antes/i);
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
    assert.match(text, /5 minutos antes/i);
    assert.doesNotMatch(text, /¡Nos vemos!$/);
  });
});
