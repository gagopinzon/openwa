const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const {
  applySenderName,
  ensureSenderPlaceholder,
  SENDER_PLACEHOLDER
} = require('../messageSignature');

describe('applySenderName', () => {
  it('reemplaza {{SENDER_NAME}}', () => {
    const msg = `Hola\n\nAtte:\n${SENDER_PLACEHOLDER}`;
    assert.equal(applySenderName(msg, 'Ana López'), 'Hola\n\nAtte:\nAna López');
  });

  it('reemplaza Sender name literal', () => {
    const msg = 'Hola\n\nAtte:\nSender name';
    assert.equal(applySenderName(msg, 'Ana López'), 'Hola\n\nAtte:\nAna López');
  });

  it('reemplaza [YOUR_NAME] después de Atte:', () => {
    const msg = '¿Te gustaría agendar?\n\nAtte:\n[YOUR_NAME]';
    assert.equal(applySenderName(msg, 'Ana López'), '¿Te gustaría agendar?\n\nAtte:\nAna López');
  });

  it('reemplaza Pro Talent después de Atte: sin tocar el cuerpo', () => {
    const msg =
      'En Pro Talent ayudamos a expertos como tú.\n\n¿Te gustaría agendar?\n\nAtte:\nPro Talent';
    assert.equal(
      applySenderName(msg, 'Ana López'),
      'En Pro Talent ayudamos a expertos como tú.\n\n¿Te gustaría agendar?\n\nAtte:\nAna López'
    );
  });

  it('reemplaza cualquier firma inventada después de Atte:', () => {
    const msg = 'Hola\n\nAtte:\n{{SENDER}}';
    assert.equal(applySenderName(msg, 'Carlos Ruiz'), 'Hola\n\nAtte:\nCarlos Ruiz');
  });
});

describe('ensureSenderPlaceholder', () => {
  it('fuerza {{SENDER_NAME}} cuando el modelo firma con Pro Talent', () => {
    const msg = 'Vi tu perfil.\n\nEn Pro Talent ayudamos.\n\nAtte:\nPro Talent';
    assert.equal(
      ensureSenderPlaceholder(msg),
      `Vi tu perfil.\n\nEn Pro Talent ayudamos.\n\nAtte:\n${SENDER_PLACEHOLDER}`
    );
  });

  it('fuerza {{SENDER_NAME}} cuando el modelo firma con [YOUR_NAME]', () => {
    const msg = '¿Te gustaría agendar?\n\nAtte:\n[YOUR_NAME]';
    assert.equal(
      ensureSenderPlaceholder(msg),
      `¿Te gustaría agendar?\n\nAtte:\n${SENDER_PLACEHOLDER}`
    );
  });

  it('agrega Atte: + placeholder si el modelo omitió la firma', () => {
    const msg = 'Vi tu perfil y me pareció sólido.';
    assert.equal(
      ensureSenderPlaceholder(msg),
      `Vi tu perfil y me pareció sólido.\n\nAtte:\n${SENDER_PLACEHOLDER}`
    );
  });
});
