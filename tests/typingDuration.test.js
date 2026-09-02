const assert = require('assert');
const path = require('path');
const fs = require('fs');
const { typingDurationMsForText, skipAutoReplyDelays } = require('../autoReplyService');
const autoReplyStore = require('../autoReplyStore');

const CONFIG = path.join(__dirname, '..', 'data', 'auto-reply-config.json');

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

function withClearedConfigDelays(fn) {
  let backup = null;
  if (fs.existsSync(CONFIG)) {
    backup = fs.readFileSync(CONFIG, 'utf8');
  }
  try {
    autoReplyStore.updateConfig({ minDelayMs: null, maxDelayMs: null });
    return fn();
  } finally {
    if (backup != null) {
      fs.writeFileSync(CONFIG, backup, 'utf8');
    }
  }
}

withEnv(
  {
    AUTO_REPLY_SKIP_DELAYS: 'false',
    AUTO_REPLY_MIN_DELAY_MS: '400',
    AUTO_REPLY_MAX_DELAY_MS: '3000',
    AUTO_REPLY_TYPING_BASE_MS: '400',
    AUTO_REPLY_TYPING_MS_PER_CHAR: '15'
  },
  () => {
    withClearedConfigDelays(() => {
      assert.strictEqual(skipAutoReplyDelays(), false);

      const short = typingDurationMsForText('ok');
      assert.ok(short >= 400, `corto debe respetar mínimo, got ${short}`);
      assert.ok(short <= 3000, `corto no debe pasar máximo, got ${short}`);

      const paragraph = 'a'.repeat(150);
      const samples = [];
      for (let i = 0; i < 20; i++) samples.push(typingDurationMsForText(paragraph));
      const avg = samples.reduce((a, b) => a + b, 0) / samples.length;
      // 400 + 150*15 = 2650 (±15% jitter), capped at 3000
      assert.ok(avg >= 2000 && avg <= 3000, `párrafo ~2.6s promedio, got avg=${avg}`);
      for (const ms of samples) {
        assert.ok(ms >= 400 && ms <= 3000, `sample fuera de rango: ${ms}`);
      }

      const huge = typingDurationMsForText('x'.repeat(5000));
      assert.strictEqual(huge, 3000, 'textos largos deben caparse a 3s');
    });

    withClearedConfigDelays(() => {
      autoReplyStore.updateConfig({ minDelayMs: 500, maxDelayMs: 1200 });
      const capped = typingDurationMsForText('x'.repeat(5000));
      assert.strictEqual(capped, 1200, 'config UI debe capar el máximo');
      const short = typingDurationMsForText('ok');
      assert.ok(short >= 500, `config UI debe imponer mínimo, got ${short}`);
    });
  }
);

withEnv({ AUTO_REPLY_SKIP_DELAYS: 'true' }, () => {
  withClearedConfigDelays(() => {
    assert.strictEqual(skipAutoReplyDelays(), true);
    assert.strictEqual(typingDurationMsForText('ok'), 0);
    assert.strictEqual(typingDurationMsForText('x'.repeat(5000)), 0);
  });
});

console.log('typingDuration.test.js OK');
