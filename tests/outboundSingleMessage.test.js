const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { buildOutboundMessageParts } = require('../aiService');

describe('buildOutboundMessageParts', () => {
  it('siempre devuelve un solo mensaje con saludo + cuerpo', () => {
    const parts = buildOutboundMessageParts({
      saludo: 'Hola Ana',
      nombre: 'Ana Pérez',
      mensajeIA: 'Vi tu perfil.\n\nEn Pro Talent ayudamos.\n\n¿Te late?\n\nAtte:\n{{SENDER_NAME}}'
    });
    assert.equal(parts.length, 1);
    assert.match(parts[0], /^Hola Ana\n\n/);
    assert.match(parts[0], /Atte:/);
  });
});
