const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { formatConversationHistoryForPrompt } = require('../aiService');

describe('formatConversationHistoryForPrompt', () => {
  it('formatea mensajes cronológicos con etiquetas Tú/Lead', () => {
    const text = formatConversationHistoryForPrompt(
      [
        { body: 'Hola', fromMe: false, timestamp: 1 },
        { body: 'Qué tal, ¿te interesa?', fromMe: true, timestamp: 2 },
        { body: 'Sí', fromMe: false, timestamp: 3 }
      ],
      6
    );
    assert.match(text, /Lead: Hola/);
    assert.match(text, /Tú: Qué tal/);
    assert.match(text, /Lead: Sí/);
  });

  it('limita a maxLines', () => {
    const text = formatConversationHistoryForPrompt(
      [
        { body: 'uno', fromMe: false, timestamp: 1 },
        { body: 'dos', fromMe: true, timestamp: 2 },
        { body: 'tres', fromMe: false, timestamp: 3 }
      ],
      2
    );
    const lines = text.split('\n');
    assert.equal(lines.length, 2);
    assert.match(lines[0], /dos/);
    assert.match(lines[1], /tres/);
  });

  it('retorna null si no hay mensajes', () => {
    assert.equal(formatConversationHistoryForPrompt([], 6), null);
    assert.equal(formatConversationHistoryForPrompt(null, 6), null);
  });
});
