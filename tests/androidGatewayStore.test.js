const { describe, it, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const STORE_FILE = path.join(__dirname, '..', 'data', 'android-gateway.json');
const store = require('../androidGatewayStore');

describe('androidGatewayStore', () => {
  let backup;

  beforeEach(() => {
    backup = fs.existsSync(STORE_FILE) ? fs.readFileSync(STORE_FILE, 'utf8') : null;
    fs.mkdirSync(path.dirname(STORE_FILE), { recursive: true });
    fs.writeFileSync(
      STORE_FILE,
      JSON.stringify(
        { version: 1, minIntervalMs: 1000, claimTimeoutMs: 60_000, devices: [], jobs: [] },
        null,
        2
      )
    );
  });

  afterEach(() => {
    if (backup !== null) fs.writeFileSync(STORE_FILE, backup);
    else if (fs.existsSync(STORE_FILE)) fs.unlinkSync(STORE_FILE);
  });

  it('registerDevice crea y reutiliza deviceId', () => {
    const a = store.registerDevice({ label: 'Linea 1', logicalSessionId: 'session1' });
    assert.ok(a.id);
    assert.equal(a.label, 'Linea 1');
    const b = store.registerDevice({ label: 'Linea 1b', deviceId: a.id });
    assert.equal(b.id, a.id);
    assert.equal(b.label, 'Linea 1b');
  });

  it('enqueue + claim + report ok', () => {
    const device = store.registerDevice({ label: 'A' });
    const jobs = store.enqueueJobs(
      [{ telefono: '5215551112233', mensaje: 'Hola', nombre: 'Ana' }],
      [device.id]
    );
    assert.equal(jobs.length, 1);
    assert.equal(jobs[0].status, 'pending');

    const claimed = store.claimNextJob({ deviceId: device.id });
    assert.equal(claimed.id, jobs[0].id);
    assert.equal(claimed.status, 'claimed');

    const done = store.reportJobResult({
      jobId: claimed.id,
      deviceId: device.id,
      ok: true
    });
    assert.equal(done.status, 'sent');
  });

  it('claim respeta minInterval tras un envío', () => {
    const device = store.registerDevice({ label: 'A' });
    store.enqueueJobs(
      [
        { telefono: '5215551112233', mensaje: 'Uno' },
        { telefono: '5215551112244', mensaje: 'Dos' }
      ],
      [device.id]
    );

    const first = store.claimNextJob({ deviceId: device.id });
    store.reportJobResult({ jobId: first.id, deviceId: device.id, ok: true });

    const second = store.claimNextJob({ deviceId: device.id });
    assert.equal(second, null);
  });

  it('register y heartbeat persisten batteryLevel; -1 no pisa', () => {
    const a = store.registerDevice({ label: 'A', batteryLevel: 85 });
    assert.equal(a.batteryLevel, 85);
    assert.ok(a.batteryUpdatedAt);

    const hb = store.heartbeat(a.id, { batteryLevel: 42 });
    assert.equal(hb.batteryLevel, 42);

    const ignored = store.heartbeat(a.id, { batteryLevel: -1 });
    assert.equal(ignored.batteryLevel, 42);

    const listed = store.listDevices().find((d) => d.id === a.id);
    assert.equal(listed.batteryLevel, 42);
  });

  it('deleteDevice elimina el dispositivo y cancela jobs pendientes', () => {
    const device = store.registerDevice({ label: 'Borrar' });
    store.enqueueJobs([{ telefono: '5215551112233', mensaje: 'Hola' }], [device.id]);
    const result = store.deleteDevice(device.id);
    assert.ok(result);
    assert.equal(result.device.id, device.id);
    assert.equal(result.cancelledJobs, 1);
    assert.equal(store.listDevices().length, 0);
    assert.equal(store.listJobs({ status: 'failed' }).length, 1);
    assert.equal(store.deleteDevice(device.id), null);
  });

  it('pickOnlineDevices filtra por lastSeen reciente', () => {
    const device = store.registerDevice({ label: 'A', logicalSessionId: 'session1' });
    const online = store.pickOnlineDevices({ logicalSessionIds: ['session1'], maxAgeMs: 60_000 });
    assert.equal(online.length, 1);
    assert.equal(online[0].id, device.id);

    const raw = store._readStore();
    raw.devices[0].lastSeenAt = new Date(Date.now() - 10 * 60 * 1000).toISOString();
    store._writeStore(raw);
    const stale = store.pickOnlineDevices({ maxAgeMs: 60_000 });
    assert.equal(stale.length, 0);
  });

  it('failOpenJobsByBatchId falla pending y claimed del lote', () => {
    const device = store.registerDevice({ label: 'A' });
    const jobs = store.enqueueJobs(
      [
        { telefono: '5215551112233', mensaje: 'Uno', batchId: 'batch-a' },
        { telefono: '5215551112244', mensaje: 'Dos', batchId: 'batch-a' },
        { telefono: '5215551112255', mensaje: 'Tres', batchId: 'batch-b' }
      ],
      [device.id]
    );
    store.claimNextJob({ deviceId: device.id });
    const n = store.failOpenJobsByBatchId('batch-a', 'batch_finished');
    assert.equal(n, 2);
    const byId = Object.fromEntries(store.getJobsByIds(jobs.map((j) => j.id)).map((j) => [j.id, j]));
    assert.equal(byId[jobs[0].id].status, 'failed');
    assert.equal(byId[jobs[0].id].error, 'batch_finished');
    assert.equal(byId[jobs[1].id].status, 'failed');
    assert.equal(byId[jobs[2].id].status, 'pending');
  });
});
