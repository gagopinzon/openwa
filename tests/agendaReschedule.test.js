const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { wantsRescheduleMeeting } = require('../agendaIntent');
const { preferSameVendor } = require('../agendaRescheduleService');

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
