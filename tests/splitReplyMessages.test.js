const assert = require('assert');
const { splitReplyIntoMessages } = require('../autoReplyService');
const { splitSpeechParts } = require('../aiService');

const one = splitReplyIntoMessages('Hola, ¿cómo estás?');
assert.deepStrictEqual(one, ['Hola, ¿cómo estás?']);

const three = splitReplyIntoMessages(
  'Primer párrafo aquí.\n\nSegundo párrafo con más texto.\n\nTercero con pregunta ¿te late?'
);
assert.strictEqual(three.length, 3);
assert.ok(three[0].includes('Primer'));
assert.ok(three[1].includes('Segundo'));
assert.ok(three[2].includes('Tercero'));

const many = splitReplyIntoMessages(
  ['a', 'b', 'c', 'd', 'e', 'f', 'g'].join('\n\n'),
  5
);
assert.strictEqual(many.length, 5);
assert.ok(many[4].includes('e') && many[4].includes('g'));

const withAtte = splitSpeechParts('Hola mundo.\n\nAtte:\nMónica');
assert.strictEqual(withAtte.length, 1);
assert.ok(withAtte[0].includes('Atte:'));

console.log('splitReplyMessages.test.js OK');
