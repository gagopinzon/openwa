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
      assert.match(String(prompt), /ÚLTIMO TRABAJO/);
      return `SALUDO: Hola Ana
MENSAJE:
Vi tu trayectoria en planta y destaca tu liderazgo operativo.

En PROTALENT conectamos perfiles como el tuyo con vacantes clave en Gerencia de Producción.

¿Te interesaría una sesión de diagnóstico?

Atte:
{{SENDER}}`;
    };

    const out = await generatePersonalizedMessage(
      'Ana López',
      'Gerente de Producción en ACME 2020-2024',
      'Gerente de Producción'
    );

    assert.equal(seenOpts?.skipMonica, true);
    assert.match(out.saludo, /Ana/i);
    assert.match(out.mensajeIA, /PROTALENT|Pro Talent/i);
    assert.match(out.mensajeIA, /Atte:\n\{\{SENDER_NAME\}\}/);
    assert.doesNotMatch(out.mensajeIA, /^SALUDO:/i);
  });

  it('corrige firma Pro Talent o [YOUR_NAME] del modelo a {{SENDER_NAME}}', async () => {
    ollamaService.isConfigured = () => true;
    ollamaService.chatReply = async () => `SALUDO: Buen día César
MENSAJE:
Tu trayectoria en riesgos es impresionante.

En Pro Talent ayudamos a expertos como tú.

¿Te gustaría agendar una sesión gratuita?

Atte:
Pro Talent`;

    const withCompany = await generatePersonalizedMessage(
      'César López',
      'Jefe de Riesgos'
    );
    assert.match(withCompany.mensajeIA, /Atte:\n\{\{SENDER_NAME\}\}/);
    assert.doesNotMatch(withCompany.mensajeIA, /Atte:\s*\n\s*Pro Talent/i);

    ollamaService.chatReply = async () => `SALUDO: Hola César
MENSAJE:
¿Te gustaría agendar una sesión gratuita de diagnóstico?

Atte:
[YOUR_NAME]`;

    const withPlaceholder = await generatePersonalizedMessage(
      'César López',
      'Jefe de Riesgos'
    );
    assert.match(withPlaceholder.mensajeIA, /Atte:\n\{\{SENDER_NAME\}\}/);
    assert.doesNotMatch(withPlaceholder.mensajeIA, /YOUR_NAME/);
  });

  it('cae a plantilla si Ollama no está configurado', async () => {
    ollamaService.isConfigured = () => false;
    ollamaService.chatReply = async () => {
      throw new Error('no debería llamarse');
    };

    const out = await generatePersonalizedMessage(
      'Carlos Ruiz',
      'Supervisor de Calidad',
      'Supervisor de Calidad'
    );

    assert.match(out.saludo, /Carlos/i);
    assert.match(out.mensajeIA, /PROTALENT|Pro Talent/i);
    assert.match(out.mensajeIA, /Atte:/i);
    assert.match(out.mensajeIA, /Supervisor de Calidad/);
  });

  it('cae a plantilla si Ollama falla', async () => {
    ollamaService.isConfigured = () => true;
    ollamaService.getModel = () => 'test-model';
    ollamaService.chatReply = async () => {
      throw new Error('Ollama HTTP 500');
    };

    const out = await generatePersonalizedMessage(
      'María Pérez',
      'Directora de Operaciones',
      'Directora de Operaciones'
    );

    assert.match(out.saludo, /María/i);
    assert.match(out.mensajeIA, /PROTALENT|Pro Talent/i);
    assert.match(out.mensajeIA, /Directora de Operaciones/);
  });
});
