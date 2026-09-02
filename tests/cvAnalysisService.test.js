const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const {
  parseJsonObject,
  analyzeCvText,
  extractLooseSignalsFromPdfBuffer,
  preserveFilledLeadFields
} = require('../cvAnalysisService');

describe('cvAnalysisService', () => {
  it('parsea JSON embebido en markdown', () => {
    const parsed = parseJsonObject('```json\n{"nombre":"Ana","email":"ana@test.com"}\n```');
    assert.equal(parsed.nombre, 'Ana');
    assert.equal(parsed.email, 'ana@test.com');
  });

  it('extrae email suelto del binario del PDF', () => {
    const buf = Buffer.from('foo bar candidato@protalent.com baz', 'utf8');
    const loose = extractLooseSignalsFromPdfBuffer(buf);
    assert.equal(loose.emails[0], 'candidato@protalent.com');
  });

  it('no pisa ciudad/estado que el lead ya escribió si el PDF viene vacío', () => {
    const kept = preserveFilledLeadFields(
      { leadCiudad: 'Guadalajara', leadEstado: 'Jalisco', ciudad: 'Guadalajara' },
      { leadCiudad: '', ciudad: '', leadEstado: '', estado: '', nombre: 'Gago' }
    );
    assert.equal(kept.leadCiudad, 'Guadalajara');
    assert.equal(kept.leadEstado, 'Jalisco');
    assert.equal(kept.nombre, 'Gago');
  });

  it('analiza texto con regex sin Ollama forzado', async () => {
    const prev = process.env.CV_ANALYSIS_PROVIDER;
    process.env.CV_ANALYSIS_PROVIDER = 'regex';
    try {
      const out = await analyzeCvText(
        'Juan Pérez\nGerente de planta\njuan.perez@mail.com\n+52 55 1234 5678',
        { nombre: 'Juan' }
      );
      assert.match(out.correo, /@/);
      assert.equal(out.analysisProvider, 'regex');
    } finally {
      if (prev == null) delete process.env.CV_ANALYSIS_PROVIDER;
      else process.env.CV_ANALYSIS_PROVIDER = prev;
    }
  });
});
