const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const {
  classifySendError,
  createFailoverContext,
  pickNextAliveSession,
  markSessionDead,
  requeueContact,
  drainSessionQueue
} = require('../sendFailover');

describe('classifySendError', () => {
  it('detecta invalid', () => {
    assert.equal(classifySendError('Number is not on WhatsApp'), 'invalid');
    assert.equal(classifySendError('número inválido'), 'invalid');
  });

  it('detecta session_dead', () => {
    assert.equal(classifySendError('Session disconnected'), 'session_dead');
    assert.equal(classifySendError({ status: 409, message: 'conflict' }), 'session_dead');
    assert.equal(classifySendError('account banned'), 'session_dead');
  });

  it('banned y restricted son session_dead', () => {
    assert.equal(classifySendError('This account is restricted'), 'session_dead');
  });

  it('default transient', () => {
    assert.equal(classifySendError('timeout'), 'transient');
    assert.equal(classifySendError('Too Many Requests'), 'transient');
  });
});

describe('requeue round-robin', () => {
  it('reencola a la siguiente viva y marca tried', () => {
    const queues = new Map([
      ['a', [{ contact: { telefono: '1' }, globalIndex: 0 }]],
      ['b', []],
      ['c', []]
    ]);
    const ctx = createFailoverContext(['a', 'b', 'c'], queues);
    const item = queues.get('a').shift();
    const r = requeueContact(ctx, item, 'a');
    assert.equal(r.ok, true);
    assert.equal(r.toSessionId, 'b');
    assert.ok(queues.get('b').some((x) => x.globalIndex === 0));
    assert.ok(item.triedSessionIds.includes('a'));
  });

  it('drena cola de línea muerta en RR', () => {
    const queues = new Map([
      [
        'a',
        [
          { contact: { telefono: '1' }, globalIndex: 0 },
          { contact: { telefono: '2' }, globalIndex: 1 }
        ]
      ],
      ['b', []],
      ['c', []]
    ]);
    const ctx = createFailoverContext(['a', 'b', 'c'], queues);
    const moved = drainSessionQueue(ctx, 'a');
    assert.equal(ctx.deadSessionIds.has('a'), true);
    assert.equal(queues.get('a').length, 0);
    assert.equal(moved.length, 2);
    assert.equal(moved[0].toSessionId, 'b');
    assert.equal(moved[1].toSessionId, 'c');
  });

  it('exhausted cuando ya probó todas las vivas', () => {
    const queues = new Map([
      ['a', []],
      ['b', []]
    ]);
    const ctx = createFailoverContext(['a', 'b'], queues);
    const item = {
      contact: { telefono: '1' },
      globalIndex: 0,
      triedSessionIds: ['a', 'b']
    };
    const r = requeueContact(ctx, item, 'a');
    assert.equal(r.ok, false);
    assert.equal(r.reason, 'exhausted_sessions');
  });

  it('no_healthy_sessions si todas muertas', () => {
    const queues = new Map([
      ['a', []],
      ['b', []]
    ]);
    const ctx = createFailoverContext(['a', 'b'], queues);
    markSessionDead(ctx, 'a');
    markSessionDead(ctx, 'b');
    const r = requeueContact(
      ctx,
      { contact: {}, globalIndex: 0, triedSessionIds: [] },
      'a'
    );
    assert.equal(r.ok, false);
    assert.equal(r.reason, 'no_healthy_sessions');
  });

  it('pickNextAliveSession salta dead y tried', () => {
    const queues = new Map([
      ['a', []],
      ['b', []],
      ['c', []]
    ]);
    const ctx = createFailoverContext(['a', 'b', 'c'], queues);
    markSessionDead(ctx, 'b');
    const id = pickNextAliveSession(ctx, ['a']);
    assert.equal(id, 'c');
  });
});
