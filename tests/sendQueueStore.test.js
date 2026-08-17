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

const sampleCvs2 = [
  {
    archivoOriginal: 'b.pdf',
    nombre: 'Bob',
    telefono: '5215559998877',
    mensajeIA: 'Hola Bob',
    saludo: 'Hola',
    cvId: '2'
  }
];

describe('sendQueueStore', () => {
  let backup;

  beforeEach(() => {
    backup = fs.existsSync(STORE_FILE) ? fs.readFileSync(STORE_FILE, 'utf8') : null;
    fs.mkdirSync(path.dirname(STORE_FILE), { recursive: true });
    fs.writeFileSync(
      STORE_FILE,
      JSON.stringify(
        { version: 2, scheduleDefaults: { morning: '10:30', afternoon: '16:00' }, batches: [] },
        null,
        2
      )
    );
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

  it('permite segundo enqueue mientras hay lote scheduled', () => {
    const future = new Date(Date.now() + 60 * 60 * 1000).toISOString();
    store.enqueue({
      cvs: sampleCvs,
      selectedSessions: ['s1'],
      sessionWeights: null,
      scheduledAt: future
    });
    const b2 = store.enqueue({
      cvs: sampleCvs2,
      selectedSessions: ['s1'],
      sessionWeights: null,
      scheduledAt: new Date(Date.now() + 2 * 60 * 60 * 1000).toISOString()
    });
    assert.equal(b2.status, 'scheduled');
    assert.equal(store.getBatches().length, 2);
    assert.equal(store.canEnqueue(), true);
  });

  it('slot morning/afternoon calcula scheduledAt mañana', () => {
    const batch = store.enqueue({
      cvs: sampleCvs,
      selectedSessions: ['s1'],
      sessionWeights: null,
      slot: 'morning'
    });
    assert.equal(batch.status, 'scheduled');
    assert.equal(batch.slot, 'morning');
    const when = new Date(batch.scheduledAt);
    assert.equal(when.getHours(), 10);
    assert.equal(when.getMinutes(), 30);
    const tomorrow = new Date();
    tomorrow.setDate(tomorrow.getDate() + 1);
    assert.equal(when.getDate(), tomorrow.getDate());
  });

  it('markSending quema botón; markSent libera; se puede encolar más', () => {
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
    assert.equal(store.getSendingBatch(), null);
    assert.equal(store.buttonBurned(), false);
    assert.equal(store.canEnqueue(), true);
  });

  it('no permite dos sending a la vez', () => {
    store.enqueue({
      cvs: sampleCvs,
      selectedSessions: ['s1'],
      sessionWeights: null,
      scheduledAt: null
    });
    store.enqueue({
      cvs: sampleCvs2,
      selectedSessions: ['s1'],
      sessionWeights: null,
      scheduledAt: null
    });
    store.markSending();
    assert.throws(() => store.markSending(), (err) => err.status === 409);
  });

  it('cancel por batchId con varios lotes', () => {
    const a = store.enqueue({
      cvs: sampleCvs,
      selectedSessions: ['s1'],
      sessionWeights: null,
      scheduledAt: null
    });
    const b = store.enqueue({
      cvs: sampleCvs2,
      selectedSessions: ['s1'],
      sessionWeights: null,
      scheduledAt: null
    });
    const c = store.cancel(a.id);
    assert.equal(c.status, 'cancelled');
    assert.equal(store.getBatchById(b.id).status, 'queued');
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
    assert.equal(store.getSendingBatch().id, batch.id);
  });

  it('recoverOrphanSending marca sending como sent', () => {
    store.beginDirectSend({
      cvs: sampleCvs,
      selectedSessions: ['s1'],
      sessionWeights: null,
      scheduledAt: null
    });
    const n = store.recoverOrphanSending();
    assert.equal(n, 1);
    assert.equal(store.getSendingBatch(), null);
    assert.equal(store.getBatches()[0].status, 'sent');
    assert.equal(store.getBatches()[0].recoveredOrphan, true);
  });

  it('migra store v1 batch único a batches[]', () => {
    const legacy = {
      version: 1,
      batch: {
        id: 'legacy1',
        status: 'scheduled',
        cvs: sampleCvs,
        selectedSessions: ['s1'],
        sessionWeights: null,
        scheduledAt: new Date(Date.now() + 3600000).toISOString(),
        createdAt: new Date().toISOString(),
        total: 1,
        sendingAt: null,
        sentAt: null,
        cancelledAt: null
      }
    };
    fs.writeFileSync(STORE_FILE, JSON.stringify(legacy));
    const batches = store.getBatches();
    assert.equal(batches.length, 1);
    assert.equal(batches[0].id, 'legacy1');
  });

  it('finishAll aborta sending y queued y deja la cola vacía', () => {
    const sending = store.enqueue({
      cvs: sampleCvs,
      selectedSessions: ['s1'],
      sessionWeights: null,
      scheduledAt: null
    });
    store.enqueue({
      cvs: sampleCvs2,
      selectedSessions: ['s1'],
      sessionWeights: null,
      scheduledAt: null
    });
    store.enqueue({
      cvs: sampleCvs,
      selectedSessions: ['s1'],
      sessionWeights: null,
      scheduledAt: new Date(Date.now() + 3600000).toISOString()
    });
    store.markSending(sending.id);

    const result = store.finishAll();
    assert.equal(result.finished.length, 3);
    assert.ok(result.finished.every((b) => b.status === 'cancelled' && b.finishedByUser));
    assert.equal(store.getBatches().length, 0);
    assert.equal(store.getSendingBatch(), null);
    assert.equal(store.buttonBurned(), false);
    assert.equal(store.canEnqueue(), true);
    assert.equal(store.canDispatch(), false);
  });

  it('finishAll sin lotes activos no falla', () => {
    const result = store.finishAll();
    assert.equal(result.finished.length, 0);
    assert.equal(store.getBatches().length, 0);
  });

  it('getNextScheduledBatch elige el más temprano', () => {
    const later = new Date(Date.now() + 3 * 3600000).toISOString();
    const sooner = new Date(Date.now() + 3600000).toISOString();
    store.enqueue({
      cvs: sampleCvs,
      selectedSessions: ['s1'],
      sessionWeights: null,
      scheduledAt: later
    });
    const early = store.enqueue({
      cvs: sampleCvs2,
      selectedSessions: ['s1'],
      sessionWeights: null,
      scheduledAt: sooner
    });
    assert.equal(store.getNextScheduledBatch().id, early.id);
  });
});
