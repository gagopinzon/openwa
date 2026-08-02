const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const {
  slotKey,
  formatSlotLabel,
  collectGerenteEmails,
  mergePanelDisponibilidad,
  publicSlots
} = require('../agendaAvailability');

describe('agendaAvailability', () => {
  it('slotKey y formatSlotLabel', () => {
    assert.equal(slotKey('2026-08-02', '10:00', '10:30'), '2026-08-02|10:00|10:30');
    const label = formatSlotLabel({
      fecha: '2026-08-02',
      horaInicio: '10:00',
      horaFin: '10:30'
    });
    assert.match(label, /10:00/);
    assert.match(label, /ago/);
  });

  it('collectGerenteEmails dedupe y lowercase', () => {
    const emails = collectGerenteEmails({
      users: [
        { gerenteEmail: 'A@ProTalent.com' },
        { gerenteEmail: 'a@protalent.com' },
        { gerenteEmail: '' },
        { gerenteEmail: 'otro@x.com' }
      ],
      superEmail: 'super@x.com',
      envEmail: 'env@x.com'
    });
    assert.deepEqual(emails, [
      'a@protalent.com',
      'env@x.com',
      'otro@x.com',
      'super@x.com'
    ]);
  });

  it('merge: mismo horario de dos gerentes → un slot con 2 candidates', () => {
    const merged = mergePanelDisponibilidad([
      {
        gerenteEmail: 'g1@x.com',
        data: {
          vendedores: [
            {
              id: 'v1',
              nombre: 'Ana',
              disponibilidad: [
                { fecha: '2026-08-02', horaInicio: '10:00', horaFin: '10:30' }
              ]
            }
          ]
        }
      },
      {
        gerenteEmail: 'g2@x.com',
        data: {
          vendedores: [
            {
              id: 'v2',
              nombre: 'Luis',
              disponibilidad: [
                { fecha: '2026-08-02', horaInicio: '10:00', horaFin: '10:30' },
                { fecha: '2026-08-02', horaInicio: '11:00', horaFin: '11:30' }
              ]
            }
          ]
        }
      },
      { gerenteEmail: 'g3@x.com', error: 'timeout' }
    ]);

    assert.equal(merged.gerentesConsultados, 2);
    assert.equal(merged.erroresGerente.length, 1);
    assert.equal(merged.slots.length, 2);
    const ten = merged.slots.find((s) => s.horaInicio === '10:00');
    assert.ok(ten);
    assert.equal(ten.candidates.length, 2);
    assert.equal(publicSlots(merged.slots, 1).length, 1);
    assert.equal(publicSlots(merged.slots, 1)[0].candidates, undefined);
  });
});
