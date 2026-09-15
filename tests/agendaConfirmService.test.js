const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { resolveRankedVendors } = require('../agendaConfirmService');

describe('resolveRankedVendors', () => {
  it('pide disponibilidad sin cache al confirmar', async () => {
    const calls = [];
    await resolveRankedVendors(
      {
        id: 'p1',
        fecha: '2026-09-14',
        horaInicio: '10:00',
        horaFin: '10:30'
      },
      [{ vendedorId: 'v1', gerenteEmail: 'g@x.com' }],
      {
        getDisponibilidad: async (params) => {
          calls.push(params);
          return { vendedores: [] };
        }
      }
    );
    assert.equal(calls.length, 1);
    assert.equal(calls[0].skipCache, true);
    assert.equal(calls[0].gerenteEmail, 'g@x.com');
    assert.equal(calls[0].fechaInicio, '2026-09-14');
    assert.equal(calls[0].fechaFin, '2026-09-14');
  });
});
