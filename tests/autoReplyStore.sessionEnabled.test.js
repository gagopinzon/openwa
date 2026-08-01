const { describe, it, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

// Aislar DATA_DIR: el store usa path.join(__dirname, 'data').
// Para no tocar data/ real, probar vía require + manipular archivo temporal
// copiando la lógica, O usar el archivo real con backup.
// Enfoque práctico: backup de data/auto-reply-config.json, mutar, restaurar.

const CONFIG = path.join(__dirname, '..', 'data', 'auto-reply-config.json');
const store = require('../autoReplyStore');

describe('setSessionEnabled', () => {
  let backup;

  beforeEach(() => {
    backup = fs.existsSync(CONFIG) ? fs.readFileSync(CONFIG, 'utf8') : null;
    fs.mkdirSync(path.dirname(CONFIG), { recursive: true });
    fs.writeFileSync(
      CONFIG,
      JSON.stringify(
        {
          version: 1,
          enabled: true,
          basePrompt: 'test',
          rules: [],
          enabledSessionIds: null,
          webhookIdsBySession: {}
        },
        null,
        2
      )
    );
  });

  afterEach(() => {
    if (backup !== null) fs.writeFileSync(CONFIG, backup);
    else if (fs.existsSync(CONFIG)) fs.unlinkSync(CONFIG);
  });

  it('materializa null y desactiva solo la línea pedida', () => {
    const result = store.setSessionEnabled('session2', false, [
      'session1',
      'session2',
      'session3'
    ]);
    assert.deepEqual(result.config.enabledSessionIds.sort(), [
      'session1',
      'session3'
    ]);
    assert.equal(result.sessionEnabled, false);
    assert.equal(store.isSessionEnabled('session1'), true);
    assert.equal(store.isSessionEnabled('session2'), false);
  });

  it('reactiva una línea en lista explícita', () => {
    store.setSessionEnabled('session2', false, ['session1', 'session2']);
    const result = store.setSessionEnabled('session2', true, [
      'session1',
      'session2'
    ]);
    assert.ok(result.config.enabledSessionIds.includes('session2'));
    assert.equal(result.sessionEnabled, true);
  });

  it('no modifica enabled/basePrompt', () => {
    const before = store.getConfig();
    store.setSessionEnabled('session1', false, ['session1', 'session2']);
    const after = store.getConfig();
    assert.equal(after.enabled, before.enabled);
    assert.equal(after.basePrompt, before.basePrompt);
  });
});
