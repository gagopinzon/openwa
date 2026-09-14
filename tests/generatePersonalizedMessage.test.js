const { describe, it, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const ollamaService = require('../ollamaService');
const { generatePersonalizedMessage } = require('../aiService');

describe('generatePersonalizedMessage (Ollama)', () => {
  let origConfigured;
  let origChat;
  let origGetModel;

  beforeEach(() => {
    origConfigured = ollamaService.isConfigured;
    origChat = ollamaService.chatReply;
    origGetModel = ollamaService.getModel;
  });

  afterEach(() => {
    ollamaService.isConfigured = origConfigured;
    ollamaService.chatReply = origChat;
    ollamaService.getModel = origGetModel;
  });

  it('usa Ollama con skipMonica y parsea SALUDO/MENSAJE', async () => {
    let seenOpts = null;
    ollamaService.isConfigured = () => true;
    ollamaService.chatReply = async (prompt, opts) => {
      seenOpts = opts;
      assert.match(String(prompt), /Gerente de Producción/);
      return `SALUDO: Hola Ana
MENSAJE:
Vi tu trayectoria en planta y destaca tu liderazgo operativo.

En Pro Talent conectamos perfiles como el tuyo con vacantes clave en Gerencia de Producción.

¿Te interesaría una sesión gratuita de diagnóstico?

Atte:
{{SENDER}}`;
    };

    const out = await generatePersonalizedMessage(
      'Ana López',
      'Gerente de Producción en ACME 2020-2024'
    );

    assert.equal(seenOpts?.skipMonica, true);
    assert.match(out.saludo, /Ana/i);
    assert.match(out.mensajeIA, /Pro Talent/);
    assert.doesNotMatch(out.mensajeIA, /^SALUDO:/i);
  });

  it('cae a plantilla si Ollama no está configurado', async () => {
    ollamaService.isConfigured = () => false;
    ollamaService.chatReply = async () => {
      throw new Error('no debería llamarse');
    };

    const out = await generatePersonalizedMessage(
      'Carlos Ruiz',
      'Supervisor de Calidad'
    );

    assert.match(out.saludo, /Carlos/i);
    assert.match(out.mensajeIA, /Pro Talent/);
    assert.match(out.mensajeIA, /Atte:/i);
  });

  it('cae a plantilla si Ollama falla', async () => {
    ollamaService.isConfigured = () => true;
    ollamaService.getModel = () => 'test-model';
    ollamaService.chatReply = async () => {
      throw new Error('Ollama HTTP 500');
    };

    const out = await generatePersonalizedMessage(
      'María Pérez',
      'Directora de Operaciones'
    );

    assert.match(out.saludo, /María/i);
    assert.match(out.mensajeIA, /Pro Talent/);
  });
});
