const assert = require('assert');
const { typingDurationMsForText } = require('../autoReplyService');

function withEnv(overrides, fn) {
  const prev = {};
  for (const [key, value] of Object.entries(overrides)) {
    prev[key] = process.env[key];
    if (value == null) delete process.env[key];
    else process.env[key] = String(value);
  }
  try {
    return fn();
  } finally {
    for (const [key, value] of Object.entries(prev)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
}

withEnv(
  {
    AUTO_REPLY_MIN_DELAY_MS: '3000',
    AUTO_REPLY_MAX_DELAY_MS: '35000',
    AUTO_REPLY_TYPING_BASE_MS: '2500',
    AUTO_REPLY_TYPING_MS_PER_CHAR: '200'
  },
  () => {
    const short = typingDurationMsForText('ok');
    assert.ok(short >= 3000, `corto debe respetar mínimo, got ${short}`);
    assert.ok(short <= 35000, `corto no debe pasar máximo, got ${short}`);

    const paragraph = 'a'.repeat(150);
    const samples = [];
    for (let i = 0; i < 20; i++) samples.push(typingDurationMsForText(paragraph));
    const avg = samples.reduce((a, b) => a + b, 0) / samples.length;
    // 2500 + 150*200 = 32500 (±15% jitter), capped at 35000
    assert.ok(avg >= 25000 && avg <= 35000, `párrafo ~30s promedio, got avg=${avg}`);
    for (const ms of samples) {
      assert.ok(ms >= 3000 && ms <= 35000, `sample fuera de rango: ${ms}`);
    }

    const huge = typingDurationMsForText('x'.repeat(5000));
    assert.strictEqual(huge, 35000, 'textos largos deben caparse al máximo');
  }
);

console.log('typingDuration.test.js OK');
