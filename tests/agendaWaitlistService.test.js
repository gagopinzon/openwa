const { describe, it, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const STORE_FILE = path.join(__dirname, '..', 'data', 'agenda-waitlist.service.test.json');
const store = require('../agendaWaitlistStore');
store.setStoreFileForTests(STORE_FILE);

const {
  decideWaitlistAction,
  shouldEnqueueWaitlist,
  enqueuePinnedDayIfEmpty,
  tickWaitlist
} = require('../agendaWaitlistService');

describe('agendaWaitlist', () => {
  beforeEach(() => {
    fs.mkdirSync(path.dirname(STORE_FILE), { recursive: true });
    fs.writeFileSync(STORE_FILE, JSON.stringify({ version: 1, items: [] }, null, 2));
  });

  afterEach(() => {
    if (fs.existsSync(STORE_FILE)) fs.unlinkSync(STORE_FILE);
  });

  it('upsertWaiting crea un activo y al repetir teléfono actualiza la fecha', () => {
    const a = store.upsertWaiting({
      telefono: '5215550001111',
      fecha: '2026-09-17',
      chatId: '5215550001111@c.us',
      contactName: 'Jhonatan'
    });
    assert.equal(a.status, store.STATUS.WAITING);
    assert.equal(a.fecha, '2026-09-17');
    assert.equal(store.listWaiting().length, 1);

    const b = store.upsertWaiting({
      telefono: '5215550001111',
      fecha: '2026-09-24',
      chatId: '5215550001111@c.us'
    });
    assert.equal(b.id, a.id);
    assert.equal(b.fecha, '2026-09-24');
    assert.equal(store.listWaiting().length, 1);
  });

  it('markNotifiedSlots y markNotifiedEmpty no duplican el item', () => {
    const a = store.upsertWaiting({
      telefono: '5215550002222',
      fecha: '2026-09-17'
    });
    const slots = store.markNotifiedSlots(a.id);
    assert.equal(slots.status, store.STATUS.NOTIFIED_SLOTS);
    assert.ok(slots.notifiedSlotsAt);

    store.upsertWaiting({
      telefono: '5215550003333',
      fecha: '2026-09-17'
    });
    const empty = store.markNotifiedEmpty(store.listWaiting()[0].id);
    assert.equal(empty.status, store.STATUS.WAITING);
    assert.ok(empty.notifiedEmptyAt);
  });

  it('cancelByPhone y expirePast', () => {
    store.upsertWaiting({ telefono: '5215550004444', fecha: '2026-09-10' });
    store.upsertWaiting({ telefono: '5215550005555', fecha: '2026-09-17' });
    assert.equal(store.expirePast('2026-09-11'), 1);
    assert.equal(store.findWaitingByPhone('5215550004444'), null);
    assert.ok(store.findWaitingByPhone('5215550005555'));

    store.cancelByPhone('5215550005555', 'booked');
    assert.equal(store.findWaitingByPhone('5215550005555'), null);
  });

  it('shouldEnqueueWaitlist solo con día pineado futuro vacío', () => {
    const range = { fechaInicio: '2026-09-17', fechaFin: '2026-09-17' };
    assert.equal(shouldEnqueueWaitlist(range, '2026-09-09', []), true);
    assert.equal(
      shouldEnqueueWaitlist(range, '2026-09-09', [{ fecha: '2026-09-17' }]),
      false
    );
    assert.equal(
      shouldEnqueueWaitlist(
        { fechaInicio: '2026-09-09', fechaFin: '2026-09-11' },
        '2026-09-09',
        []
      ),
      false
    );
    assert.equal(
      shouldEnqueueWaitlist(
        { fechaInicio: '2026-09-08', fechaFin: '2026-09-08' },
        '2026-09-09',
        []
      ),
      false
    );
  });

  it('enqueuePinnedDayIfEmpty guarda y no lista horas de esta semana', () => {
    const out = enqueuePinnedDayIfEmpty({
      range: { fechaInicio: '2026-09-17', fechaFin: '2026-09-17' },
      today: '2026-09-09',
      slots: [],
      telefono: '5215550001111',
      contactName: 'Jhonatan',
      chatId: '521@c.us'
    });
    assert.ok(out);
    assert.equal(out.agendaMeta.reason, 'waitlist_saved');
    assert.match(out.replyText, /todavía no tenemos horarios/i);
    assert.doesNotMatch(out.replyText, /08:00/);
    assert.equal(store.findWaitingByPhone('5215550001111').fecha, '2026-09-17');
  });

  it('decideWaitlistAction: expire, booked, offer, nudge, skip', () => {
    const entry = {
      fecha: '2026-09-17',
      createdYmd: '2026-09-09',
      notifiedSlotsAt: null,
      notifiedEmptyAt: null
    };
    assert.equal(
      decideWaitlistAction(entry, { today: '2026-09-18', slots: [] }),
      'expire'
    );
    assert.equal(
      decideWaitlistAction(entry, {
        today: '2026-09-09',
        slots: [],
        pendingFecha: '2026-09-17'
      }),
      'booked'
    );
    assert.equal(
      decideWaitlistAction(entry, {
        today: '2026-09-09',
        slots: [{ fecha: '2026-09-17', horaInicio: '10:00' }]
      }),
      'offer_slots'
    );
    assert.equal(
      decideWaitlistAction(entry, { today: '2026-09-15', slots: [] }),
      'empty_nudge'
    );
    assert.equal(
      decideWaitlistAction(entry, { today: '2026-09-09', slots: [] }),
      'skip'
    );
    assert.equal(
      decideWaitlistAction(
        { ...entry, createdYmd: '2026-09-14', fecha: '2026-09-15' },
        { today: '2026-09-14', slots: [] }
      ),
      'skip'
    );
  });

  it('tickWaitlist ofrece huecos una vez y recuerda la oferta', async () => {
    store.upsertWaiting({
      telefono: '5215550007777',
      fecha: '2026-09-17',
      chatId: '5215550007777@c.us',
      openwaSessionId: 'owa-1',
      contactName: 'Jhonatan',
      createdYmd: '2026-09-09'
    });
    const sent = [];
    const remembered = [];
    const result = await tickWaitlist({
      today: '2026-09-12',
      getSlots: async () => ({
        slots: [{ fecha: '2026-09-17', horaInicio: '10:00', horaFin: '10:45' }]
      }),
      sendText: async (session, chatId, text) => {
        sent.push({ session, chatId, text });
      },
      rememberOffer: (phone, slots) => remembered.push({ phone, slots }),
      findPendingFecha: () => null,
      findConfirmedFecha: () => null,
      isAiPaused: async () => false,
      isSessionEnabled: () => true
    });
    assert.equal(result.sentSlots, 1);
    assert.equal(sent.length, 1);
    assert.match(sent[0].text, /10:00/);
    assert.equal(remembered[0].phone, '5215550007777');
    assert.equal(store.findWaitingByPhone('5215550007777'), null);

    const second = await tickWaitlist({
      today: '2026-09-12',
      getSlots: async () => ({
        slots: [{ fecha: '2026-09-17', horaInicio: '10:00', horaFin: '10:45' }]
      }),
      sendText: async () => {
        throw new Error('no debe reenviar');
      }
    });
    assert.equal(second.sentSlots, 0);
  });
});
