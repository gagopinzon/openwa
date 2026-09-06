const { describe, it, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const contactHistory = require('../contactHistoryStore');

describe('dedupeCvsByPhone', () => {
  it('deja un solo CV cuando el mismo número viene con formatos distintos', () => {
    const { unique, duplicates } = contactHistory.dedupeCvsByPhone([
      { nombre: 'Ana', telefono: '3312345678' },
      { nombre: 'Ana 2', telefono: '+52 33 1234 5678' },
      { nombre: 'Ana 3', telefono: '5213312345678' },
      { nombre: 'Luis', telefono: '5587654321' }
    ]);
    assert.equal(unique.length, 2);
    assert.equal(unique[0].nombre, 'Ana');
    assert.equal(unique[1].nombre, 'Luis');
    assert.equal(duplicates.length, 2);
  });
});

describe('resolvePauseTargetPhone', () => {
  const { resolvePauseTargetPhone, aiPausedFromContactDocs } = contactHistory;

  it('usa el contacto existente por LID, no los dígitos del chat @lid', () => {
    const target = resolvePauseTargetPhone({
      requestedPhone: '188119869571223',
      chatId: '188119869571223@lid',
      whatsappLid: '188119869571223',
      existingByLid: { normalizedPhone: '5215512345678' }
    });
    assert.equal(target, '5215512345678');
  });

  it('usa el contacto fuzzy (52 vs 521) en vez de crear otra clave', () => {
    const target = resolvePauseTargetPhone({
      requestedPhone: '5213312345678',
      chatId: '5213312345678@c.us',
      existingByFuzzy: { normalizedPhone: '3312345678' }
    });
    assert.equal(target, '3312345678');
  });

  it('si el chat es @lid y no hay contacto, guarda lid_* y no los dígitos crudos', () => {
    const target = resolvePauseTargetPhone({
      requestedPhone: '188119869571223',
      chatId: '188119869571223@lid',
      whatsappLid: '188119869571223'
    });
    assert.equal(target, 'lid_188119869571223');
  });

  it('aiPausedFromContactDocs es true si CUALQUIER documento relacionado está pausado', () => {
    assert.equal(
      aiPausedFromContactDocs([
        { normalizedPhone: '3312345678', aiPaused: false },
        { normalizedPhone: '188119869571223', aiPaused: true }
      ]),
      true
    );
    assert.equal(
      aiPausedFromContactDocs([{ normalizedPhone: '3312345678', aiPaused: false }]),
      false
    );
  });
});

describe('marca local al enviar', () => {
  beforeEach(() => {
    contactHistory.clearLocalSentCache();
  });

  it('tras rememberSuccessfulSend, shouldSendToPhone es false aunque el formato cambie', async () => {
    assert.equal(contactHistory.wasAlreadySentLocal('3312345678'), false);
    contactHistory.rememberSuccessfulSend('3312345678');
    assert.equal(await contactHistory.shouldSendToPhone('+52 33 1234 5678'), false);
    assert.equal(await contactHistory.shouldSendToPhone('5213312345678'), false);
  });

  it('recordSuccessfulContact marca local aunque no haya Mongo', async () => {
    const prev = process.env.MONGODB_URI;
    delete process.env.MONGODB_URI;
    try {
      await contactHistory.recordSuccessfulContact({
        normalizedPhone: '5219981112233',
        name: 'Maria'
      });
      assert.equal(contactHistory.wasAlreadySentLocal('9981112233'), true);
      assert.equal(await contactHistory.shouldSendToPhone('5219981112233'), false);
    } finally {
      if (prev !== undefined) process.env.MONGODB_URI = prev;
    }
  });
});
