const { describe, it, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const ollamaService = require('../ollamaService');
const cvFileStore = require('../cvFileStore');
const { ensureCvAnalyzed, isCvAnalizadoEnMsg, buildPanelAnalisisCv } = require('../cvAnalysisService');

const AI_JSON = JSON.stringify({
  ultimaExperiencia: 'Gerente de Ventas en ACME',
  evaluaciones: {
    estructura: { puntuacion: 5, explicacion: 'Secciones desordenadas.' },
    perfil: { puntuacion: 6, explicacion: 'Titular poco claro.' },
    experiencia: { puntuacion: 7, explicacion: 'Falta impacto medible.' },
    visibilidad: { puntuacion: 4, explicacion: 'Pocas palabras clave.' },
    empleabilidad: { puntuacion: 6, explicacion: 'Perfil sólido, CV débil.' }
  },
  recomendaciones: ['Cuantificar logros'],
  puesto: ['Gerente de Ventas', 'Jefe Comercial', 'Key Account Manager', 'Director Comercial'],
  localidad: { ciudad: 'Monterrey', estado: 'Nuevo León' },
  contacto: { nombre: 'Nombre De La IA', email: 'ana@test.com', telefono: '8111111111' }
});

// CV ya extraído al subir (tiene correo) pero sin diagnóstico real.
const EXISTING = {
  cvId: 'cv-test-1',
  nombre: 'Ana Pérez (editado a mano)',
  telefono: '+528122223333',
  correo: 'ana@test.com',
  leadCorreo: 'ana@test.com',
  email: 'ana@test.com',
  ultimoTrabajo: 'Gerente de Ventas'
};

describe('ensureCvAnalyzed requireDiagnostico', () => {
  const orig = {};
  let updates;
  let chatCalls;

  beforeEach(() => {
    orig.load = cvFileStore.loadCvsManifest;
    orig.read = cvFileStore.readCvFileBuffer;
    orig.update = cvFileStore.updateCvEntry;
    orig.chat = ollamaService.chatReply;
    orig.provider = process.env.CV_ANALYSIS_PROVIDER;
    orig.debug = process.env.AGENDA_DEBUG;
    orig.url = process.env.OLLAMA_URL;
    process.env.OLLAMA_URL = 'http://127.0.0.1:1/api/chat';
    process.env.CV_ANALYSIS_PROVIDER = 'ollama';
    process.env.AGENDA_DEBUG = 'false';
    updates = [];
    chatCalls = 0;
    cvFileStore.loadCvsManifest = () => [{ ...EXISTING }];
    cvFileStore.readCvFileBuffer = () => Buffer.from('no-es-pdf ana@test.com Gerente de Ventas en ACME Monterrey');
    cvFileStore.updateCvEntry = (id, patch) => {
      updates.push(patch);
      return { ...EXISTING, ...patch, cvId: id };
    };
  });

  afterEach(() => {
    cvFileStore.loadCvsManifest = orig.load;
    cvFileStore.readCvFileBuffer = orig.read;
    cvFileStore.updateCvEntry = orig.update;
    ollamaService.chatReply = orig.chat;
    if (orig.provider == null) delete process.env.CV_ANALYSIS_PROVIDER;
    else process.env.CV_ANALYSIS_PROVIDER = orig.provider;
    if (orig.debug == null) delete process.env.AGENDA_DEBUG;
    else process.env.AGENDA_DEBUG = orig.debug;
    if (orig.url == null) delete process.env.OLLAMA_URL;
    else process.env.OLLAMA_URL = orig.url;
  });

  it('sin requireDiagnostico usa cache si ya hay correo (no llama a la IA)', async () => {
    ollamaService.chatReply = async () => {
      chatCalls += 1;
      return AI_JSON;
    };
    const out = await ensureCvAnalyzed('cv-test-1');
    assert.equal(chatCalls, 0);
    assert.equal(out.nombre, EXISTING.nombre);
  });

  it('con requireDiagnostico corre Ollama y devuelve diagnóstico real para el panel', async () => {
    ollamaService.chatReply = async () => {
      chatCalls += 1;
      return AI_JSON;
    };
    const out = await ensureCvAnalyzed('cv-test-1', { requireDiagnostico: true });
    assert.equal(chatCalls, 1);
    assert.equal(out.analysisProvider, 'ollama');
    const analisis = buildPanelAnalisisCv(out);
    assert.equal(isCvAnalizadoEnMsg(out, analisis), true);
    assert.equal(analisis.evaluaciones.visibilidad.puntuacion, 4);
    // conserva nombre/teléfono ya guardados
    assert.equal(out.nombre, EXISTING.nombre);
    assert.equal(out.telefono, EXISTING.telefono);
    assert.equal(updates.length, 1);
    assert.ok(updates[0].panelAnalisis.evaluaciones);
  });

  it('si Ollama falla no pisa los datos existentes', async () => {
    ollamaService.chatReply = async () => {
      chatCalls += 1;
      throw new Error('ECONNREFUSED');
    };
    const out = await ensureCvAnalyzed('cv-test-1', { requireDiagnostico: true });
    assert.equal(chatCalls, 1);
    assert.equal(updates.length, 0);
    assert.equal(out.ultimoTrabajo, 'Gerente de Ventas');
  });

  it('si ya tiene diagnóstico real no vuelve a llamar a la IA', async () => {
    cvFileStore.loadCvsManifest = () => [
      {
        ...EXISTING,
        analysisProvider: 'ollama',
        panelAnalisis: { evaluaciones: JSON.parse(AI_JSON).evaluaciones }
      }
    ];
    ollamaService.chatReply = async () => {
      chatCalls += 1;
      return AI_JSON;
    };
    await ensureCvAnalyzed('cv-test-1', { requireDiagnostico: true });
    assert.equal(chatCalls, 0);
  });
});

describe('cvFileStore persiste diagnóstico IA', () => {
  const input = {
    cvId: 'x',
    ultimoTrabajo: 'Gerente',
    puestos: ['Gerente', 'Jefe'],
    panelAnalisis: { evaluaciones: { perfil: { puntuacion: 5, explicacion: 'x' } }, textoExtraido: 'largo' }
  };
  for (const fnName of ['sanitizeCvForPersist', 'hydrateStoredCv']) {
    it(`${fnName} conserva panelAnalisis (sin texto completo), ultimoTrabajo y puestos`, () => {
      const cv = cvFileStore[fnName](input);
      assert.equal(cv.ultimoTrabajo, 'Gerente');
      assert.deepEqual(cv.puestos, ['Gerente', 'Jefe']);
      assert.ok(cv.panelAnalisis.evaluaciones);
      assert.equal(cv.panelAnalisis.textoExtraido, undefined);
    });
  }
});
