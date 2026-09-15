const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { wantsRescheduleMeeting } = require('../agendaIntent');
const {
  preferSameVendor,
  isSameConfirmedSlot,
  shouldAttemptReschedule
} = require('../agendaRescheduleService');

const CONFIRMED = {
  id: 'c1',
  status: 'confirmed',
  fecha: '2026-09-16',
  horaInicio: '15:00',
  horaFin: '15:45',
  vendedorId: 'vendor-a',
  confirmedAt: '2026-09-15T18:00:00.000Z'
};

describe('wantsRescheduleMeeting', () => {
  it('detecta mover / cambiar cita', () => {
    assert.equal(wantsRescheduleMeeting('puedo mover la cita a mañana?'), true);
    assert.equal(wantsRescheduleMeeting('quiero cambiar el horario'), true);
    assert.equal(wantsRescheduleMeeting('reagendar para el jueves'), true);
    assert.equal(wantsRescheduleMeeting('otro día me queda mejor'), true);
  });

  it('no confunde con mensajes normales', () => {
    assert.equal(wantsRescheduleMeeting('ok gracias'), false);
    assert.equal(wantsRescheduleMeeting('me interesa agendar'), false);
  });
});

describe('preferSameVendor', () => {
  it('pone primero al vendedor actual', () => {
    const ordered = preferSameVendor(
      [
        { vendedorId: 'a', gerenteEmail: 'a@x.com' },
        { vendedorId: 'b', gerenteEmail: 'b@x.com' },
        { vendedorId: 'c', gerenteEmail: 'c@x.com' }
      ],
      'b'
    );
    assert.equal(ordered[0].vendedorId, 'b');
    assert.equal(ordered.length, 3);
  });

  it('sin preferido deja el orden', () => {
    const list = [
      { vendedorId: 'a' },
      { vendedorId: 'b' }
    ];
    assert.deepEqual(preferSameVendor(list, null), list);
  });
});

describe('isSameConfirmedSlot', () => {
  it('compara fecha y hora de inicio', () => {
    assert.equal(
      isSameConfirmedSlot(CONFIRMED, { fecha: '2026-09-16', horaInicio: '15:00' }),
      true
    );
    assert.equal(
      isSameConfirmedSlot(CONFIRMED, { fecha: '2026-09-16', horaInicio: '15:00:00' }),
      true
    );
    assert.equal(
      isSameConfirmedSlot(CONFIRMED, { fecha: '2026-09-16', horaInicio: '17:00' }),
      false
    );
    assert.equal(
      isSameConfirmedSlot(CONFIRMED, { fecha: '2026-09-17', horaInicio: '15:00' }),
      false
    );
  });
});

describe('shouldAttemptReschedule', () => {
  it('no reagenda si el lead solo confirma o sigue la conversación', () => {
    assert.equal(shouldAttemptReschedule('ok', CONFIRMED), false);
    assert.equal(shouldAttemptReschedule('perfecto', CONFIRMED), false);
    assert.equal(shouldAttemptReschedule('listo', CONFIRMED), false);
    assert.equal(shouldAttemptReschedule('sí', CONFIRMED), false);
    assert.equal(shouldAttemptReschedule('ok gracias', CONFIRMED), false);
    assert.equal(shouldAttemptReschedule('gracias, ahí estaré', CONFIRMED), false);
    assert.equal(shouldAttemptReschedule('¿qué debo llevar?', CONFIRMED), false);
  });

  it('no reagenda si repite la misma hora ya confirmada', () => {
    assert.equal(shouldAttemptReschedule('perfecto a las 15:00', CONFIRMED), false);
    assert.equal(shouldAttemptReschedule('nos vemos a las 15:00', CONFIRMED), false);
  });

  it('reagenda solo si pide mover o elige otra hora', () => {
    assert.equal(shouldAttemptReschedule('quiero cambiar el horario', CONFIRMED), true);
    assert.equal(shouldAttemptReschedule('puedo mover la cita a mañana?', CONFIRMED), true);
    assert.equal(shouldAttemptReschedule('mejor a las 17:00', CONFIRMED), true);
    assert.equal(shouldAttemptReschedule('a las 11:00 me queda mejor', CONFIRMED), true);
  });

  it('si hay oferta de reagendado, el sí solo vale para otro horario', () => {
    const leftoverOffer = {
      createdAt: '2026-09-15T17:00:00.000Z',
      slots: [{ fecha: '2026-09-16', horaInicio: '17:00' }],
      proposedSlot: { fecha: '2026-09-16', horaInicio: '17:00' }
    };
    const sameOffer = {
      createdAt: '2026-09-15T18:30:00.000Z',
      slots: [{ fecha: '2026-09-16', horaInicio: '15:00' }],
      proposedSlot: { fecha: '2026-09-16', horaInicio: '15:00' }
    };
    const otherOffer = {
      createdAt: '2026-09-15T18:30:00.000Z',
      slots: [{ fecha: '2026-09-16', horaInicio: '17:00' }],
      proposedSlot: { fecha: '2026-09-16', horaInicio: '17:00' }
    };
    assert.equal(shouldAttemptReschedule('sí', CONFIRMED, { priorOffer: leftoverOffer }), false);
    assert.equal(shouldAttemptReschedule('sí', CONFIRMED, { priorOffer: sameOffer }), false);
    assert.equal(shouldAttemptReschedule('sí', CONFIRMED, { priorOffer: otherOffer }), true);
    assert.equal(
      shouldAttemptReschedule('a las 17:00', CONFIRMED, { priorOffer: otherOffer }),
      true
    );
  });
});

describe('handleReschedule', () => {
  it('no toca la cita si el lead solo dice ok', async () => {
    const { handleReschedule } = require('../agendaRescheduleService');
    const result = await handleReschedule({
      confirmed: { ...CONFIRMED, panelReunionId: 'r1' },
      body: 'ok'
    });
    assert.equal(result.handled, false);
    assert.equal(result.reason, 'no_reschedule_intent');
  });
});
