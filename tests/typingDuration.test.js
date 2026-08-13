const assert = require('assert');
const path = require('path');
const fs = require('fs');
const { typingDurationMsForText } = require('../autoReplyService');
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
    } else if (fs.existsSync(CONFIG)) {
      // leave file; delays restored via rewrite of backup only
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
    withClearedConfigDelays(() => {
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
    });

    // Prioridad de config UI sobre .env
    withClearedConfigDelays(() => {
      autoReplyStore.updateConfig({ minDelayMs: 5000, maxDelayMs: 12000 });
      const capped = typingDurationMsForText('x'.repeat(5000));
      assert.strictEqual(capped, 12000, 'config UI debe capar el máximo');
      const short = typingDurationMsForText('ok');
      assert.ok(short >= 5000, `config UI debe imponer mínimo, got ${short}`);
    });
  }
);

console.log('typingDuration.test.js OK');
