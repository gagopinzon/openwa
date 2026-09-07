const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const {
  normalizePreferredName,
  preferredFirstName,
  resolveAiContactName,
  phraseWithName
} = require('../preferredContactName');

describe('preferredContactName', () => {
  it('normalizePreferredName rechaza placeholders', () => {
    assert.equal(normalizePreferredName('(sin nombre)'), '');
    assert.equal(normalizePreferredName('contacto'), '');
    assert.equal(normalizePreferredName('  Ana María  '), 'Ana María');
  });

  it('preferredFirstName capitaliza solo el primer nombre', () => {
    assert.equal(preferredFirstName('ana maría'), 'Ana');
    assert.equal(preferredFirstName(''), '');
    assert.equal(preferredFirstName('(sin nombre)'), '');
  });

  it('resolveAiContactName prioriza preferredName y CV; nunca inventa', () => {
    assert.equal(
      resolveAiContactName({
        preferredName: 'Ana CV',
        sessionName: 'WhatsAppNick',
        leadCvNombre: 'Otro'
      }),
      'Ana CV'
    );
    assert.equal(
      resolveAiContactName({
        preferredName: null,
        leadCvNombre: 'Luis Lead',
        sessionName: 'NickWA'
      }),
      'Luis Lead'
    );
    assert.equal(
      resolveAiContactName({
        sessionName: 'NickWA',
        preferredName: null,
        leadCvNombre: null
      }),
      null
    );
  });

  it('nunca usa el nombre de WhatsApp aunque haya cvId u outreach', () => {
    assert.equal(
      resolveAiContactName({
        sessionName: 'jymmy',
        preferredName: null,
        leadCvNombre: null,
        cvId: 'cv-jaime',
        lastOutboundAt: new Date().toISOString()
      }),
      null
    );
    assert.equal(
      resolveAiContactName({
        sessionName: 'jymmy',
        preferredName: null,
        leadCvNombre: 'Jaime López',
        cvId: 'cv-jaime'
      }),
      'Jaime López'
    );
    assert.equal(
      resolveAiContactName({
        sessionName: 'jymmy',
        preferredName: 'Jaime López',
        leadCvNombre: null,
        cvId: 'cv-jaime'
      }),
      'Jaime López'
    );
  });

  it('phraseWithName omite coma si no hay nombre', () => {
    assert.equal(phraseWithName('Perfecto', 'Ana'), 'Perfecto, Ana');
    assert.equal(phraseWithName('Perfecto', null), 'Perfecto');
    assert.equal(phraseWithName('¡Qué bien', 'Luis') + '!', '¡Qué bien, Luis!');
  });
});
