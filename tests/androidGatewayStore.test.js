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
});
