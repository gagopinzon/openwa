const assert = require('assert');
const messageBatcher = require('../messageBatcher');
const autoReplyService = require('../autoReplyService');

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function withEnv(overrides, fn) {
  const prev = {};
  for (const [key, value] of Object.entries(overrides)) {
    prev[key] = process.env[key];
    if (value == null) delete process.env[key];
    else process.env[key] = String(value);
  }
  try {
    return await fn();
  } finally {
    for (const [key, value] of Object.entries(prev)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
}

async function run() {
  messageBatcher.resetForTests();

  await withEnv(
    {
      AUTO_REPLY_SKIP_DELAYS: 'false',
      AUTO_REPLY_BATCH_FIRST_MS: '5000',
      AUTO_REPLY_BATCH_NEXT_MS: '5000'
    },
    async () => {
      const flushed = [];
      const onFlush = async (items) => {
        flushed.push(items.map((i) => i.body));
        return { handled: true };
      };

      await messageBatcher.enqueue({
        key: 'ow1:188119869571223@lid',
        item: { body: 'hola', normalizedPhone: '5215512345678' },
        onFlush
      });
      assert.equal(messageBatcher.pendingCount('ow1:188119869571223@lid'), 1);

      // Pausar desde el panel con @c.us no debe dejar el lote @lid vivo.
      const cancelInfo = autoReplyService.cancelPendingForChat(
        'ow1',
        '5215512345678@c.us',
        {
          normalizedPhone: '5215512345678',
          whatsappLid: '188119869571223'
        }
      );
      assert.ok(cancelInfo.cancelledBatchItems >= 1);
      assert.equal(messageBatcher.pendingCount('ow1:188119869571223@lid'), 0);
      await sleep(60);
      assert.deepEqual(flushed, []);
    }
  );

  console.log('aiPauseCancel.test.js OK');
}

run().catch((err) => {
  console.error(err);
  process.exit(1);
});
