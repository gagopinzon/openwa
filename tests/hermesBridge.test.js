const { describe, it, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const STORE_FILE = path.join(__dirname, '..', 'data', 'incoming-messages.json');
const store = require('../incomingMessagesStore');
const hermesBridge = require('../hermesBridge');

describe('hermesBridge', () => {
  let backup;
  const prevToken = process.env.HERMES_BRIDGE_TOKEN;

  beforeEach(() => {
    backup = fs.existsSync(STORE_FILE) ? fs.readFileSync(STORE_FILE, 'utf8') : null;
    store.clear();
    process.env.HERMES_BRIDGE_TOKEN = 'test-hermes-token';
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

    if (prevToken === undefined) delete process.env.HERMES_BRIDGE_TOKEN;
    else process.env.HERMES_BRIDGE_TOKEN = prevToken;
  });

  it('parseSince acepta ISO y unix ms', () => {
    const iso = hermesBridge.parseSince('2026-08-01T12:00:00.000Z');
    assert.equal(iso.toISOString(), '2026-08-01T12:00:00.000Z');
    const ms = hermesBridge.parseSince(String(Date.parse('2026-08-01T12:00:00.000Z')));
    assert.equal(ms.toISOString(), '2026-08-01T12:00:00.000Z');
  });

  it('listInbox filtra fromMe, isGroup y since', () => {
    store.add({
      id: 'old',
      timestamp: '2026-08-01T10:00:00.000Z',
      openwaSessionId: 'sess-a',
      telefono: '5215511111111',
      chatId: '5215511111111@c.us',
      body: 'viejo',
      fromMe: false,
      isGroup: false
    });
    store.add({
      id: 'new',
      timestamp: '2026-08-01T12:00:00.000Z',
      openwaSessionId: 'sess-a',
      telefono: '5215522222222',
      chatId: '5215522222222@c.us',
      body: 'nuevo',
      fromMe: false,
      isGroup: false
    });
    store.add({
      id: 'group',
      timestamp: '2026-08-01T12:05:00.000Z',
      openwaSessionId: 'sess-a',
      telefono: '',
      chatId: '123@g.us',
      body: 'grupo',
      fromMe: false,
      isGroup: true
    });
    store.add({
      id: 'me',
      timestamp: '2026-08-01T12:06:00.000Z',
      openwaSessionId: 'sess-a',
      telefono: '5215533333333',
      chatId: '5215533333333@c.us',
      body: 'yo',
      fromMe: true,
      isGroup: false
    });

    const result = hermesBridge.listInbox({
      since: '2026-08-01T11:00:00.000Z',
      limit: 10
    });

    assert.equal(result.messages.length, 1);
    assert.equal(result.messages[0].id, 'new');
    assert.equal(result.messages[0].body, 'nuevo');
  });

  it('listInbox excluye autoReplyHandled por defecto', () => {
    store.add({
      id: 'handled',
      timestamp: '2026-08-01T12:00:00.000Z',
      openwaSessionId: 'sess-a',
      telefono: '5215511111111',
      chatId: '5215511111111@c.us',
      body: 'ya',
      fromMe: false,
      isGroup: false,
      autoReplyHandled: true
    });
    store.add({
      id: 'pending',
      timestamp: '2026-08-01T12:01:00.000Z',
      openwaSessionId: 'sess-a',
      telefono: '5215522222222',
      chatId: '5215522222222@c.us',
      body: 'pendiente',
      fromMe: false,
      isGroup: false,
      autoReplyHandled: false
    });

    const filtered = hermesBridge.listInbox({ limit: 10 });
    assert.equal(filtered.messages.length, 1);
    assert.equal(filtered.messages[0].id, 'pending');

    const all = hermesBridge.listInbox({ limit: 10, includeHandled: true });
    assert.equal(all.messages.length, 2);
  });

  it('ackMessages marca inbox y desaparece del poll por defecto', () => {
    store.add({
      id: 'to-ack',
      messageId: 'wa-msg-99',
      timestamp: '2026-08-01T12:00:00.000Z',
      openwaSessionId: 'sess-a',
      telefono: '5215511111111',
      chatId: '5215511111111@c.us',
      body: 'hola',
      fromMe: false,
      isGroup: false
    });

    const result = hermesBridge.ackMessages({
      ids: ['to-ack'],
      status: 'meeting_scheduled',
      replyMessage: 'Te envío el link'
    });

    assert.equal(result.total, 1);
    assert.equal(result.acknowledged[0].hermesStatus, 'meeting_scheduled');
    assert.equal(result.acknowledged[0].autoReplyReason, 'hermes');
    assert.equal(result.acknowledged[0].replyMessage, 'Te envío el link');

    const inbox = hermesBridge.listInbox({ limit: 10 });
    assert.equal(inbox.messages.length, 0);
  });

  it('ackMessages acepta messageIds y reporta notFound', () => {
    store.add({
      id: 'by-msg-id',
      messageId: 'wa-msg-42',
      timestamp: '2026-08-01T12:00:00.000Z',
      openwaSessionId: 'sess-a',
      telefono: '5215511111111',
      chatId: '5215511111111@c.us',
      body: 'ok',
      fromMe: false,
      isGroup: false
    });

    const ok = hermesBridge.ackMessages({
      messageIds: ['wa-msg-42'],
      status: 'lost_lead'
    });
    assert.equal(ok.total, 1);

    const missing = hermesBridge.ackMessages({ ids: ['no-existe'] });
    assert.equal(missing.total, 0);
    assert.deepEqual(missing.notFound, [{ id: 'no-existe' }]);
  });

  it('verifyRequest rechaza token inválido', () => {
    const res = {
      statusCode: 200,
      body: null,
      status(code) {
        this.statusCode = code;
        return this;
      },
      json(payload) {
        this.body = payload;
        return this;
      }
    };

    const ok = hermesBridge.verifyRequest(
      { headers: { 'x-hermes-token': 'test-hermes-token' } },
      res
    );
    assert.equal(ok, true);

    const resBad = {
      statusCode: 200,
      body: null,
      status(code) {
        this.statusCode = code;
        return this;
      },
      json(payload) {
        this.body = payload;
        return this;
      }
    };
    const bad = hermesBridge.verifyRequest(
      { headers: { 'x-hermes-token': 'wrong' } },
      resBad
    );
    assert.equal(bad, false);
    assert.equal(resBad.statusCode, 401);
  });
});
