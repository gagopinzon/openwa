const assert = require('assert');
const { collectPendingInboundTail } = require('../autoReplyService');

function run() {
  assert.deepEqual(collectPendingInboundTail(null), []);
  assert.deepEqual(collectPendingInboundTail([]), []);

  const history = [
    { id: '1', body: 'hola', fromMe: false },
    { id: '2', body: 'qué tal', fromMe: true },
    { id: '3', body: 'me interesa', fromMe: false },
    { id: '4', body: 'para mañana', fromMe: false },
    { id: '5', body: 'a las 10', fromMe: false }
  ];
  const pending = collectPendingInboundTail(history);
  assert.equal(pending.length, 3);
  assert.deepEqual(
    pending.map((m) => m.body),
    ['me interesa', 'para mañana', 'a las 10']
  );

  const afterOurReply = [
    ...history,
    { id: '6', body: 'claro', fromMe: true }
  ];
  assert.deepEqual(collectPendingInboundTail(afterOurReply), []);

  const withUnknown = [
    { id: 'a', body: 'ok', fromMe: true },
    { id: 'b', body: '[unknown]', fromMe: false },
    { id: 'c', body: 'sí quiero', fromMe: false }
  ];
  assert.deepEqual(
    collectPendingInboundTail(withUnknown).map((m) => m.body),
    ['sí quiero']
  );

  console.log('collectPendingInboundTail.test.js OK');
}

run();
