const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const {
  mergeExtractedCvFields,
  normalizeMxPhone,
  extractCvFieldsWithAi
} = require('../cvAnalysisService');

const CV_SIN_FORMATO = [
  'CURRICULUM VITAE',
  'Lic. en Administración',
  'JUAN CARLOS PÉREZ RAMÍREZ',
  'Tel. 33 1234 5678 | juan.perez@gmail.com',
  'Vivo en Zapopan',
  'Trabajé 5 años como Coordinador de Compras en Grupo Bimbo, actualmente Gerente de Abastecimiento en Lala.'
].join('\n');

describe('normalizeMxPhone', () => {
  it('agrega +52 a 10 dígitos', () => {
    assert.equal(normalizeMxPhone('33 1234 5678'), '+523312345678');
  });
  it('quita el 1 de 521', () => {
    assert.equal(normalizeMxPhone('+52 1 33 1234 5678'), '+523312345678');
  });
  it('rechaza números cortos', () => {
    assert.equal(normalizeMxPhone('12345'), '');
  });
});

describe('mergeExtractedCvFields', () => {
  it('usa los datos de la IA en un CV sin estructura', () => {
    const ai = {
      nombre: 'JUAN CARLOS PÉREZ RAMÍREZ',
      telefono: '33 1234 5678',
      correo: 'juan.perez@gmail.com',
      ciudad: 'Zapopan',
      estado: 'Jalisco',
      ultimoTrabajo: 'Gerente de Abastecimiento',
      ultimaEmpresa: 'Lala',
      experiencia: 'Gerente de Abastecimiento en Lala; antes Coordinador de Compras en Grupo Bimbo.',
      puestos: ['Gerente de Abastecimiento', 'Gerente de Compras', 'Jefe de Compras', 'Supply Manager'],
      aniosExperiencia: 5
    };
    const out = mergeExtractedCvFields(ai, CV_SIN_FORMATO, 'ollama');
    assert.equal(out.nombre, 'Juan Carlos Pérez Ramírez');
    assert.equal(out.telefono, '+523312345678');
    assert.equal(out.correo, 'juan.perez@gmail.com');
    assert.equal(out.leadCorreo, 'juan.perez@gmail.com');
    assert.equal(out.ciudad, 'Zapopan');
    assert.equal(out.estado, 'Jalisco');
    assert.equal(out.leadEstado, 'Jalisco');
    assert.equal(out.ultimoTrabajo, 'Gerente de Abastecimiento');
    assert.equal(out.puestos.length, 4);
    assert.equal(out.aniosExperiencia, 5);
    assert.equal(out.extractionProvider, 'ollama');
    assert.equal(out.panelAnalisis.localidad.estado, 'Jalisco');
  });

  it('descarta teléfono/correo inventados por la IA y usa regex', () => {
    const out = mergeExtractedCvFields(
      { nombre: 'Juan', telefono: '55 9999 0000', correo: 'otro@fake.com' },
      CV_SIN_FORMATO,
      'ollama'
    );
    assert.equal(out.telefono, '+523312345678');
    assert.equal(out.correo, 'juan.perez@gmail.com');
  });

  it('sin IA cae a regex sin romper', () => {
    const out = mergeExtractedCvFields(null, CV_SIN_FORMATO, 'regex');
    assert.equal(out.telefono, '+523312345678');
    assert.equal(out.correo, 'juan.perez@gmail.com');
    assert.ok(out.nombre);
  });

  it('extractCvFieldsWithAi usa regex si el proveedor es regex', async () => {
    const prev = process.env.CV_ANALYSIS_PROVIDER;
    process.env.CV_ANALYSIS_PROVIDER = 'regex';
    try {
      const out = await extractCvFieldsWithAi(CV_SIN_FORMATO);
      assert.equal(out.extractionProvider, 'regex');
      assert.equal(out.telefono, '+523312345678');
    } finally {
      if (prev == null) delete process.env.CV_ANALYSIS_PROVIDER;
      else process.env.CV_ANALYSIS_PROVIDER = prev;
    }
  });
});
