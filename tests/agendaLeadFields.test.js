const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const {
  getRequiredLeadFields,
  leadFieldSnapshotFromCv,
  listMissingLeadFields,
  parseLeadFieldsReply,
  parseLeadFieldsReplyAsync,
  normalizeOllamaLeadFields,
  mergeLeadFieldParses,
  patchFromParsedLeadFields,
  buildAskMissingLeadFieldsReply,
  isAwaitingLeadData
} = require('../agendaLeadFields');

describe('agendaLeadFields', () => {
  it('por defecto pide ciudad y estado', () => {
    assert.deepEqual(getRequiredLeadFields(), ['ciudad', 'estado']);
  });

  it('detecta campos faltantes en el CV', () => {
    const missing = listMissingLeadFields(
      leadFieldSnapshotFromCv({ nombre: 'Ana', leadCorreo: 'a@test.com' })
    );
    assert.deepEqual(missing, ['ciudad', 'estado']);
  });

  it('no pide lo que ya está en el CV', () => {
    const missing = listMissingLeadFields(
      leadFieldSnapshotFromCv({
        leadCiudad: 'Guadalajara',
        leadEstado: 'Jalisco',
        leadCorreo: 'a@test.com'
      })
    );
    assert.deepEqual(missing, []);
  });

  it('parsea ciudad en frases tipo "vivo en Zapopan"', () => {
    const parsed = parseLeadFieldsReply('vivo en Zapopan', ['ciudad', 'estado']);
    assert.equal(parsed.ciudad, 'Zapopan');
    assert.equal(parsed.estado, undefined);
  });

  it('normaliza JSON de Ollama a campos limpios', () => {
    const parsed = normalizeOllamaLeadFields(
      { ciudad: '  Zapopan ', estado: 'Jalisco', email: 'x@y.com' },
      ['ciudad', 'estado']
    );
    assert.equal(parsed.ciudad, 'Zapopan');
    assert.equal(parsed.estado, 'Jalisco');
    assert.equal(parsed.email, undefined);
  });

  it('combina regex + Ollama sin pisar lo ya detectado', () => {
    const merged = mergeLeadFieldParses(
      { ciudad: 'Zapopan' },
      { ciudad: 'Otra', estado: 'Jalisco' },
      ['ciudad', 'estado']
    );
    assert.equal(merged.ciudad, 'Zapopan');
    assert.equal(merged.estado, 'Jalisco');
  });

  it('usa Ollama para inferir estado cuando falta', async () => {
    const parsed = await parseLeadFieldsReplyAsync('vivo en Zapopan', ['ciudad', 'estado'], {
      llmParse: async () => ({ ciudad: 'Zapopan', estado: 'Jalisco' })
    });
    assert.equal(parsed.ciudad, 'Zapopan');
    assert.equal(parsed.estado, 'Jalisco');
  });

  it('parsea ciudad y estado separados por coma', () => {
    const parsed = parseLeadFieldsReply('Guadalajara, Jalisco', ['ciudad', 'estado']);
    assert.equal(parsed.ciudad, 'Guadalajara');
    assert.equal(parsed.estado, 'Jalisco');
  });

  it('parsea "Guadalajara. Estado Jalisco"', () => {
    const parsed = parseLeadFieldsReply('Guadalajara. Estado Jalisco', [
      'ciudad',
      'estado'
    ]);
    assert.equal(parsed.ciudad, 'Guadalajara');
    assert.equal(parsed.estado, 'Jalisco');
  });

  it('parsea correo si falta', () => {
    const parsed = parseLeadFieldsReply('mi mail es gago@gmail.com', ['email']);
    assert.equal(parsed.email, 'gago@gmail.com');
  });

  it('arma mensaje amigable pidiendo ciudad y estado', () => {
    const msg = buildAskMissingLeadFieldsReply('Gago', ['ciudad', 'estado']);
    assert.match(msg, /Gago/i);
    assert.match(msg, /ciudad/i);
    assert.match(msg, /estado/i);
  });

  it('convierte parsed fields a patch del manifest', () => {
    assert.deepEqual(patchFromParsedLeadFields({ ciudad: 'CDMX', estado: 'CDMX' }), {
      leadCiudad: 'CDMX',
      ciudad: 'CDMX',
      leadEstado: 'CDMX',
      estado: 'CDMX'
    });
  });

  it('identifica etapa need_lead_data', () => {
    assert.equal(isAwaitingLeadData('need_lead_data'), true);
    assert.equal(isAwaitingLeadData('confirm_cv'), false);
  });
});
