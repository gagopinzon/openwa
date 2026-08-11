const { describe, it, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const STORE_FILE = path.join(__dirname, '..', 'data', 'incoming-messages.json');
const store = require('../incomingMessagesStore');
const {
  captureIncomingMessage,
  normalizeWhatsAppMessageId
} = require('../autoReplyService');

describe('incoming inbox dedupe', () => {
  let backup;

  beforeEach(() => {
    backup = fs.existsSync(STORE_FILE) ? fs.readFileSync(STORE_FILE, 'utf8') : null;
    store.clear();
  });

  afterEach(() => {
    if (backup !== null) {
      fs.mkdirSync(path.dirname(STORE_FILE), { recursive: true });
      fs.writeFileSync(STORE_FILE, backup);
    } else if (fs.existsSync(STORE_FILE)) {
      fs.unlinkSync(STORE_FILE);
    }
    if (typeof store.reloadFromDisk === 'function') store.reloadFromDisk();
    else store.clear();
  });

  it('normalizeWhatsAppMessageId usa _serialized o string', () => {
    assert.equal(
      normalizeWhatsAppMessageId({
        _serialized: 'false_5215512345678@c.us_ABCDEF',
        id: 'ABCDEF'
      }),
      'false_5215512345678@c.us_ABCDEF'
    );
    assert.equal(normalizeWhatsAppMessageId('plain-id-1'), 'plain-id-1');
    assert.equal(normalizeWhatsAppMessageId(null), null);
  });

  it('store.add no duplica el mismo messageId de la misma sesión OpenWA', () => {
    const a = store.add({
      id: 'delivery-1',
      openwaSessionId: 'pocobasic',
      messageId: 'false_xxx@lid_AAA',
      telefono: '188119869571223',
      body: '2:30 está bien',
      timestamp: '2026-08-11T20:12:14.000Z'
    });
    const b = store.add({
      id: 'delivery-2',
      openwaSessionId: 'pocobasic',
      messageId: 'false_xxx@lid_AAA',
      telefono: '188119869571223',
      body: '2:30 está bien',
      timestamp: '2026-08-11T20:12:14.000Z'
    });
    assert.equal(a.id, b.id);
    assert.equal(store.list({ limit: 50 }).length, 1);
  });

  it('captureIncomingMessage ignora reentregas con distinta clave de idempotencia', () => {
    const basePayload = {
      event: 'message.received',
      sessionId: 'pocobasic',
      data: {
        id: { _serialized: 'false_188@lid_MSG1', id: 'MSG1' },
        from: '188119869571223@lid',
        body: 'Mañana a las 10:30',
        fromMe: false,
        isGroup: false,
        timestamp: 1723402232
      }
    };

    const first = captureIncomingMessage({
      payload: basePayload,
      idempotencyKey: 'delivery-aaa'
    });
    const second = captureIncomingMessage({
      payload: basePayload,
      idempotencyKey: 'delivery-bbb'
    });

    assert.ok(first);
    assert.equal(first.id, second.id);
    assert.equal(store.list({ limit: 50 }).length, 1);
  });

  it('list compacta duplicados históricos con distinto id de entrega', () => {
    store.add({
      id: 'old-1',
      openwaSessionId: 'monica',
      messageId: 'false_278@lid_ZZZ',
      chatId: '278812197662831@lid',
      telefono: '278812197662831',
      body: 'Mañana a las 10:30',
      timestamp: '2026-08-11T20:10:32.000Z'
    });
    // Inyecta duplicado “sucio” saltándose add (simula bandeja vieja)
    const messages = store.list({ limit: 50 });
    assert.equal(messages.length, 1);
    store.reloadFromDisk();
    const raw = JSON.parse(fs.readFileSync(STORE_FILE, 'utf8'));
    raw.messages.unshift({
      id: 'old-2',
      openwaSessionId: 'monica',
      messageId: 'false_278@lid_ZZZ',
      chatId: '278812197662831@lid',
      telefono: '278812197662831',
      body: 'Mañana a las 10:30',
      timestamp: '2026-08-11T20:10:32.000Z'
    });
    fs.writeFileSync(STORE_FILE, JSON.stringify(raw, null, 2));
    store.reloadFromDisk();
    assert.equal(store.list({ limit: 50 }).length, 1);
  });
});
