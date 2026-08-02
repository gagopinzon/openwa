const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const {
  slotKey,
  formatSlotLabel,
  collectGerenteEmails,
  mergePanelDisponibilidad,
  publicSlots,
  collapseConsecutiveRanges,
  formatSlotsForPrompt,
  filterFutureSlots,
  getMexicoNowParts
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

  it('collapseConsecutiveRanges une bloques seguidos', () => {
    const ranges = collapseConsecutiveRanges([
      { horaInicio: '08:30', horaFin: '09:00' },
      { horaInicio: '09:00', horaFin: '09:30' },
      { horaInicio: '09:30', horaFin: '10:00' },
      { horaInicio: '11:00', horaFin: '11:30' }
    ]);
    assert.deepEqual(ranges, [
      { horaInicio: '08:30', horaFin: '10:00' },
      { horaInicio: '11:00', horaFin: '11:30' }
    ]);
  });

  it('formatSlotsForPrompt habla en rangos de 15 min', () => {
    const text = formatSlotsForPrompt(
      [
        { fecha: '2026-08-08', horaInicio: '08:30', horaFin: '09:00' },
        { fecha: '2026-08-08', horaInicio: '09:00', horaFin: '09:30' },
        { fecha: '2026-08-08', horaInicio: '09:30', horaFin: '10:00' },
        { fecha: '2026-08-08', horaInicio: '10:00', horaFin: '10:30' },
        { fecha: '2026-08-08', horaInicio: '10:30', horaFin: '11:00' },
        { fecha: '2026-08-08', horaInicio: '11:00', horaFin: '11:30' },
        { fecha: '2026-08-08', horaInicio: '11:30', horaFin: '12:00' },
        { fecha: '2026-08-08', horaInicio: '12:00', horaFin: '12:30' }
      ],
      3
    );
    assert.match(text, /disponible de 08:30 a 12:30/);
    assert.match(text, /15 minutos/);
    assert.doesNotMatch(text, /08:30–09:00/);
  });

  it('filterFutureSlots quita horas ya pasadas el mismo día', () => {
    const now = new Date();
    const { ymd, minutes } = getMexicoNowParts(now);
    const slots = [
      { fecha: ymd, horaInicio: '08:00', horaFin: '08:30' },
      { fecha: ymd, horaInicio: '23:59', horaFin: '00:29' },
      { fecha: '2099-01-01', horaInicio: '09:00', horaFin: '09:30' }
    ];
    const future = filterFutureSlots(slots, now, 15);
    assert.ok(future.some((s) => s.fecha === '2099-01-01'));
    if (minutes >= 8 * 60 + 15) {
      assert.ok(!future.some((s) => s.fecha === ymd && s.horaInicio === '08:00'));
    }
  });
});
