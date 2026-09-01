const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const {
  toWebhookPayload,
  pickLatestUnprocessedInbound,
  collectWebhookPayloads,
  isInboxPollEnabled
} = require('../openwaInboxPoller');
const { extractIncomingMessage } = require('../autoReplyService');

describe('openwaInboxPoller', () => {
  it('toWebhookPayload arma un message.received que el handler de webhooks entiende', () => {
    const payload = toWebhookPayload({
      openwaSessionId: 'sess-abc',
      chat: { id: '5215512345678@c.us', name: 'Ana' },
      message: {
        id: { _serialized: 'false_5215512345678@c.us_MSG99', id: 'MSG99' },
        from: '5215512345678@c.us',
        body: 'Hola, me interesa',
        fromMe: false,
        isGroup: false,
        timestamp: 1723402232,
        contactName: 'Ana'
      }
    });

    assert.equal(payload.event, 'message.received');
    assert.equal(payload.sessionId, 'sess-abc');
    const extracted = extractIncomingMessage(payload);
    assert.ok(extracted);
    assert.equal(extracted.body, 'Hola, me interesa');
    assert.equal(extracted.telefono, '5215512345678');
    assert.equal(extracted.messageId, 'false_5215512345678@c.us_MSG99');
    assert.equal(extracted.fromMe, false);
  });

  it('pickLatestUnprocessedInbound ignora fromMe, grupos y ya vistos; toma el inbound más reciente', () => {
    const history = [
      { id: 'old', body: 'antes', fromMe: false, isGroup: false },
      { id: 'mine', body: 'respuesta ia', fromMe: true, isGroup: false },
      { id: 'new', body: 'ok para mañana', fromMe: false, isGroup: false }
    ];
    const seen = new Set(['sess:new']);
    const picked = pickLatestUnprocessedInbound(history, {
      openwaSessionId: 'sess',
      isSeen: (sessionId, messageId) => seen.has(`${sessionId}:${messageId}`)
    });
    assert.equal(picked.id, 'old');
    assert.equal(picked.body, 'antes');
  });

  it('collectWebhookPayloads solo mira chats con unread y no grupos (como Capataz)', async () => {
    const chats = [
      { id: '120363@g.us', unreadCount: 3, isGroup: true, name: 'Grupo' },
      { id: '521111@c.us', unreadCount: 0, isGroup: false, name: 'Silencio' },
      { id: '521222@c.us', unreadCount: 2, isGroup: false, name: 'Lead' }
    ];
    const historyByChat = {
      '521222@c.us': [
        { id: 'm1', body: '¿tienen vacantes?', fromMe: false, isGroup: false, timestamp: 100 }
      ]
    };
    const payloads = await collectWebhookPayloads({
      sessions: [{ id: 'session1', openwaSessionId: 'owa-1' }],
      listChats: async () => chats,
      getChatHistory: async (_sid, chatId) => historyByChat[chatId] || []
    });
    assert.equal(payloads.length, 1);
    assert.equal(payloads[0].sessionId, 'owa-1');
    assert.equal(payloads[0].data.body, '¿tienen vacantes?');
    assert.equal(payloads[0].data.from, '521222@c.us');
  });

  it('isInboxPollEnabled se activa en localhost si no hay env, y respeta OPENWA_INBOX_POLL', () => {
    const prevPoll = process.env.OPENWA_INBOX_POLL;
    const prevUrl = process.env.WEBHOOK_PUBLIC_URL;
    try {
      delete process.env.OPENWA_INBOX_POLL;
      process.env.WEBHOOK_PUBLIC_URL = 'http://127.0.0.1:3445';
      assert.equal(isInboxPollEnabled(), true);

      process.env.WEBHOOK_PUBLIC_URL = 'https://msg.protalentconnections.com';
      assert.equal(isInboxPollEnabled(), false);

      process.env.OPENWA_INBOX_POLL = 'true';
      assert.equal(isInboxPollEnabled(), true);

      process.env.OPENWA_INBOX_POLL = 'false';
      process.env.WEBHOOK_PUBLIC_URL = 'http://127.0.0.1:3445';
      assert.equal(isInboxPollEnabled(), false);
    } finally {
      if (prevPoll === undefined) delete process.env.OPENWA_INBOX_POLL;
      else process.env.OPENWA_INBOX_POLL = prevPoll;
      if (prevUrl === undefined) delete process.env.WEBHOOK_PUBLIC_URL;
      else process.env.WEBHOOK_PUBLIC_URL = prevUrl;
    }
  });
});
