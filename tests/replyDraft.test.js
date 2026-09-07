const { describe, it, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const replyDraftStore = require('../replyDraftStore');
const replyDraftService = require('../replyDraftService');

describe('replyDraftStore', () => {
  beforeEach(() => {
    replyDraftStore.resetForTests();
  });

  it('upsert y toPublic', () => {
    const d = replyDraftStore.upsert({
      openwaSessionId: 'ow1',
      logicalSessionId: 's1',
      chatId: '521@c.us',
      replyText: 'Hola',
      status: 'scheduled',
      sendAt: Date.now() + 5000,
      items: []
    });
    assert.equal(d.replyText, 'Hola');
    const pub = replyDraftStore.toPublic(d);
    assert.equal(pub.sessionId, 's1');
    assert.equal(pub.chatId, '521@c.us');
    assert.ok(!('items' in pub));
  });
});

describe('replyDraftService', () => {
  beforeEach(() => {
    replyDraftService.resetForTests();
  });

  it('genera borrador y pausa el envío sin mandar', async () => {
    const sent = [];
    replyDraftService.setHandlers({
      processBatched: async (items, opts = {}) => {
        if (opts.draftOnly) {
          return { handled: false, reason: 'draft_ready', replyMessage: 'Borrador IA' };
        }
        sent.push(opts.preparedReply || 'full');
        return { handled: true };
      }
    });

    const prevFirst = process.env.AUTO_REPLY_BATCH_FIRST_MS;
    const prevSkip = process.env.AUTO_REPLY_SKIP_DELAYS;
    process.env.AUTO_REPLY_BATCH_FIRST_MS = '5000';
    process.env.AUTO_REPLY_SKIP_DELAYS = 'false';

    try {
      const result = await replyDraftService.enqueueInbound({
        openwaSessionId: 'ow1',
        logicalSessionId: 's1',
        chatId: '521@c.us',
        normalizedPhone: '521',
        body: 'hola',
        broadcastEvent: () => {}
      });
      assert.equal(result.reason, 'draft_pending');

      await new Promise((r) => setTimeout(r, 80));
      const draft = replyDraftService.getPublic('ow1', '521@c.us');
      assert.ok(draft);
      assert.equal(draft.replyText, 'Borrador IA');

      const paused = replyDraftService.pauseSend('ow1', '521@c.us');
      assert.equal(paused.status, 'paused');
      assert.equal(sent.length, 0);
    } finally {
      if (prevFirst === undefined) delete process.env.AUTO_REPLY_BATCH_FIRST_MS;
      else process.env.AUTO_REPLY_BATCH_FIRST_MS = prevFirst;
      if (prevSkip === undefined) delete process.env.AUTO_REPLY_SKIP_DELAYS;
      else process.env.AUTO_REPLY_SKIP_DELAYS = prevSkip;
      replyDraftService.resetForTests();
      require('../autoReplyService').bindReplyDraftHandlers();
    }
  });
});
