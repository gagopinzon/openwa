const { describe, it, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const os = require('os');
// Archivo propio: no tocar data/send-queue.json real ni chocar con otros tests en paralelo.
const STORE_FILE = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'sendq-')), 'send-queue.json');
process.env.SEND_QUEUE_STORE_FILE = STORE_FILE;
const store = require('../sendQueueStore');
delete process.env.SEND_QUEUE_STORE_FILE;

const cvs = [
  { nombre: 'Ana', telefono: '5215551110001', mensajeIA: 'Hola Ana', cvId: '1' },
  { nombre: 'Bob', telefono: '5215551110002', mensajeIA: 'Hola Bob', cvId: '2' },
  { nombre: 'Cy', telefono: '5215551110003', mensajeIA: 'Hola Cy', cvId: '3' },
  { nombre: 'Di', telefono: '5215551110004', mensajeIA: 'Hola Di', cvId: '4' }
];

function startSendingBatch() {
  const batch = store.enqueue({ cvs, selectedSessions: ['s1'], scheduledAt: null });
  store.markSending(batch.id);
  store.startProgress(batch.id, { total: cvs.length });
  return batch.id;
}

describe('sendQueueStore progreso y reanudación', () => {
  let backup;
  beforeEach(() => {
    backup = fs.existsSync(STORE_FILE) ? fs.readFileSync(STORE_FILE, 'utf8') : null;
    fs.mkdirSync(path.dirname(STORE_FILE), { recursive: true });
    fs.writeFileSync(STORE_FILE, JSON.stringify({ version: 2, batches: [] }));
  });
  afterEach(() => {
    if (backup == null) fs.rmSync(STORE_FILE, { force: true });
    else fs.writeFileSync(STORE_FILE, backup);
  });

  it('cuenta enviados y deja pendientes solo a los que faltan', () => {
    const id = startSendingBatch();
    store.recordResult(id, { telefono: '+52 1 555 111 0001', success: true });
    store.recordResult(id, { telefono: '5215551110002', success: false, error: 'invalid_number' });
    const batch = store.getBatchById(id);
    assert.equal(batch.progress.sent, 1);
    assert.equal(batch.progress.failed, 1);
    assert.deepEqual(store.getPendingCvs(batch).map((c) => c.nombre), ['Cy', 'Di']);
  });

  it('un fallo temporal queda pendiente y se vuelve definitivo tras 3 intentos', () => {
    const id = startSendingBatch();
    store.recordResult(id, { telefono: '5215551110003', success: false, error: 'no_healthy_sessions' });
    let batch = store.getBatchById(id);
    assert.equal(batch.progress.failed, 0);
    assert.ok(store.getPendingCvs(batch).some((c) => c.nombre === 'Cy'));
    store.recordResult(id, { telefono: '5215551110003', success: false, error: 'timeout' });
    store.recordResult(id, { telefono: '5215551110003', success: false, error: 'timeout' });
    batch = store.getBatchById(id);
    assert.equal(batch.progress.failed, 1);
    assert.ok(!store.getPendingCvs(batch).some((c) => c.nombre === 'Cy'));
  });

  it('no cuenta dos veces el mismo teléfono', () => {
    const id = startSendingBatch();
    store.recordResult(id, { telefono: '5215551110001', success: true });
    store.recordResult(id, { telefono: '5551110001', success: true });
    assert.equal(store.getBatchById(id).progress.sent, 1);
  });

  it('requeueForResume reprograma con lo pendiente y conserva el progreso', () => {
    const id = startSendingBatch();
    store.recordResult(id, { telefono: '5215551110001', success: true });
    const r = store.requeueForResume(id, { delayMs: 1000, reason: 'error', error: 'boom' });
    assert.equal(r.pending, 3);
    const batch = store.getBatchById(id);
    assert.equal(batch.status, 'scheduled');
    assert.equal(batch.resumePending, true);
    assert.equal(batch.progress.resumeCount, 1);
    assert.equal(batch.progress.sent, 1);
    // puede volver a enviarse
    const again = store.markSending(id);
    assert.equal(again.status, 'sending');
  });

  it('requeueForResume sin pendientes marca el lote como enviado', () => {
    const id = startSendingBatch();
    for (const cv of cvs) store.recordResult(id, { telefono: cv.telefono, success: true });
    const r = store.requeueForResume(id, { delayMs: 0 });
    assert.equal(r.pending, 0);
    assert.equal(store.getBatchById(id).status, 'sent');
  });

  it('tras reinicio: con resume reprograma lo pendiente; sin resume lo da por enviado', () => {
    const id = startSendingBatch();
    store.recordResult(id, { telefono: '5215551110001', success: true });
    assert.equal(store.recoverOrphanSending({ resume: true, delayMs: 30000 }), 1);
    let batch = store.getBatchById(id);
    assert.equal(batch.status, 'scheduled');
    assert.equal(batch.progress.lastResumeReason, 'restart');

    store.markSending(id);
    assert.equal(store.recoverOrphanSending({ resume: false }), 1);
    batch = store.getBatchById(id);
    assert.equal(batch.status, 'sent');
  });

  it('guarda el resumen del último lote terminado', () => {
    store.setLastFinished({ batchId: 'x', total: 4, sent: 3, failed: 1 });
    const last = store.getLastFinished();
    assert.equal(last.sent, 3);
    assert.ok(last.finishedAt);
  });

  it('escritura atómica: no deja archivo temporal', () => {
    startSendingBatch();
    assert.equal(fs.existsSync(`${STORE_FILE}.tmp`), false);
  });
});
