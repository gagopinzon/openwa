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
