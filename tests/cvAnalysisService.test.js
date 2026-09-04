const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const ollamaService = require('../ollamaService');
const {
  parseJsonObject,
  analyzeCvText,
  extractLooseSignalsFromPdfBuffer,
  preserveFilledLeadFields,
  buildPanelAnalisisCv,
  isCvAnalizadoEnMsg
} = require('../cvAnalysisService');

const AI_ANALISIS = {
  contacto: {
    nombre: 'María López',
    email: 'maria@empresa.com',
    telefono: '5511112222'
  },
  localidad: { ciudad: 'Monterrey', estado: 'Nuevo León' },
  puesto: ['Gerente de Operaciones', 'Jefe de Planta', 'Coordinador de Logística', 'Supervisor de Producción'],
  ultimaExperiencia: 'Gerente de Operaciones en ACME (2021-2024)',
  evaluaciones: {
    estructura: {
      puntuacion: 4,
      explicacion: 'El CV mezcla fechas y no agrupa logros con métricas.'
    },
    perfil: {
      puntuacion: 5,
      explicacion: 'El titular no deja claro el posicionamiento profesional.'
    },
    experiencia: {
      puntuacion: 6,
      explicacion: 'La última experiencia describe tareas, no impacto.'
    },
    visibilidad: {
      puntuacion: 3,
      explicacion: 'Faltan palabras clave que un reclutador buscaría.'
    },
    empleabilidad: {
      puntuacion: 5,
      explicacion: 'El perfil es contratables pero el CV no lo demuestra.'
    }
  },
  recomendaciones: [
    'Añadir logros cuantificados en la última experiencia',
    'Incluir un titular de 8-12 palabras',
    'Ordenar secciones por relevancia para operaciones'
  ]
};

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
      assert.equal(isCvAnalizadoEnMsg({ analysisProvider: 'regex' }, out), false);
    } finally {
      if (prev == null) delete process.env.CV_ANALYSIS_PROVIDER;
      else process.env.CV_ANALYSIS_PROVIDER = prev;
    }
  });

  it('usa el diagnóstico de la IA y no el stub de puntuación 7', () => {
    const panel = buildPanelAnalisisCv({
      nombre: 'María López',
      correo: 'maria@empresa.com',
      telefono: '5511112222',
      analysisProvider: 'ollama',
      panelAnalisis: AI_ANALISIS,
      textoCompleto: 'CV de María'
    });
    assert.equal(panel.evaluaciones.estructura.puntuacion, 4);
    assert.match(panel.evaluaciones.estructura.explicacion, /métricas/);
    assert.deepEqual(panel.puesto.slice(0, 2), [
      'Gerente de Operaciones',
      'Jefe de Planta'
    ]);
    assert.equal(panel.recomendaciones.length, 3);
    assert.equal(panel.ultimaExperiencia, 'Gerente de Operaciones en ACME (2021-2024)');
    assert.equal(isCvAnalizadoEnMsg({ analysisProvider: 'ollama' }, panel), true);
  });

  it('pide a Ollama el diagnóstico completo sin el persona de Mónica', async () => {
    const prevProvider = process.env.CV_ANALYSIS_PROVIDER;
    process.env.CV_ANALYSIS_PROVIDER = 'ollama';
    const origConfigured = ollamaService.isConfigured;
    const origChat = ollamaService.chatReply;
    let captured = null;
    ollamaService.isConfigured = () => true;
    ollamaService.chatReply = async (prompt, opts) => {
      captured = { prompt, opts };
      return JSON.stringify(AI_ANALISIS);
    };
    try {
      const out = await analyzeCvText(
        'María López\nGerente de Operaciones en ACME\nmaria@empresa.com',
        { nombre: 'María' }
      );
      assert.ok(captured);
      assert.match(captured.prompt, /evaluaciones/i);
      assert.match(captured.prompt, /recomendaciones/i);
      assert.equal(captured.opts && captured.opts.skipMonica, true);
      assert.equal(out.analysisProvider, 'ollama');
      assert.equal(out.leadCorreo, 'maria@empresa.com');
      assert.equal(out.panelAnalisis.evaluaciones.estructura.puntuacion, 4);
      const panel = buildPanelAnalisisCv(out);
      assert.equal(panel.evaluaciones.visibilidad.puntuacion, 3);
      assert.equal(isCvAnalizadoEnMsg(out, panel), true);
    } finally {
      ollamaService.isConfigured = origConfigured;
      ollamaService.chatReply = origChat;
      if (prevProvider == null) delete process.env.CV_ANALYSIS_PROVIDER;
      else process.env.CV_ANALYSIS_PROVIDER = prevProvider;
    }
  });
});
