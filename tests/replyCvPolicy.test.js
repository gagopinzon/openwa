const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const {
  formatStoredCvContext,
  replyCvPolicyInstructions,
  stripCvRequestFromReply,
  looksLikeAskingForCv
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

  it('también prohíbe pedirlo aunque el lookup por teléfono falle', () => {
    const text = replyCvPolicyInstructions(false);
    assert.match(text, /NUNCA pidas/i);
    assert.match(text, /CVs ya cargados/i);
    assert.doesNotMatch(text, /solicita después/i);
  });

  describe('looksLikeAskingForCv', () => {
    it('detecta pedidos directos de CV', () => {
      assert.equal(looksLikeAskingForCv('¿me compartes tu CV?'), true);
      assert.equal(looksLikeAskingForCv('mándame tu currículum en PDF'), true);
      assert.equal(looksLikeAskingForCv('podrías enviarme tu hoja de vida'), true);
      assert.equal(looksLikeAskingForCv('necesito tu CV para agendar'), true);
      assert.equal(looksLikeAskingForCv('¿tienes un currículum actualizado?'), true);
    });

    it('no marca falsos positivos', () => {
      assert.equal(looksLikeAskingForCv('gracias por tu tiempo'), false);
      assert.equal(looksLikeAskingForCv('te comparto los horarios'), false);
      assert.equal(
        looksLikeAskingForCv('ya tenemos tu CV, ¿qué horario te acomoda?'),
        false
      );
    });
  });

  describe('stripCvRequestFromReply', () => {
    it('elimina la frase que pide CV manteniendo el resto', () => {
      const cleaned = stripCvRequestFromReply(
        '¡Qué bien, Ana! ¿Me compartes tu CV en PDF? Te propongo mañana a las 10:00.'
      );
      assert.doesNotMatch(cleaned, /cv/i);
      assert.doesNotMatch(cleaned, /currículum/i);
      assert.match(cleaned, /mañana a las 10:00/);
    });

    it('si toda la respuesta era pedir CV, retorna null para regenerar/fallback', () => {
      const cleaned = stripCvRequestFromReply(
        '¿Podrías enviarme tu currículum en PDF?'
      );
      assert.equal(cleaned, null);
    });

    it('respeta respuestas normales sin cambios', () => {
      const original = '¡Perfecto, Ana! ¿Qué horario te acomoda mejor, hoy o mañana?';
      assert.equal(stripCvRequestFromReply(original), original);
    });

    it('quita también oraciones tipo "necesito tu hoja de vida"', () => {
      const cleaned = stripCvRequestFromReply(
        'Perfecto. Necesito tu hoja de vida para revisarla. ¿Te acomoda mañana 10:00?'
      );
      assert.doesNotMatch(cleaned, /hoja de vida/i);
      assert.match(cleaned, /mañana 10:00/);
    });
  });
});
