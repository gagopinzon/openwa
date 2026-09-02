const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const {
  looksLikeScheduleIntent,
  resolveDateRangeFromMessage,
  matchSlotFromMessage,
  hasExplicitTimeChoice,
  extractTimesFromMessage,
  looksLikeTimeConfirmYes,
  extractProposedTimesFromBotText,
  lastFromMeBody,
  lastBotProposalText,
  userMentionsSendingCv,
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

  it('detecta hora explícita sin pedir confirmación', () => {
    assert.equal(
      hasExplicitTimeChoice('dame la liga el miercoles 2 a las 18:00 horas'),
      true
    );
    assert.equal(hasExplicitTimeChoice('¿tienen horario mañana?'), false);
  });

  it('detecta si el lead dice que enviará CV', () => {
    assert.equal(userMentionsSendingCv('ahorita te comparto mi cv ok'), true);
    assert.equal(userMentionsSendingCv('quiero agendar'), false);
  });

  it('interpreta 5 de la tarde como 17:00, no 05:00', () => {
    assert.deepEqual(extractTimesFromMessage('el jueves a las 5 de la tarde'), ['17:00']);
    assert.deepEqual(extractTimesFromMessage('a las 5 de la tarde'), ['17:00']);
    assert.deepEqual(extractTimesFromMessage('5 de la tarde'), ['17:00']);
    assert.deepEqual(extractTimesFromMessage('9 de la mañana'), ['09:00']);
    assert.deepEqual(extractTimesFromMessage('8 de la noche'), ['20:00']);
  });

  it('matchea el jueves a las 5 de la tarde con el slot 17:00', () => {
    const now = new Date('2026-09-02T18:00:00Z'); // miércoles CDMX
    const slots = [
      { fecha: '2026-09-03', horaInicio: '10:00', horaFin: '10:15' },
      { fecha: '2026-09-03', horaInicio: '17:00', horaFin: '17:15' },
      { fecha: '2026-09-04', horaInicio: '17:00', horaFin: '17:15' }
    ];
    const hit = matchSlotFromMessage('el jueves a las 5 de la tarde', slots, { now });
    assert.ok(hit);
    assert.equal(hit.fecha, '2026-09-03');
    assert.equal(hit.horaInicio, '17:00');
  });

  it('usa 17:00 si el lead dice a las 5 y no hay slot a las 05:00', () => {
    const slots = [{ fecha: '2026-08-02', horaInicio: '17:00', horaFin: '17:15' }];
    const hit = matchSlotFromMessage('a las 5', slots);
    assert.ok(hit);
    assert.equal(hit.horaInicio, '17:00');
  });

  it('detecta confirmación corta de hora y no la confunde con interés inicial', () => {
    assert.equal(looksLikeTimeConfirmYes('si esta perfecto'), true);
    assert.equal(looksLikeTimeConfirmYes('si esta bien'), true);
    assert.equal(looksLikeTimeConfirmYes('sí'), true);
    assert.equal(looksLikeTimeConfirmYes('perfecto'), true);
    assert.equal(looksLikeTimeConfirmYes('si me interesa'), false);
    assert.equal(looksLikeTimeConfirmYes('el jueves a las 5 de la tarde'), false);
  });

  it('al decir sí, toma la hora que el bot acaba de proponer', () => {
    const slots = [
      { fecha: '2026-09-03', horaInicio: '10:00', horaFin: '10:15' },
      { fecha: '2026-09-03', horaInicio: '17:00', horaFin: '17:15' },
      { fecha: '2026-09-03', horaInicio: '18:00', horaFin: '18:15' }
    ];
    const lastBotText =
      'El jueves 3 sep está disponible de 08:00 a 20:00, y de 20:30 a 22:00. ¿Te funciona comenzar a las 17:00 hrs?';
    assert.deepEqual(extractProposedTimesFromBotText(lastBotText), ['17:00']);

    const hit = matchSlotFromMessage('si esta perfecto', slots, { lastBotText });
    assert.ok(hit);
    assert.equal(hit.horaInicio, '17:00');
  });

  it('al decir sí, usa proposedTimes del offer si no hay texto del bot', () => {
    const slots = [
      { fecha: '2026-09-03', horaInicio: '17:00', horaFin: '17:15' },
      { fecha: '2026-09-03', horaInicio: '18:00', horaFin: '18:15' }
    ];
    const hit = matchSlotFromMessage('si esta bien', slots, {
      proposedTimes: ['17:00']
    });
    assert.ok(hit);
    assert.equal(hit.horaInicio, '17:00');
  });

  it('toma el último mensaje propio del historial', () => {
    const body = lastFromMeBody([
      { body: 'Hola', fromMe: false, timestamp: 1 },
      { body: '¿Te funciona a las 17:00 hrs?', fromMe: true, timestamp: 2 },
      { body: 'si esta perfecto', fromMe: false, timestamp: 3 }
    ]);
    assert.equal(body, '¿Te funciona a las 17:00 hrs?');
  });

  it('si el bot se desvió, recupera la última hora que sí propuso', () => {
    const now = new Date('2026-09-02T18:00:00Z');
    const slots = [
      { fecha: '2026-09-02', horaInicio: '17:00', horaFin: '17:15' },
      { fecha: '2026-09-03', horaInicio: '17:00', horaFin: '17:15' },
      { fecha: '2026-09-04', horaInicio: '17:00', horaFin: '17:15' }
    ];
    const messages = [
      {
        body: 'El jueves 3 sep está disponible de 08:00 a 20:00. ¿Te funciona comenzar a las 17:00 hrs?',
        fromMe: true,
        timestamp: 1
      },
      { body: 'si esta perfecto', fromMe: false, timestamp: 2 },
      {
        body: '¿te funciona mejor el miércoles, el jueves o el viernes?',
        fromMe: true,
        timestamp: 3
      }
    ];
    const lastBotText = lastBotProposalText(messages);
    assert.match(lastBotText, /17:00/);
    const hit = matchSlotFromMessage('si esta bien', slots, { lastBotText, now });
    assert.ok(hit);
    assert.equal(hit.fecha, '2026-09-03');
    assert.equal(hit.horaInicio, '17:00');
  });
});
