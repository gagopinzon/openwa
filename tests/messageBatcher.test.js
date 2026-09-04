const assert = require('assert');
const {
  enqueue,
  requeue,
  cancelKey,
  combineBatchBodies,
  getFirstDelayMs,
  getNextDelayMs,
  pendingCount,
  resetForTests
} = require('../messageBatcher');

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

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function run() {
  resetForTests();

  assert.equal(combineBatchBodies([{ body: 'hola' }, { body: ' mundo ' }, { body: '' }]), 'hola\nmundo');

  await withEnv(
    {
      AUTO_REPLY_SKIP_DELAYS: 'false',
      AUTO_REPLY_BATCH_FIRST_MS: '40',
      AUTO_REPLY_BATCH_NEXT_MS: '30'
    },
    async () => {
      assert.equal(getFirstDelayMs(), 40);
      assert.equal(getNextDelayMs(), 30);

      const flushed = [];
      const onFlush = async (items) => {
        flushed.push(items.map((i) => i.body));
        return { handled: true, bodies: items.map((i) => i.body) };
      };

      const r1 = await enqueue({
        key: 's1:chat1',
        item: { body: 'uno' },
        onFlush
      });
      assert.equal(r1.flushed, false);
      assert.equal(r1.count, 1);
      assert.equal(r1.delayMs, 40);
      assert.equal(pendingCount('s1:chat1'), 1);

      const r2 = await enqueue({
        key: 's1:chat1',
        item: { body: 'dos' },
        onFlush
      });
      assert.equal(r2.flushed, false);
      assert.equal(r2.count, 2);
      assert.equal(r2.delayMs, 30);

      await sleep(80);
      assert.deepEqual(flushed, [['uno', 'dos']]);
      assert.equal(pendingCount('s1:chat1'), 0);
    }
  );

  resetForTests();

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

      await enqueue({
        key: 's1:chat2',
        item: { body: 'texto' },
        onFlush
      });
      const imm = await enqueue({
        key: 's1:chat2',
        item: { body: 'pdf', incomingDocument: true },
        onFlush,
        immediate: true
      });
      assert.equal(imm.flushed, true);
      assert.deepEqual(flushed, [['texto', 'pdf']]);
    }
  );

  resetForTests();

  await withEnv({ AUTO_REPLY_SKIP_DELAYS: 'true' }, async () => {
    assert.equal(getFirstDelayMs(), 0);
    const flushed = [];
    const onFlush = async (items) => {
      flushed.push(items.length);
      return { handled: true };
    };
    const r = await enqueue({
      key: 's1:chat3',
      item: { body: 'ya' },
      onFlush
    });
    assert.equal(r.flushed, true);
    assert.deepEqual(flushed, [1]);
  });

  resetForTests();

  await withEnv(
    {
      AUTO_REPLY_SKIP_DELAYS: 'false',
      AUTO_REPLY_BATCH_BUSY_RETRY_MS: '20'
    },
    async () => {
      const order = [];
      const onFlush = async (items) => {
        order.push(items.map((i) => i.body).join('+'));
        return { handled: true };
      };

      requeue('s1:chat4', [{ body: 'old' }], onFlush, 20, { front: true });
      await enqueue({
        key: 's1:chat4',
        item: { body: 'new' },
        onFlush,
        skipDelay: true
      });
      // skipDelay flushes immediately; if only "new" was there when flush ran after enqueue...
      // Actually: requeue adds old, then enqueue adds new and skipDelay flushes both.
      assert.ok(order.length >= 1);
      assert.ok(order[0].includes('old') && order[0].includes('new'));
    }
  );

  resetForTests();

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

      await enqueue({
        key: 's1:chat-cancel',
        item: { body: 'pendiente' },
        onFlush
      });
      assert.equal(pendingCount('s1:chat-cancel'), 1);
      const discarded = cancelKey('s1:chat-cancel');
      assert.equal(discarded, 1);
      assert.equal(pendingCount('s1:chat-cancel'), 0);
      await sleep(60);
      assert.deepEqual(flushed, []);
    }
  );

  resetForTests();
  console.log('messageBatcher.test.js OK');
}

run().catch((err) => {
  console.error(err);
  process.exit(1);
});
