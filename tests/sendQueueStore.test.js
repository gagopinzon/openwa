const { describe, it, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const STORE_FILE = path.join(__dirname, '..', 'data', 'send-queue.json');
const store = require('../sendQueueStore');

const sampleCvs = [
  {
    archivoOriginal: 'a.pdf',
    nombre: 'Ana',
    telefono: '5215551112233',
    mensajeIA: 'Hola Ana',
    saludo: 'Hola',
    cvId: '1'
  }
];

describe('sendQueueStore', () => {
  let backup;

  beforeEach(() => {
    backup = fs.existsSync(STORE_FILE) ? fs.readFileSync(STORE_FILE, 'utf8') : null;
    fs.mkdirSync(path.dirname(STORE_FILE), { recursive: true });
    fs.writeFileSync(STORE_FILE, JSON.stringify({ version: 1, batch: null }, null, 2));
  });

  afterEach(() => {
    if (backup !== null) fs.writeFileSync(STORE_FILE, backup);
    else if (fs.existsSync(STORE_FILE)) fs.unlinkSync(STORE_FILE);
  });

  it('enqueue crea queued sin scheduledAt', () => {
    const batch = store.enqueue({
      cvs: sampleCvs,
      selectedSessions: ['s1'],
      sessionWeights: { s1: 1 },
      scheduledAt: null
    });
    assert.equal(batch.status, 'queued');
    assert.equal(batch.total, 1);
    assert.equal(store.canDispatch(), true);
    assert.equal(store.buttonBurned(), false);
  });

  it('enqueue con fecha futura → scheduled', () => {
    const future = new Date(Date.now() + 60 * 60 * 1000).toISOString();
    const batch = store.enqueue({
      cvs: sampleCvs,
      selectedSessions: ['s1'],
      sessionWeights: null,
      scheduledAt: future
    });
    assert.equal(batch.status, 'scheduled');
    assert.equal(batch.scheduledAt, future);
  });

  it('enqueue con fecha pasada → 400', () => {
    assert.throws(
      () =>
        store.enqueue({
          cvs: sampleCvs,
          selectedSessions: ['s1'],
          sessionWeights: null,
          scheduledAt: '2020-01-01T00:00:00.000Z'
        }),
      (err) => err.status === 400
    );
  });

  it('enqueue con scheduledAt inválido → 400', () => {
    assert.throws(
      () =>
        store.enqueue({
          cvs: sampleCvs,
          selectedSessions: ['s1'],
          sessionWeights: null,
          scheduledAt: 'not-a-date'
        }),
      (err) => err.status === 400
    );
  });

  it('segundo enqueue activo → 409', () => {
    store.enqueue({
      cvs: sampleCvs,
      selectedSessions: ['s1'],
      sessionWeights: null,
      scheduledAt: null
    });
    assert.throws(
      () =>
        store.enqueue({
          cvs: sampleCvs,
          selectedSessions: ['s1'],
          sessionWeights: null,
          scheduledAt: null
        }),
      (err) => err.status === 409
    );
  });

  it('markSending quema botón; markSent mantiene burned; luego canEnqueue', () => {
    store.enqueue({
      cvs: sampleCvs,
      selectedSessions: ['s1'],
      sessionWeights: null,
      scheduledAt: null
    });
    store.markSending();
    assert.equal(store.buttonBurned(), true);
    assert.equal(store.canDispatch(), false);
    store.markSent();
    assert.equal(store.getBatch().status, 'sent');
    assert.equal(store.buttonBurned(), true);
    assert.equal(store.canEnqueue(), true);
  });

  it('cancel solo en queued/scheduled', () => {
    store.enqueue({
      cvs: sampleCvs,
      selectedSessions: ['s1'],
      sessionWeights: null,
      scheduledAt: null
    });
    const c = store.cancel();
    assert.equal(c.status, 'cancelled');
    assert.equal(store.canEnqueue(), true);
    assert.equal(store.buttonBurned(), false);
  });

  it('tras sent se puede encolar de nuevo (reemplaza)', () => {
    store.enqueue({
      cvs: sampleCvs,
      selectedSessions: ['s1'],
      sessionWeights: null,
      scheduledAt: null
    });
    store.markSending();
    store.markSent();
    const b2 = store.enqueue({
      cvs: sampleCvs,
      selectedSessions: ['s2'],
      sessionWeights: null,
      scheduledAt: null
    });
    assert.equal(b2.status, 'queued');
    assert.equal(b2.selectedSessions[0], 's2');
  });

  it('beginDirectSend crea batch ya en sending', () => {
    const batch = store.beginDirectSend({
      cvs: sampleCvs,
      selectedSessions: ['s1'],
      sessionWeights: { s1: 1 },
      scheduledAt: null
    });
    assert.equal(batch.status, 'sending');
    assert.equal(store.buttonBurned(), true);
    assert.equal(store.canDispatch(), false);
  });

  it('clearBatch rechaza un lote en sending y conserva el estado', () => {
    const batch = store.beginDirectSend({
      cvs: sampleCvs,
      selectedSessions: ['s1'],
      sessionWeights: null,
      scheduledAt: null
    });

    assert.throws(
      () => store.clearBatch(),
      (err) => err.status === 409
    );
    assert.equal(store.getBatch().id, batch.id);
    assert.equal(store.getBatch().status, 'sending');
  });
});
