const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { applySenderName, SENDER_PLACEHOLDER } = require('../messageSignature');

describe('applySenderName', () => {
  it('reemplaza {{SENDER_NAME}}', () => {
    const msg = `Hola\n\nAtte:\n${SENDER_PLACEHOLDER}`;
    assert.equal(applySenderName(msg, 'Ana López'), 'Hola\n\nAtte:\nAna López');
  });

  it('reemplaza Sender name literal', () => {
    const msg = 'Hola\n\nAtte:\nSender name';
    assert.equal(applySenderName(msg, 'Ana López'), 'Hola\n\nAtte:\nAna López');
  });
});
