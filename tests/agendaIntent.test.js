const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const {
  looksLikeScheduleIntent,
  resolveDateRangeFromMessage,
  matchSlotFromMessage,
  addDaysYmd,
  todayYmd
} = require('../agendaIntent');

describe('agendaIntent', () => {
  const fixed = new Date('2026-08-01T18:00:00Z'); // sábado

  it('detecta intención de agenda', () => {
    assert.equal(looksLikeScheduleIntent('¿tienen horario mañana?'), true);
    assert.equal(looksLikeScheduleIntent('ok gracias'), false);
  });

  it('resuelve mañana y jueves', () => {
    const today = todayYmd(fixed);
    const manana = resolveDateRangeFromMessage('puedo mañana', fixed);
    assert.deepEqual(manana, {
      fechaInicio: addDaysYmd(today, 1),
      fechaFin: addDaysYmd(today, 1)
    });

    const jue = resolveDateRangeFromMessage('el jueves me sirve', fixed);
    assert.ok(jue);
    assert.equal(jue.fechaInicio, jue.fechaFin);
  });

  it('matchea slot por hora', () => {
    const slots = [
      { fecha: '2026-08-02', horaInicio: '10:00', horaFin: '10:30', label: 'a' },
      { fecha: '2026-08-02', horaInicio: '11:00', horaFin: '11:30', label: 'b' }
    ];
    const hit = matchSlotFromMessage('me queda a las 10', slots);
    assert.ok(hit);
    assert.equal(hit.horaInicio, '10:00');
  });
});
