const { describe, it, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const STORE_FILE = path.join(__dirname, '..', 'data', 'agenda-pending.json');
const store = require('../agendaPendingStore');

describe('agendaPendingStore confirmed + reschedule', () => {
  let backup;

  beforeEach(() => {
    backup = fs.existsSync(STORE_FILE) ? fs.readFileSync(STORE_FILE, 'utf8') : null;
    fs.mkdirSync(path.dirname(STORE_FILE), { recursive: true });
    fs.writeFileSync(STORE_FILE, JSON.stringify({ version: 1, items: [] }, null, 2));
  });

  afterEach(() => {
    if (backup !== null) fs.writeFileSync(STORE_FILE, backup);
    else if (fs.existsSync(STORE_FILE)) fs.unlinkSync(STORE_FILE);
  });

  it('findConfirmedByPhone finds latest confirmed', () => {
    const pending = store.createPending({
      telefono: '5215550001111',
      fecha: '2026-09-08',
      horaInicio: '10:00',
      horaFin: '10:30',
      cvId: 'cv1',
      candidateVendors: [{ vendedorId: 'v1', gerenteEmail: 'g@x.com' }]
    });
    store.confirmPending(pending.id, {
      vendedorId: 'v1',
      urlReunion: 'https://meet.example/1',
      gerenteEmail: 'g@x.com',
      panelReunionId: 'panel-abc'
    });
    const found = store.findConfirmedByPhone('5215550001111');
    assert.ok(found);
    assert.equal(found.panelReunionId, 'panel-abc');
    assert.equal(found.status, store.STATUS.CONFIRMED);
    assert.equal(store.findPendingByPhone('5215550001111'), null);
  });

  it('rescheduleConfirmed updates schedule and keeps panel id', () => {
    const pending = store.createPending({
      telefono: '5215550002222',
      fecha: '2026-09-08',
      horaInicio: '10:00',
      horaFin: '10:30',
      cvId: 'cv2'
    });
    store.confirmPending(pending.id, {
      vendedorId: 'v1',
      urlReunion: 'https://meet.example/2',
      gerenteEmail: 'g@x.com',
      panelReunionId: 'panel-xyz'
    });
    const updated = store.rescheduleConfirmed(pending.id, {
      fecha: '2026-09-09',
      horaInicio: '15:00',
      horaFin: '15:30',
      label: 'mar 9 sep, 15:00',
      vendedorId: 'v2',
      gerenteEmail: 'g2@x.com'
    });
    assert.equal(updated.fecha, '2026-09-09');
    assert.equal(updated.horaInicio, '15:00');
    assert.equal(updated.vendedorId, 'v2');
    assert.equal(updated.panelReunionId, 'panel-xyz');
    assert.equal(updated.urlReunion, 'https://meet.example/2');
    assert.ok(updated.rescheduledAt);
  });
});
