const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const {
  slotKey,
  formatSlotLabel,
  collectGerenteEmails,
  mergePanelDisponibilidad,
  publicSlots,
  collapseConsecutiveRanges,
  selectOfferStarts,
  formatSlotsForPrompt,
  formatSlotsForLead,
  stripAvailabilityPromptNotes,
  filterFutureSlots,
  getMexicoNowParts,
  buildBookableVendorBlockSlots,
  intervalsOverlap,
  LEAD_DURATION_MINUTES
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

  it('selectOfferStarts: ≤4 en tramo → todas; >4 → cada hora', () => {
    assert.deepEqual(
      selectOfferStarts([
        { horaInicio: '08:00', horaFin: '08:30' },
        { horaInicio: '08:30', horaFin: '09:00' },
        { horaInicio: '09:00', horaFin: '09:30' },
        { horaInicio: '09:30', horaFin: '10:00' }
      ]),
      ['08:00', '08:30', '09:00', '09:30']
    );
    assert.deepEqual(
      selectOfferStarts([
        { horaInicio: '08:30', horaFin: '09:00' },
        { horaInicio: '09:00', horaFin: '09:30' },
        { horaInicio: '09:30', horaFin: '10:00' },
        { horaInicio: '10:00', horaFin: '10:30' },
        { horaInicio: '10:30', horaFin: '11:00' },
        { horaInicio: '11:00', horaFin: '11:30' },
        { horaInicio: '11:30', horaFin: '12:00' },
        { horaInicio: '12:00', horaFin: '12:30' }
      ]),
      ['08:30', '09:30', '10:30', '11:30']
    );
  });

  it('formatSlotsForPrompt lista horas (no rangos) y limita a 2 días', () => {
    const text = formatSlotsForPrompt(
      [
        { fecha: '2026-08-08', horaInicio: '08:30', horaFin: '09:00' },
        { fecha: '2026-08-08', horaInicio: '09:00', horaFin: '09:30' },
        { fecha: '2026-08-08', horaInicio: '09:30', horaFin: '10:00' },
        { fecha: '2026-08-08', horaInicio: '10:00', horaFin: '10:30' },
        { fecha: '2026-08-08', horaInicio: '10:30', horaFin: '11:00' },
        { fecha: '2026-08-08', horaInicio: '11:00', horaFin: '11:30' },
        { fecha: '2026-08-08', horaInicio: '11:30', horaFin: '12:00' },
        { fecha: '2026-08-08', horaInicio: '12:00', horaFin: '12:30' },
        { fecha: '2026-08-09', horaInicio: '09:00', horaFin: '09:30' },
        { fecha: '2026-08-09', horaInicio: '09:30', horaFin: '10:00' },
        { fecha: '2026-08-10', horaInicio: '11:00', horaFin: '11:30' }
      ],
      2
    );
    assert.match(text, /libres 08:30, 09:30, 10:30, 11:30/);
    assert.match(text, /libres 09:00, 09:30/);
    assert.doesNotMatch(text, /disponible de /);
    assert.doesNotMatch(text, /11:00/);
    assert.match(text, new RegExp(`${LEAD_DURATION_MINUTES} minutos`));
    assert.match(text, /Tramos reales/);
    assert.match(text, /10:30/);
  });

  it('formatSlotsForLead lista horas sin notas internas del prompt', () => {
    const text = formatSlotsForLead(
      [
        { fecha: '2026-08-08', horaInicio: '08:30', horaFin: '09:00' },
        { fecha: '2026-08-08', horaInicio: '09:00', horaFin: '09:30' },
        { fecha: '2026-08-08', horaInicio: '09:30', horaFin: '10:00' },
        { fecha: '2026-08-08', horaInicio: '10:00', horaFin: '10:30' },
        { fecha: '2026-08-08', horaInicio: '10:30', horaFin: '11:00' },
        { fecha: '2026-08-08', horaInicio: '11:00', horaFin: '11:30' },
        { fecha: '2026-08-08', horaInicio: '11:30', horaFin: '12:00' },
        { fecha: '2026-08-08', horaInicio: '12:00', horaFin: '12:30' },
        { fecha: '2026-08-09', horaInicio: '09:00', horaFin: '09:30' },
        { fecha: '2026-08-09', horaInicio: '09:30', horaFin: '10:00' }
      ],
      2,
      '2026-08-08'
    );
    assert.match(text, /libres 08:30, 09:30, 10:30, 11:30/);
    assert.match(text, /libres 09:00, 09:30/);
    assert.doesNotMatch(text, /Ofrece solo las horas/);
    assert.doesNotMatch(text, /Tramos reales/);
    assert.doesNotMatch(text, /no inventes otras/);
    assert.doesNotMatch(text, new RegExp(`${LEAD_DURATION_MINUTES} minutos`));
  });

  it('stripAvailabilityPromptNotes recorta el bloque de instrucciones', () => {
    const raw =
      'HOY (MIÉRCOLES 9 sep): libres 11:30, 12:30, 13:30\n' +
      '(La sesión dura 15 minutos. Ofrece solo las horas listadas arriba; no inventes otras. ' +
      'Respeta la etiqueta del día (HOY / MAÑANA / nombre del día).)';
    const cleaned = stripAvailabilityPromptNotes(raw);
    assert.equal(cleaned, 'HOY (MIÉRCOLES 9 sep): libres 11:30, 12:30, 13:30');
    assert.doesNotMatch(cleaned, /Ofrece solo/);
  });

  it('buildBookableVendorBlockSlots: solo starts con 45 min libres del mismo vendedor', () => {
    const atomic = [
      {
        fecha: '2026-09-09',
        horaInicio: '10:00',
        horaFin: '10:30',
        candidates: [
          { vendedorId: 'v1', gerenteEmail: 'g@x.com' },
          { vendedorId: 'v2', gerenteEmail: 'g@x.com' }
        ]
      },
      {
        fecha: '2026-09-09',
        horaInicio: '10:30',
        horaFin: '11:00',
        candidates: [{ vendedorId: 'v1', gerenteEmail: 'g@x.com' }]
      },
      {
        fecha: '2026-09-09',
        horaInicio: '11:00',
        horaFin: '11:30',
        candidates: [{ vendedorId: 'v2', gerenteEmail: 'g@x.com' }]
      }
    ];
    const bookable = buildBookableVendorBlockSlots(atomic, 45);
    assert.equal(bookable.length, 1);
    assert.equal(bookable[0].horaInicio, '10:00');
    assert.equal(bookable[0].horaFin, '10:45');
    assert.deepEqual(
      bookable[0].candidates.map((c) => c.vendedorId),
      ['v1']
    );
    assert.equal(bookable[0].leadDurationMinutes, 15);
  });

  it('buildBookableVendorBlockSlots: ofrece medias horas si hay bloque de 45 min', () => {
    const atomic = [
      {
        fecha: '2026-09-09',
        horaInicio: '10:00',
        horaFin: '10:30',
        candidates: [{ vendedorId: 'v1', gerenteEmail: 'g@x.com' }]
      },
      {
        fecha: '2026-09-09',
        horaInicio: '10:30',
        horaFin: '11:00',
        candidates: [{ vendedorId: 'v1', gerenteEmail: 'g@x.com' }]
      },
      {
        fecha: '2026-09-09',
        horaInicio: '11:00',
        horaFin: '11:30',
        candidates: [{ vendedorId: 'v1', gerenteEmail: 'g@x.com' }]
      },
      {
        fecha: '2026-09-09',
        horaInicio: '11:30',
        horaFin: '12:00',
        candidates: [{ vendedorId: 'v1', gerenteEmail: 'g@x.com' }]
      }
    ];
    const bookable = buildBookableVendorBlockSlots(atomic, 45);
    assert.deepEqual(
      bookable.map((s) => s.horaInicio),
      ['10:00', '10:30', '11:00']
    );
    assert.deepEqual(
      bookable.map((s) => s.horaFin),
      ['10:45', '11:15', '11:45']
    );
  });

  it('intervalsOverlap detecta cruce de 30 y 60 min', () => {
    assert.equal(
      intervalsOverlap(
        '2026-09-09',
        '10:00',
        '11:00',
        '2026-09-09',
        '10:30',
        '11:00'
      ),
      true
    );
    assert.equal(
      intervalsOverlap(
        '2026-09-09',
        '10:00',
        '11:00',
        '2026-09-09',
        '11:00',
        '12:00'
      ),
      false
    );
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
