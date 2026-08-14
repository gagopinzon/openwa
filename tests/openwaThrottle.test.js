const { describe, it, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const { createOpenWAThrottle } = require('../openwaThrottle');

function createClock() {
  let now = 0;
  const waits = [];
  return {
    now: () => now,
    async sleep(ms) {
      waits.push(ms);
      now += ms;
    },
    advance(ms) {
      now += ms;
    },
    waits
  };
}

describe('createOpenWAThrottle', () => {
  let clock;
  let throttle;

  beforeEach(() => {
    clock = createClock();
    throttle = createOpenWAThrottle({
      minGapMs: 400,
      now: clock.now,
      sleep: clock.sleep
    });
  });

  it('ejecuta peticiones en serie', async () => {
    const order = [];
    const first = throttle.enqueue(async () => {
      order.push('a-start');
      clock.advance(50);
      order.push('a-end');
      return 'A';
    });
    const second = throttle.enqueue(async () => {
      order.push('b-start');
      return 'B';
    });

    const [a, b] = await Promise.all([first, second]);
    assert.equal(a, 'A');
    assert.equal(b, 'B');
    assert.deepEqual(order, ['a-start', 'a-end', 'b-start']);
  });

  it('espera el hueco mínimo entre peticiones', async () => {
    await throttle.enqueue(async () => 'first');
    await throttle.enqueue(async () => 'second');
    assert.ok(
      clock.waits.some((ms) => ms >= 400),
      `se esperaba un wait >= 400, waits=${clock.waits.join(',')}`
    );
  });

  it('tras un 429 las siguientes esperan el cooldown global', async () => {
    await throttle.enqueue(async () => {
      throttle.noteRateLimited({ retryAfterMs: 8000 });
      return 'hit';
    });
    await throttle.enqueue(async () => 'after');
    const cooldownWait = Math.max(0, ...clock.waits);
    assert.ok(
      cooldownWait >= 8000,
      `cooldown wait=${cooldownWait}, waits=${clock.waits.join(',')}`
    );
  });

  it('un error no rompe la cola', async () => {
    await assert.rejects(
      () =>
        throttle.enqueue(async () => {
          throw new Error('boom');
        }),
      /boom/
    );
    const value = await throttle.enqueue(async () => 'ok');
    assert.equal(value, 'ok');
  });

  it('coalesce GET reutiliza la promesa en vuelo', async () => {
    let runs = 0;
    const a = throttle.coalesceGet('/chats', async () => {
      runs += 1;
      clock.advance(10);
      return ['chat-1'];
    });
    const b = throttle.coalesceGet('/chats', async () => {
      runs += 1;
      return ['chat-2'];
    });
    const [left, right] = await Promise.all([a, b]);
    assert.equal(runs, 1);
    assert.deepEqual(left, ['chat-1']);
    assert.deepEqual(right, ['chat-1']);
  });

  it('prioridad alta se cuela delante de las GET pendientes', async () => {
    const order = [];
    let releaseLow;
    const blocked = new Promise((resolve) => {
      releaseLow = resolve;
    });
    let startedLow;
    const lowStarted = new Promise((resolve) => {
      startedLow = resolve;
    });

    const low1 = throttle.enqueue(async () => {
      order.push('low-start');
      startedLow();
      await blocked;
      order.push('low-end');
      return 'L';
    });

    await lowStarted;

    const low2 = throttle.enqueue(async () => {
      order.push('low2');
      return 'L2';
    });
    const high = throttle.enqueue(
      async () => {
        order.push('high');
        return 'H';
      },
      { priority: 'high' }
    );

    releaseLow();
    await Promise.all([low1, low2, high]);
    assert.deepEqual(order, ['low-start', 'low-end', 'high', 'low2']);
  });
});
