const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const {
  normalizePreferredName,
  preferredFirstName,
  resolveAiContactName,
  phraseWithName,
  buildWhatsAppNameGuard,
  sanitizeReplyWhatsAppName
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

  it('buildWhatsAppNameGuard prohíbe el nick si difiere del CV', () => {
    const block = buildWhatsAppNameGuard({
      whatsappName: 'jymmy',
      preferredName: 'Jaime López'
    });
    assert.match(block, /jymmy/i);
    assert.match(block, /Jaime/i);
    assert.match(block, /PROHIBIDO|NUNCA/i);
  });

  it('sanitizeReplyWhatsAppName reemplaza nick WA por nombre del CV', () => {
    const out = sanitizeReplyWhatsAppName('Hola jymmy, ¿cómo estás?', {
      whatsappName: 'jymmy',
      preferredName: 'Jaime López'
    });
    assert.match(out, /Jaime/i);
    assert.doesNotMatch(out, /jymmy/i);
  });

  it('sanitizeReplyWhatsAppName quita nick WA si no hay nombre de CV', () => {
    const out = sanitizeReplyWhatsAppName('Hola Abogada, gusto saludarte', {
      whatsappName: 'Abogada',
      preferredName: null
    });
    assert.doesNotMatch(out, /Abogada/i);
    assert.match(out, /Hola/i);
  });

  it('sanitizeReplyWhatsAppName no toca si el nick es el mismo que el CV', () => {
    const out = sanitizeReplyWhatsAppName('Hola Ana, todo bien', {
      whatsappName: 'Ana',
      preferredName: 'Ana García'
    });
    assert.match(out, /Ana/);
  });
});
