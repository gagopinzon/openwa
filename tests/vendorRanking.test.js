const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const {
  normalizePonderacion,
  normalizeTotalCitas,
  loadRatio,
  compareVendorsForSlot,
  indexPanelVendors,
  rankVendorsForSlot,
  vendorHasSlot
} = require('../vendorRanking');

describe('vendorRanking', () => {
  it('normalizePonderacion defaults y clamp', () => {
    assert.equal(normalizePonderacion(undefined), 1);
    assert.equal(normalizePonderacion(null), 1);
    assert.equal(normalizePonderacion('x'), 1);
    assert.equal(normalizePonderacion(0), 1);
    assert.equal(normalizePonderacion(9), 5);
    assert.equal(normalizePonderacion(3.6), 4);
  });

  it('normalizeTotalCitas defaults', () => {
    assert.equal(normalizeTotalCitas(undefined), 0);
    assert.equal(normalizeTotalCitas(-2), 0);
    assert.equal(normalizeTotalCitas(2.9), 2);
  });

  it('loadRatio equilibra: 5★ con 3 citas pierde ante 3★ con 0', () => {
    assert.ok(loadRatio(3, 5) > loadRatio(0, 3));
    const a = { vendedorId: 'a', ponderacionReuniones: 5, totalCitas: 3 };
    const b = { vendedorId: 'b', ponderacionReuniones: 3, totalCitas: 0 };
    assert.ok(compareVendorsForSlot(b, a) < 0);
  });

  it('en ratio 0 gana mayor ponderación', () => {
    const a = { vendedorId: 'a', ponderacionReuniones: 5, totalCitas: 0 };
    const b = { vendedorId: 'b', ponderacionReuniones: 3, totalCitas: 0 };
    assert.ok(compareVendorsForSlot(a, b) < 0);
  });

  it('vendorHasSlot exacto', () => {
    const v = {
      disponibilidad: [
        { fecha: '2026-09-08', horaInicio: '10:00', horaFin: '10:30' }
      ]
    };
    assert.equal(vendorHasSlot(v, '2026-09-08', '10:00', '10:30'), true);
    assert.equal(vendorHasSlot(v, '2026-09-08', '11:00', '11:30'), false);
  });

  it('vendorHasSlot cubre bloque de 45 min con dos medias horas', () => {
    const v = {
      disponibilidad: [
        { fecha: '2026-09-08', horaInicio: '10:00', horaFin: '10:30' },
        { fecha: '2026-09-08', horaInicio: '10:30', horaFin: '11:00' }
      ]
    };
    assert.equal(vendorHasSlot(v, '2026-09-08', '10:00', '10:45'), true);
    assert.equal(vendorHasSlot(v, '2026-09-08', '10:30', '11:15'), false);
  });

  it('rankVendorsForSlot: orden por ratio y excluye sin slot', () => {
    const panelIndex = indexPanelVendors([
      {
        gerenteEmail: 'g@x.com',
        data: {
          vendedores: [
            {
              id: 'v5',
              ponderacionReuniones: 5,
              totalCitas: 3,
              disponibilidad: [
                { fecha: '2026-09-08', horaInicio: '10:00', horaFin: '10:30' }
              ]
            },
            {
              id: 'v3',
              ponderacionReuniones: 3,
              totalCitas: 0,
              disponibilidad: [
                { fecha: '2026-09-08', horaInicio: '10:00', horaFin: '10:30' }
              ]
            },
            {
              id: 'vBusy',
              ponderacionReuniones: 5,
              totalCitas: 0,
              disponibilidad: []
            }
          ]
        }
      }
    ]);

    const ranked = rankVendorsForSlot({
      candidates: [
        { vendedorId: 'v5', gerenteEmail: 'g@x.com' },
        { vendedorId: 'vBusy', gerenteEmail: 'g@x.com' },
        { vendedorId: 'v3', gerenteEmail: 'g@x.com' }
      ],
      panelIndex,
      fecha: '2026-09-08',
      horaInicio: '10:00',
      horaFin: '10:30'
    });

    assert.deepEqual(
      ranked.map((v) => v.vendedorId),
      ['v3', 'v5']
    );
    assert.equal(ranked[0].totalCitas, 0);
    assert.equal(ranked[0].ponderacionReuniones, 3);
  });

  it('sin panelIndex mantiene candidatos con defaults', () => {
    const ranked = rankVendorsForSlot({
      candidates: [
        { vendedorId: 'b', gerenteEmail: 'g@x.com' },
        { vendedorId: 'a', gerenteEmail: 'g@x.com' }
      ],
      panelIndex: null,
      fecha: '2026-09-08',
      horaInicio: '10:00',
      horaFin: '10:30'
    });
    assert.deepEqual(
      ranked.map((v) => v.vendedorId),
      ['a', 'b']
    );
  });
});
