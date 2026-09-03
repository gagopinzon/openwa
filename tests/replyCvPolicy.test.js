const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const {
  formatStoredCvContext,
  replyCvPolicyInstructions
} = require('../aiService');

describe('replyCvPolicy', () => {
  it('deja claro que el PDF ya está cargado', () => {
    const text = formatStoredCvContext({
      nombre: 'Ana Pérez',
      experiencia: 'Gerente de ventas'
    });
    assert.match(text, /Ana Pérez/);
    assert.match(text, /Gerente de ventas/);
    assert.match(text, /YA está cargado/i);
    assert.match(text, /NO pidas el CV/i);
  });

  it('retorna null si no hay CV', () => {
    assert.equal(formatStoredCvContext(null), null);
  });

  it('prohíbe pedir el CV cuando ya está en el sistema', () => {
    const text = replyCvPolicyInstructions(true);
    assert.match(text, /NUNCA pidas/i);
    assert.match(text, /YA está/i);
  });

  it('también prohíbe pedirlo si el lookup falló: otro flujo lo resuelve', () => {
    const text = replyCvPolicyInstructions(false);
    assert.match(text, /NUNCA pidas/i);
    assert.match(text, /otro flujo/i);
  });
});
